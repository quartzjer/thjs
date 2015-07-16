var NodeCrypto = require("crypto");
var sjcl = require("sjcl");

exports.id = '2a';

// env-specific crypto methods
var forge;
var cecc;
exports.crypt = function(ecc,f)
{
  cecc = ecc;
  forge = f;
}
var rsa_alg = {
  name: "RSA-OAEP"
  , hash: {name: "SHA-256"}
  , modulusLength:2048
  , publicExponent : new Uint8Array([0x01,0x00,0x01])
};
exports._generate = function(){

  var usage = ["encrypt","decrypt"];
  var extractable = true;
  return crypto.subtle.generateKey(rsa_alg, extractable, usage)
        .then(function(pair){
          return Promise.all([
              crypto.subtle.exportKey("pkcs8",pair.privateKey)
              , crypto.subtle.exportKey("spki",pair.publicKey)
            ]);
        }).then(function(jwks){
          return {
            key: Bufferize(jwks[1])
            , secret : Bufferize(jwks[0])
          };
        });
}

function Bufferize(arraybuffer){
  return new Buffer(new Uint8Array(arraybuffer))
}
exports._loadkey = function(id, key, secret){
  var alg = {}
  function privateHandler(privates){
    console.log("privatehandler")
    var oaep = privates[0]
      , ssa  = privates[1];

    id.sign = function(buf){
      console.log("loadkey sign", ssa)
      return crypto.subtle.sign({name: "RSASSA-PKCS1-v1_5"}, ssa, buf)
                   .then(Bufferize).catch(function(e){console.log("sign err",e)});
    }
    id.decrypt = function(buf){
      console.log("loadkey decrypt", oaep, buf)
      return crypto.subtle.decrypt({name: "RSA-OAEP",hash:{name:"SHA-1"}}, oaep, buf)
                   .then(Bufferize).catch(function(e){console.log("decrypt err",e)});
    }
  }

  function publicHandler(publics){
    console.log("publichandler")
    var oaep = publics[0]
      , ssa  = publics[1];

    id.encrypt = function(buf){
      console.log("loadkey encrypt", oaep)
      return crypto.subtle.encrypt({name: "RSA-OAEP"}, oaep, buf)
                   .then(Bufferize).catch(function(e){console.log("encrypt err",e)});
    }
    id.verify = function(a,b){
      console.log("loadKey verify", ssa, a, b)
      return crypto.subtle.verify({name: "RSASSA-PKCS1-v1_5"}, ssa, b, a)
      .catch(function(e){
        console.log("verify err",e)
      })
    }
    return id;
  }
  console.log("secret", secret)
  //WOOOOOOOO!!!
  if (secret){
    var pkcsPad1  = new Buffer([48, 130])
    var off1 = new Buffer([Math.floor(secret.length / 256),((secret.length + 22) % 256) ])
    var pkcsPad2  = new Buffer([2, 1, 0, 48, 13, 6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1, 5, 0, 4, 130])
    var off2 = new Buffer([Math.floor(secret.length / 256), (secret.length % 256)])
    secret = Buffer.concat([pkcsPad1, off1, pkcsPad2, off2, secret])
    var importer = Promise.all([
                          crypto.subtle.importKey("pkcs8", secret, {name: "RSA-OAEP", hash: {name: "SHA-1"}}, false, ["decrypt"])
                          ,crypto.subtle.importKey("pkcs8", secret, {name: "RSASSA-PKCS1-v1_5", hash: {name: "SHA-256"}}, false, ["sign"])
                        ]).then(privateHandler)
  }
  else
    importer = Promise.resolve();

  return importer.then(function(){
    return Promise.all([
      crypto.subtle.importKey("spki", key, {name: "RSA-OAEP", hash: {name: "SHA-1"}}, false, ["encrypt"])
       ,crypto.subtle.importKey("spki", key, {name: "RSASSA-PKCS1-v1_5", hash: {name: "SHA-256"}}, false, ["verify"])
    ]);
  }).then(publicHandler)
}

