import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { derivePassword, generateTotpSecret, verifyTotp } from '../lib/auth.js';

test('password derivation is asynchronous and TOTP validates only the intended time window',async()=>{
  const salt=Buffer.alloc(16,7);
  const derived=derivePassword('strong-password-for-test',salt,64);
  assert.equal(typeof derived.then,'function');
  assert.equal((await derived).length,64);
  const secret=generateTotpSecret();
  assert.match(secret,/^[A-Z2-7]{32}$/);
  const key=Buffer.from('12345678901234567890');
  const count=1;const message=Buffer.alloc(8);message.writeBigUInt64BE(BigInt(count));
  const digest=createHmac('sha1',key).update(message).digest(),offset=digest.at(-1)&15;
  const code=String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
  assert.equal(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',code,59000),count);
  assert.equal(verifyTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',code,180000),null);
});

test('rate limits are isolated by client bucket and survive a store restart',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-limit-'));
  try{
    const filename=path.join(dir,'limit.sqlite');let s=new Store(filename);
    assert.equal(s.rateLimit('login:client-A',2,1000),true);
    assert.equal(s.rateLimit('login:client-A',2,1000),true);
    s.db.close();s=new Store(filename);
    assert.equal(s.rateLimit('login:client-A',2,1000),false);
    assert.equal(s.rateLimit('login:client-B',2,1000),true);
    assert.equal(s.rateLimit('login:client-A',2,62000),true);
    s.db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
