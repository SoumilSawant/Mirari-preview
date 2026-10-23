import test from 'node:test';
import assert from 'node:assert/strict';
import { backup, DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';

test('legacy database migrates without changing an existing order',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-legacy-'));
  try{
    const filename=path.join(dir,'legacy.sqlite'),legacy=new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY,event_id TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,status TEXT NOT NULL,total INTEGER NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL,access_hash TEXT NOT NULL,access_token TEXT NOT NULL,stripe_session TEXT UNIQUE,payment_id TEXT,marketing INTEGER NOT NULL DEFAULT 0,delivery TEXT NOT NULL DEFAULT 'pending');
      INSERT INTO orders VALUES('old','old-event','Existing Customer','existing@example.com','paid',3500,0,0,'hash','private-token',NULL,'pi_old',0,'sent');`);
    legacy.close();
    const migrated=new Store(filename);
    assert.equal(migrated.get('PRAGMA user_version').user_version,4);
    assert.equal(migrated.get("SELECT name FROM orders WHERE id='old'").name,'Existing Customer');
    assert.equal(migrated.get("SELECT payment_id FROM orders WHERE id='old'").payment_id,'pi_old');
    assert.equal(migrated.get("SELECT booking_mode FROM orders WHERE id='old'").booking_mode,'stripe-test');
    assert.equal(migrated.get("PRAGMA integrity_check").integrity_check,'ok');
    migrated.db.close();
  }finally{
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep+'mirari-legacy-'));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('online SQLite backup can be opened and restored with payment state intact',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-backup-'));
  try{
    const source=path.join(dir,'source.sqlite'),target=path.join(dir,'backup.sqlite');
    const store=new Store(source);
    store.run('INSERT INTO provider_state(payment_id,fully_refunded,disputed,refund_status,updated_at,amount_refunded) VALUES(?,?,?,?,?,?)','pi_backup',1,0,'succeeded',Date.now(),3500);
    await backup(store.db,target);
    store.db.close();
    const restored=new Store(target);
    assert.equal(restored.get('SELECT fully_refunded FROM provider_state WHERE payment_id=?','pi_backup').fully_refunded,1);
    assert.equal(restored.get('PRAGMA integrity_check').integrity_check,'ok');
    restored.db.close();
  }finally{
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep+'mirari-backup-'));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('version 1 payment and refund history migrates through version 4 without loss',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-v1-'));
  try{
    const filename=path.join(dir,'v1.sqlite'),db=new DatabaseSync(filename);
    db.exec(`CREATE TABLE orders (id TEXT PRIMARY KEY,event_id TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,status TEXT NOT NULL,total INTEGER NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL,access_hash TEXT NOT NULL,access_token TEXT NOT NULL,stripe_session TEXT UNIQUE,payment_id TEXT,marketing INTEGER NOT NULL DEFAULT 0,delivery TEXT NOT NULL DEFAULT 'pending',refund_id TEXT,refund_status TEXT,refund_request_key TEXT);
      CREATE TABLE provider_state (payment_id TEXT PRIMARY KEY,fully_refunded INTEGER NOT NULL DEFAULT 0,disputed INTEGER NOT NULL DEFAULT 0,refund_status TEXT,updated_at INTEGER NOT NULL,amount_refunded INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE mail (id TEXT PRIMARY KEY,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,error TEXT,order_id TEXT);
      INSERT INTO orders VALUES('old','event','Guest','g@example.com','refunding',3500,0,10,'h','private',NULL,'pi_old',0,'pending','re_old','pending','key_old');
      INSERT INTO mail VALUES('linked','g@example.com','Provider mail','body','pending',10,NULL,'old');
      INSERT INTO mail VALUES('unknown','g@example.com','Unlinked mail','body','pending',10,NULL,NULL);
      INSERT INTO provider_state VALUES('pi_old',0,0,'pending',10,0);
      PRAGMA user_version=1;`);db.close();
    const migrated=new Store(filename);
    assert.equal(migrated.get('PRAGMA user_version').user_version,4);
    assert.equal(migrated.get("SELECT status FROM orders WHERE id='old'").status,'refunding');
    assert.equal(migrated.get("SELECT provider_refund_id FROM refund_attempts WHERE payment_id='pi_old'").provider_refund_id,'re_old');
    assert.equal(migrated.get("SELECT booking_mode FROM orders WHERE id='old'").booking_mode,'stripe-test');
    assert.equal(migrated.get("SELECT origin_mode FROM mail WHERE id='linked'").origin_mode,'stripe-test');
    assert.equal(migrated.get("SELECT origin_mode FROM mail WHERE id='unknown'").origin_mode,'demo');
    assert.equal(migrated.get("SELECT verified_at FROM provider_state WHERE payment_id='pi_old'").verified_at,0);
    migrated.db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