exports.generate = function(cb)
{
  // disable web-workers for now, not browserify compatible
//  forge.rsa.generateKeyPair({bits: 2048, e: 0x10001, workers: -1}, function(err, keys){
  var keys = forge.rsa.generateKeyPair({bits: 2048, e: 0x10001});
  if(!keys) return cb("failed to generate rsa keys");
  var key = forge.asn1.toDer(forge.pki.publicKeyToAsn1(keys.publicKey)).bytes();
  var secret = forge.asn1.toDer(forge.pki.privateKeyToAsn1(keys.privateKey)).bytes();
  cb(null, {key:new Buffer(key, 'binary'), secret:new Buffer(secret, 'binary')});
}

exports.loadkey = function(id, key, secret)
{
  var pk = forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(key.toString("binary")));
  id.encrypt = function(buf){
    return new Buffer(pk.encrypt(buf.toString("binary"), "RSA-OAEP"), "binary");
  };
  id.verify = function(a,b){
    var md = forge.md.sha256.create();
    md.update(a.toString("binary"));
    var bytes = md.digest().bytes()
    return pk.verify(bytes, b.toString("binary"));
  };
  if(secret)
  {
    var sk = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(secret.toString("binary")));
    id.sign = function(buf){
      var md = forge.md.sha256.create();
      md.update(buf.toString("binary"));
      return new Buffer(sk.sign(md),"binary");
    };
    id.decrypt = function(buf){
      console.log("l")
      return new Buffer(sk.decrypt(buf.toString("binary"), "RSA-OAEP"),"binary");
    };
  }
  return undefined;
}

exports._Local = function(pair){
  if (!(pair && pair.key && pair.secret))
    return Promise.reject(new Error("must supply valid keypair"))
  var self = this;
  self.key = {};
  return exports._loadkey(self.key,pair.key,pair.secret)
         .then(function(key){
           self.key = key;
           console.log("_local loadkey")

           self.decrypt = function(body){
             console.log("buffer.isBuffer", Buffer.isBuffer(body), (body.length < 256+12+256+16))
             if(!Buffer.isBuffer(body)) return false;
             if(body.length < 256+12+256+16) return false;
             var b = body
             // rsa decrypt the keys
             return self.key.decrypt(b.slice(0,256))
                 .then(function(keys){
                   console.log("keys",keys.length)
                   if(!keys || keys.length != (65+32)) return false;
                   var body = b;
                   var alg = { name: "AES-GCM"
                    , tagLength: 128
                    , iv : body.slice(256,256+12)
                    , additionalData: body.slice(0,256)
                    };

                    console.log("decrypt keys")
                    return crypto.subtle.importKey("raw",keys.slice(65,65+32), {name: "AES-GCM"},false,["encrypt","decrypt"])
                          .then(function(key){
                            return crypto.subtle.decrypt(alg, key, body.slice(256+12))
                          })
                          .then(function(body){
                            console.log("decrypt", body)

                            var b = new Buffer(new Uint8Array(body))
                            console.log(b)
                            var ret = b.slice(0,b.length-256);
                            ret._keys = keys;
                            ret._sig = b.slice(ret.length);
                            return ret;
                          })
                 });

           };
           return self;
         });
  // decrypt message body and return the inner

}

