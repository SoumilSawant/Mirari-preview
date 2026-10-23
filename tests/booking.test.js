import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
const event = (capacity=3) => ({
  id:'event',title:'Test night',city:'London',lat:51.5,lng:-.12,status:'published',startAt:new Date(Date.now()+86400000).toISOString(),image:'/assets/hero.webp',
  tiers:[{id:'ga',name:'Admission',price:3500,capacity}]
});
const request=(quantity=1)=>({eventId:'event',name:'Test Guest',email:'test@example.com',items:[{tierId:'ga',quantity}]});
function setup(capacity=3){const s=new Store();s.saveEvent(event(capacity));return s;}
test('expired unpaid hold restores availability and cannot oversell',()=>{
  const s=setup(1);const o=s.reserve(request(),Date.now()-32*60000);s.expire();
  assert.equal(s.order(o.id).status,'expired');assert.equal(s.event('event').tiers[0].available,1);
  s.reserve(request());assert.throws(()=>s.reserve(request()),/Not enough/);s.db.close();
});
test('provider-backed holds remain reserved until verified expiration',()=>{
  const s=setup(1);const o=s.reserve(request(),Date.now()-32*60000);
  s.run('UPDATE orders SET stripe_session=? WHERE id=?','cs_test',o.id);s.expire();
  assert.equal(s.order(o.id).status,'pending');assert.equal(s.event('event').tiers[0].available,0);s.db.close();
});
test('same and different duplicate webhooks issue one ticket and one email',()=>{
  const s=setup();const o=s.reserve(request(2));
  s.fulfil(o.id,{amount:7000,webhookId:'evt_1'});s.fulfil(o.id,{amount:7000,webhookId:'evt_1'});s.fulfil(o.id,{amount:7000,webhookId:'evt_2'});
  assert.equal(s.order(o.id).tickets.length,2);assert.equal(s.all('SELECT * FROM mail').length,1);s.db.close();
});
test('wrong amount enters payment review without tickets',()=>{
  const s=setup();const o=s.reserve(request());s.fulfil(o.id,{amount:100});
  assert.equal(s.order(o.id).status,'payment_review');assert.equal(s.order(o.id).tickets.length,0);s.db.close();
});
test('late successful payment never oversells after inventory has been reallocated',()=>{
  const s=setup(1);const late=s.reserve(request(),Date.now()-32*60000);s.expire();const second=s.reserve(request());
  s.fulfil(second.id,{amount:3500});s.fulfil(late.id,{amount:3500});
  assert.equal(s.order(late.id).status,'payment_review');assert.equal(s.all('SELECT * FROM tickets').length,1);s.db.close();
});
test('QR check-in rejects duplicate, invalid, wrong-event and refunded tickets',()=>{
  const s=setup();const o=s.reserve(request(2));const paid=s.fulfil(o.id,{amount:7000});
  assert.throws(()=>s.checkIn('not-valid','staff','event'),/Invalid/);
  assert.throws(()=>s.checkIn(paid.tickets[0].token,'staff','other'),/different event/);
  assert.equal(s.checkIn(paid.tickets[0].token,'staff','event').valid,true);
  assert.throws(()=>s.checkIn(paid.tickets[0].token,'staff','event'),/Already checked/);
  s.run("UPDATE orders SET status='refunded' WHERE id=?",o.id);
  assert.throws(()=>s.checkIn(paid.tickets[1].token,'staff','event'),/not valid/);s.db.close();
});
test('cancelled event prevents fulfilment and queues review',()=>{
  const s=setup();const o=s.reserve(request());s.saveEvent({...event(),status:'cancelled'});
  assert.equal(s.fulfil(o.id,{amount:3500}).status,'payment_review');s.db.close();
});
test('capacity cannot be lowered below reserved or paid tickets',()=>{
  const s=setup();s.reserve(request(2));assert.throws(()=>s.saveEvent(event(1)),/Capacity/);assert.equal(s.event('event').tiers[0].capacity,3);s.db.close();
});
test('sales windows and total quantity limits are enforced on the server',()=>{
  const s=setup(100);assert.throws(()=>s.reserve(request(9)),/between 1 and 8/);
  s.run('UPDATE tiers SET opens=? WHERE id=?',new Date(Date.now()+60000).toISOString(),'ga');
  assert.throws(()=>s.reserve(request()),/not on sale/);s.db.close();
});
test('concurrent database connections cannot reserve the same last seat',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-test-')),filename=path.join(dir,'test.sqlite'),s=new Store(filename);
  s.saveEvent(event(1));s.db.close();
  const moduleUrl=new URL('../lib/store.js',import.meta.url).href;
  const worker=()=>new Promise((resolve,reject)=>{
    const code=`const{parentPort,workerData}=require('node:worker_threads');(async()=>{const{Store}=await import(workerData.moduleUrl);const s=new Store(workerData.filename);try{s.reserve(workerData.input);parentPort.postMessage('reserved');}catch(e){parentPort.postMessage(e.message);}finally{s.db.close();}})();`;
    const w=new Worker(code,{eval:true,workerData:{filename,moduleUrl,input:request()}});let result;
    w.on('message',value=>{result=value;});w.on('exit',code=>code===0?resolve(result):reject(new Error(`Worker exited ${code}`)));w.on('error',reject);
  });
  const result=await Promise.all([worker(),worker(),worker()]);assert.equal(result.filter(r=>r==='reserved').length,1);
  assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep+'mirari-test-'));
  rmSync(dir,{recursive:true,force:true});
});
