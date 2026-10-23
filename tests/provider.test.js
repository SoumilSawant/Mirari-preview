import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';

const event=()=>({id:'show',title:'Test show',city:'London',status:'published',lat:51.5,lng:-.1,startAt:new Date(Date.now()+86400000).toISOString(),tiers:[{id:'ga',name:'GA',price:3500,capacity:2}]});
function setup(filename=':memory:'){
  const store=new Store(filename);
  if(!store.event('show'))store.saveEvent(event());
  return store;
}
function order(store,id='pi_1',session='cs_1'){
  const o=store.reserve({eventId:'show',name:'Ticket Guest',email:'guest@example.com',items:[{tierId:'ga',quantity:1}]});
  store.run('UPDATE orders SET stripe_session=? WHERE id=?',session,o.id);
  return o;
}
function paid(o,paymentId='pi_1',sessionId='cs_1',id='evt_paid'){
  return{id,type:'checkout.session.completed',orderId:o.id,clientReferenceId:o.id,sessionId,paymentId,
    amount:3500,currency:'gbp',paymentStatus:'paid',strict:true};
}

test('payment then refund and refund then payment both leave no valid ticket',()=>{
  for(const refundFirst of [false,true]){
    const s=setup(),o=order(s);
    const refund={id:'evt_refund',type:'charge.refunded',paymentId:'pi_1',fullyRefunded:true,amountRefunded:3500};
    if(refundFirst)s.ingestProviderEvent(refund);
    s.ingestProviderEvent(paid(o));
    if(!refundFirst)s.ingestProviderEvent(refund);
    assert.equal(s.order(o.id).status,'refunded');
    if(refundFirst)assert.equal(s.order(o.id).tickets.length,0);
    else assert.throws(()=>s.checkIn(s.order(o.id).tickets[0].token,'staff','show'),/not valid/);
    assert.equal(s.ingestProviderEvent(refund),'duplicate');
    s.db.close();
  }
});

test('session and order mismatch or reused payment never issue another ticket',()=>{
  const s=setup(),first=order(s,'pi_1','cs_1'),second=order(s,'pi_2','cs_2');
  s.ingestProviderEvent(paid(first,'pi_1','cs_wrong','evt_wrong'));
  assert.equal(s.order(first.id).status,'pending');
  s.ingestProviderEvent({...paid(first),clientReferenceId:second.id,id:'evt_wrong_order'});
  assert.equal(s.order(first.id).tickets.length,0);
  s.ingestProviderEvent(paid(first));
  s.ingestProviderEvent(paid(second,'pi_1','cs_2','evt_reuse'));
  assert.equal(s.order(first.id).tickets.length,1);
  assert.equal(s.order(second.id).tickets.length,0);
  s.db.close();
});

test('wrong amount and currency require review without valid admission',()=>{
  for(const change of [{amount:3499},{currency:'usd'}]){
    const s=setup(),o=order(s);
    s.ingestProviderEvent({...paid(o),...change,id:`evt_${Object.keys(change)[0]}`});
    assert.equal(s.order(o.id).status,'payment_review');
    assert.equal(s.order(o.id).tickets.length,0);
    assert.equal(s.get("SELECT kind FROM alerts WHERE kind='payment_review' AND subject=?",o.id).kind,'payment_review');
    s.db.close();
  }
});

test('expired and cancelled orders cannot admit tickets',()=>{
  const s=setup(),expired=order(s,'pi_1','cs_1');
  s.ingestProviderEvent({id:'evt_expire',type:'checkout.session.expired',sessionId:'cs_1'});
  assert.equal(s.order(expired.id).status,'expired');
  const cancelled=order(s,'pi_2','cs_2');s.ingestProviderEvent(paid(cancelled,'pi_2','cs_2','evt_paid_2'));
  const ticket=s.order(cancelled.id).tickets[0];
  s.saveEvent({...event(),status:'cancelled'});
  assert.throws(()=>s.checkIn(ticket.token,'staff','show'),/not valid/);
  s.db.close();
});

test('disputes and partial refunds block entry while retaining inventory',()=>{
  const s=setup(),o=order(s);s.ingestProviderEvent(paid(o));const ticket=s.order(o.id).tickets[0];
  s.ingestProviderEvent({id:'evt_dispute',type:'charge.dispute.created',paymentId:'pi_1',disputed:true});
  assert.equal(s.order(o.id).status,'disputed');assert.throws(()=>s.checkIn(ticket.token,'staff','show'),/not valid/);
  assert.equal(s.event('show').tiers[0].available,1);
  s.ingestProviderEvent({id:'evt_won',type:'charge.dispute.closed',paymentId:'pi_1',disputed:false});
  assert.equal(s.order(o.id).status,'paid');
  s.ingestProviderEvent({id:'evt_partial',type:'charge.refunded',paymentId:'pi_1',fullyRefunded:false,amountRefunded:1000});
  assert.equal(s.order(o.id).status,'payment_review');assert.throws(()=>s.checkIn(ticket.token,'staff','show'),/not valid/);
  assert.equal(s.event('show').tiers[0].available,1);s.db.close();
});

test('failed refund restores paid admission and creates an alert',()=>{
  const s=setup(),o=order(s);s.ingestProviderEvent(paid(o));
  s.run("UPDATE orders SET status='refunding' WHERE id=?",o.id);
  s.ingestProviderEvent({id:'evt_failed',type:'refund.failed',paymentId:'pi_1',refundStatus:'failed',refundId:'re_1'});
  assert.equal(s.order(o.id).status,'paid');assert.equal(s.get("SELECT kind FROM alerts WHERE subject=?",o.id).kind,'refund_failed');s.db.close();
});

test('migrated database keeps bookings and staged events through restart',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-migration-'));
  try{
    const filename=path.join(dir,'test.sqlite');let s=setup(filename),o=order(s);
    s.stageProviderEvent({id:'evt_early',type:'charge.refunded',data:{object:{payment_intent:'pi_1',refunded:true}}});
    s.ingestProviderEvent({id:'evt_early',type:'charge.refunded',paymentId:'pi_1',fullyRefunded:true});s.db.close();
    s=new Store(filename);assert.equal(s.get('PRAGMA user_version').user_version,4);
    assert.equal(s.order(o.id).status,'pending');s.ingestProviderEvent(paid(o));
    assert.equal(s.order(o.id).status,'refunded');assert.equal(s.order(o.id).tickets.length,0);s.db.close();
  }finally{
    assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep+'mirari-migration-'));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('an unprocessed signed event remains available for retry after restart',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-retry-'));
  try{
    const filename=path.join(dir,'retry.sqlite');let s=setup(filename),o=order(s);
    const event={id:'evt_retry',type:'charge.refunded',data:{object:{payment_intent:'pi_1',refunded:true,amount_refunded:3500}}};
    s.stageProviderEvent(event);s.db.close();
    s=new Store(filename);
    const pending=s.get("SELECT payload FROM provider_events WHERE id='evt_retry' AND result='received'");
    assert.equal(JSON.parse(pending.payload).id,event.id);
    s.ingestProviderEvent({id:event.id,type:event.type,paymentId:'pi_1',fullyRefunded:true,amountRefunded:3500});
    s.ingestProviderEvent(paid(o));
    assert.equal(s.order(o.id).status,'refunded');
    assert.equal(s.order(o.id).tickets.length,0);
    assert.equal(s.get("SELECT result FROM provider_events WHERE id='evt_retry'").result,'processed');
    s.db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