exports.Local = function(pair)
{
  var self = this;
  self.key = {}
  try{
    self.err = exports.loadkey(self.key,pair.key,pair.secret);
  }catch(E){
    self.err = E;
  }

  // decrypt message body and return, the inner
  self.decrypt = function(body){
    if(!Buffer.isBuffer(body)) return false;
    if(body.length < 256+12+256+16) return false;

    // rsa decrypt the keys
    var keys = self.key.decrypt(body.slice(0,256));
    if(!keys || keys.length != (65+32)) return false;
    // aes decrypt the inner
    var keyhex = keys.slice(65,65+32).toString('hex');
    var ivhex = body.slice(256,256+12).toString('hex');
    var aadhex = body.slice(0,256).toString('hex');
    var cbodyhex = body.slice(256+12).toString('hex');

    var key = new sjcl.cipher.aes(sjcl.codec.hex.toBits(keyhex));

    var iv = sjcl.codec.hex.toBits(ivhex);
    var aad = sjcl.codec.hex.toBits(aadhex);
    var cbody = sjcl.codec.hex.toBits(cbodyhex);
    var cipher = sjcl.mode.gcm.decrypt(key, cbody, iv, aad, 128);
    var body = new Buffer(sjcl.codec.hex.fromBits(cipher), 'hex');

    // return buf of just the inner, add decrypted sig/keys
    var ret = body.slice(0,body.length-256);
    ret._keys = keys;
    ret._sig = body.slice(ret.length);

    return ret;
  };
}
exports._Remote = function(key)
{
  var self = this;
  self.key = {}
  console.log("EPHEMERAL", self.ephemeral)
  var alg = {
    name: "AES-GCM"
    , tagLength : 128
    , length : 256
    , iv : self.iv
  }
  var aesKey;
  //window.Buffer = Buffer;

  return crypto.subtle.generateKey(
    {
        name  : "ECDH",
        namedCurve: "P-256", //can be "P-256", "P-384", or "P-521"
    },
    true, //whether the key is extractable (i.e. can be used in exportKey)
    ["deriveKey", "deriveBits"] //can be any combination of "deriveKey" and "deriveBits"
  ).then(function(key){
    console.log('key',key)
    self.ephemeral = {
      PrivateKey  : key.privateKey
    };
    return crypto.subtle.exportKey("spki", key.publicKey)
  }).then(function(pub){

    var PublicKey = new Buffer(new Uint8Array(pub))
    PublicKey = PublicKey.slice(PublicKey.length - 65)
    self.ephemeral.PublicKey = PublicKey;
    return "subtle"
  })
  .catch(function(er){
    console.log("CECC", er)
    var curve = cecc.ECCurves.secp256r1
    curve.legacy = true;
    self.ephemeral = new cecc.ECKey(curve);
    return "JS"
  }).then(function(){

    self.secret = crypto.getRandomValues(new Buffer(32))
    self.iv = crypto.getRandomValues(new Buffer(12))
    return crypto.subtle.importKey("raw", self.secret,alg, false,["encrypt","decrypt"] )
  }).then(function(aeskey)
  // verifies the authenticity of an incoming message body
  {
      aesKey = aeskey
    return exports._loadkey(self.key,key)
  }).then(function(key){
    var keys = Buffer.concat([self.ephemeral.PublicKey,self.secret])
    console.log("EPHEMERAL + SECRET", keys.length)
     return self.key.encrypt(keys).then(function(keys){
       self.keys = new Buffer(new Uint8Array(keys));
       alg.additionalData = self.keys;
       self.token = NodeCrypto.createHash('sha256').update(self.keys.slice(0,16)).digest().slice(0,16);
       console.log("_Remote loadkey")

       self.verify = function(local, body){
         console.log(local,body,"VERIFY begin")
         if(!Buffer.isBuffer(body)) return false;

         // decrypt it first
         return local.decrypt(new Buffer(body))
              .then(function(inner){
                console.log("decrypted body",inner)
                if(!inner) return false;

                console.log(inner, inner._sig)

                // verify the rsa signature
                return key.verify(Buffer.concat([body.slice(0,256+12),inner]), inner._sig)
                          .then(function(verified){
                            console.log("verifieds?", verified)
                            if (verified)
                              self.cached = inner._keys;
                            return verified;
                          })
              });

       };

       self.encrypt = function(local, inner){
         if(!Buffer.isBuffer(inner)) return false;

         // increment the IV
         var seq = self.iv.readUInt32LE(0);
         seq++;
         self.iv.writeUInt32LE(seq,0);
         console.log('self.iv', self.iv)
         alg.iv = self.iv;

         // generate the signature
         return local.key.sign(Buffer.concat([self.keys,self.iv,inner]))
              .then(function(sig){

               // aes gcm encrypt the inner+sig
               var body = Buffer.concat([inner, new Buffer(new Uint8Array(sig))])
               return crypto.subtle.encrypt(alg,aesKey, body)
                 .then(function(crypted){
                   var cbody = new Buffer(new Uint8Array(crypted))

                     console.log("crypted", cbody)
                   return Buffer.concat([self.keys,self.iv,cbody]);
                 });
               // all done!

             });



       };
       return self;
     });
   });



}

exports.Remote = function(key)
{
  var self = this;
  self.key = {};
  try{
    self.err = exports.loadkey(self.key,key);
    var curve = cecc.ECCurves.secp256r1
    curve.legacy = true;
    self.ephemeral = new cecc.ECKey(curve);

    self.secret = NodeCrypto.randomBytes(32);
    self.iv = NodeCrypto.randomBytes(12);
    self.keys = self.key.encrypt(Buffer.concat([self.ephemeral.PublicKey,self.secret]));
    self.token = NodeCrypto.createHash('sha256').update(self.keys.slice(0,16)).digest().slice(0,16);
  }catch(E){
    self.err = E;
  }
  if(self.err) console.log("ERR",self.err,key.toString("hex"))

  // verifies the authenticity of an incoming message body
  self.verify = function(local, body){
    if(!Buffer.isBuffer(body)) return false;

    // decrypt it first
    var inner = local.decrypt(body);
    if(!inner) return false;

    // verify the rsa signature
    if(!self.key.verify(Buffer.concat([body.slice(0,256+12),inner]), inner._sig)) return false;

    // cache the decrypted keys
    self.cached = inner._keys;

    return true;
  };

  self.encrypt = function(local, inner){
    if(!Buffer.isBuffer(inner)) return false;

    // increment the IV
    var seq = self.iv.readUInt32LE(0);
    seq++;
    self.iv.writeUInt32LE(seq,0);

    // generate the signature
    var sig = local.key.sign(Buffer.concat([self.keys,self.iv,inner]));

    // aes gcm encrypt the inner+sig
    var aad = self.keys;
    var body = Buffer.concat([inner,sig]);
    var key = new sjcl.cipher.aes(sjcl.codec.hex.toBits(self.secret.toString('hex')));
    var iv = sjcl.codec.hex.toBits(self.iv.toString('hex'));
    var cipher = sjcl.mode.gcm.encrypt(key, sjcl.codec.hex.toBits(body.toString('hex')), iv, sjcl.codec.hex.toBits(aad.toString('hex')), 128);
    var cbody = new Buffer(sjcl.codec.hex.fromBits(cipher), 'hex');

    // all done!
    return Buffer.concat([self.keys,self.iv,cbody]);

  };

}

var ecc = {
  rawToSpki: function(){

  }
}

var spkiECCPad = new Buffer("3056301006042b81047006082a8648ce3d030107034200","hex")
exports._Ephemeral = function(remote, outer, inner){
  var self = this;
  var keys = remote.cached || (inner._keys);
  console.log(spkiECCPad,keys.slice(0,65));
  var ecdhe;

  var eccSPKI = Buffer.concat([spkiECCPad,keys.slice(0,65)])

  return crypto.subtle.importKey("spki", eccSPKI, {name:"ECDH",namedCurve:"P-256"},false,["deriveBits"])
        .then(function(key){
          console.log("PRIVATE KEY?", remote.ephemeral.PrivateKey)
          return crypto.subtle.deriveBits({name:"ECDH", namedCurve:"P-256", public: key}, remote.ephemeral.PrivateKey,256)
        })
        .then(function(bits){
          return new Buffer(new Uint8Array(bits))
        })
        .then(function(Ecdhe){
          ecdhe = Ecdhe;
          return crypto.subtle.digest({name:"SHA-256"}, Buffer.concat([ecdhe, remote.secret,keys.slice(65)]))
        })
        .then(function(hash){
          return crypto.subtle.importKey("raw",hash,{name:"AES-GCM"},false, ["encrypt"])
        })
        .then(function(encKey){
          self.encKey = encKey
          return true
        })
        .then(function(){
          return crypto.subtle.digest({name:"SHA-256"}, Buffer.concat([ecdhe, keys.slice(65),remote.secret]))
        })
        .then(function(hash){
          return crypto.subtle.importKey("raw",hash,{name:"AES-GCM"},false, ["decrypt"])
        })
        .then(function(decKey){
          self.decKey = decKey;
          return true;
        })
        .then(function(){

          self.token = NodeCrypto.createHash('sha256').update(outer.slice(0,16)).digest().slice(0,16);
          self.iv = NodeCrypto.randomBytes(12);

          self.decrypt = function(outer){
            return crypto.subtle.decrypt( { name: "AES-GCM", iv: outer.slice(0,12), additionalData: new Buffer(0), tagLength: 128}, self.decKey, outer.slice(12)) //The tagLength you used to encrypt
                     .then(function(buf){
                        return new Buffer(new Uint8Array(buf))
                      })

          };

          self.encrypt = function(inner){
            console.log("ENCRYPT INNER", inner)
            // increment the IV
            var seq = self.iv.readUInt32LE(0);
            seq++;
            self.iv.writeUInt32LE(seq,0);

            return crypto.subtle.encrypt({ name: "AES-GCM", iv: self.iv, additionalData: new Buffer(0), tagLength: 128}, self.encKey, inner)
                        .then(function(cbody){
                          return Buffer.concat([self.iv, new Buffer(new Uint8Array(cbody))])
                        })

          };
          return self;
        })


}

exports.Ephemeral = function(remote, outer, inner)
{
  var self = this;

  try {
    // get the ecc key from cached or decrypted
    var keys = remote.cached || (inner && inner._keys);

    // do the ecdh thing
    var curve = cecc.ECCurves.secp256r1
    curve.legacy = true;

    var ecc = new cecc.ECKey(curve, keys.slice(0,65), true);

    var ecdhe = remote.ephemeral.deriveSharedSecret(ecc);

console.log("ECDHE", ecdhe, ecdhe.toString("hex"))
    // use the other two secrets too
    var secret = keys.slice(65);
    var hex = NodeCrypto.createHash("sha256")
      .update(ecdhe)
      .update(remote.secret)
      .update(secret)
      .digest("hex");
    self.encKey = new sjcl.cipher.aes(sjcl.codec.hex.toBits(hex));
    var hex = NodeCrypto.createHash("sha256")
      .update(ecdhe)
      .update(secret)
      .update(remote.secret)
      .digest("hex");
    self.decKey = new sjcl.cipher.aes(sjcl.codec.hex.toBits(hex));

    self.token = NodeCrypto.createHash('sha256').update(outer.slice(0,16)).digest().slice(0,16);

    self.iv = NodeCrypto.randomBytes(12);

  }catch(E){
    self.err = E;
  }


  self.decrypt = function(outer){

    try{
      var ivhex = sjcl.codec.hex.toBits(outer.slice(0,12).toString("hex"));
      var cipher = sjcl.mode.gcm.decrypt(self.decKey, sjcl.codec.hex.toBits(outer.slice(12).toString("hex")), ivhex, [], 128);
      var inner = new Buffer(sjcl.codec.hex.fromBits(cipher),"hex");
    }catch(E){
      self.err = E;
    }

    return inner;
  };

  self.encrypt = function(inner){

    // increment the IV
    var seq = self.iv.readUInt32LE(0);
    seq++;
    self.iv.writeUInt32LE(seq,0);

    // now encrypt the packet
    var cipher = sjcl.mode.gcm.encrypt(self.encKey, sjcl.codec.hex.toBits(inner.toString("hex")), sjcl.codec.hex.toBits(self.iv.toString("hex")), [], 128);
    var cbody = new Buffer(sjcl.codec.hex.fromBits(cipher),"hex");

    return Buffer.concat([self.iv,cbody]);
  };
}