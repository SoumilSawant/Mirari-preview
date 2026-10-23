import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { verifyAdmissionPayment } from '../lib/payment-guard.js';
import { ensureCheckoutSession } from '../lib/checkout.js';

const event=()=>({id:'safe-show',title:'Safety show',city:'London',status:'published',lat:51.5,lng:-.1,startAt:new Date(Date.now()+86400000).toISOString(),tiers:[{id:'safe-ga',name:'GA',price:3500,capacity:3}]});
function setup(filename=':memory:'){
  const s=new Store(filename);if(!s.event('safe-show'))s.saveEvent(event());
  const o=s.reserve({eventId:'safe-show',name:'Guest',email:'guest@example.com',items:[{tierId:'safe-ga',quantity:1}]});
  return{s,o};
}
function paid(s,o,payment='pi_safe'){
  s.run('UPDATE orders SET stripe_session=? WHERE id=?',`cs_${payment}`,o.id);
  s.ingestProviderEvent({id:`evt_${payment}`,type:'checkout.session.completed',orderId:o.id,clientReferenceId:o.id,sessionId:`cs_${payment}`,paymentId:payment,amount:3500,currency:'gbp',paymentStatus:'paid',strict:true});
}
const snapshot=(refunds=[],disputes=[])=>({intent:{status:'succeeded',amount_received:3500,currency:'gbp'},refunds,disputes});

test('queued ticket mail is held during a refund and superseded after a successful refund',()=>{
  const s=new Store(':memory:',{mode:'stripe-test'});
  s.saveEvent(event());
  const o=s.reserve({eventId:'safe-show',name:'Guest',email:'guest@example.com',items:[{tierId:'safe-ga',quantity:1}]});
  paid(s,o,'pi_mail_safety');
  const ticketMail=s.get("SELECT id FROM mail WHERE order_id=? AND subject LIKE 'Your Mirari tickets · %'",o.id);
  assert.ok(s.pendingDeliverableMail().some(m=>m.id===ticketMail.id));
  s.applyProviderSnapshot('pi_mail_safety',snapshot([{id:'re_mail',amount:3500,status:'pending'}]));
  assert.ok(!s.pendingDeliverableMail().some(m=>m.id===ticketMail.id));
  s.applyProviderSnapshot('pi_mail_safety',snapshot([{id:'re_mail',amount:3500,status:'succeeded'}]));
  s.supersedeStaleMail();
  assert.equal(s.get('SELECT status FROM mail WHERE id=?',ticketMail.id).status,'superseded');
  assert.ok(s.pendingDeliverableMail().some(m=>m.subject.startsWith('Refund confirmed · ')));
  s.applyProviderSnapshot('pi_mail_safety',snapshot([{id:'re_mail',amount:3500,status:'failed'}]));
  s.supersedeStaleMail();
  assert.ok(!s.pendingDeliverableMail().some(m=>m.subject.startsWith('Refund confirmed · ')));
  assert.ok(s.pendingDeliverableMail().some(m=>m.subject.startsWith('Important update about your Mirari refund · ')));
  s.db.close();
});

test('bound pending Checkout is reconciled before expiry and fairly retried after restart',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-checkout-reconcile-'));
  try{
    const filename=path.join(dir,'test.sqlite');
    const s=new Store(filename,{mode:'stripe-test'});
    s.saveEvent(event());
    const first=s.reserve({eventId:'safe-show',name:'Guest',email:'guest@example.com',items:[{tierId:'safe-ga',quantity:1}]});
    const second=s.reserve({eventId:'safe-show',name:'Guest',email:'guest@example.com',items:[{tierId:'safe-ga',quantity:1}]});
    s.run('UPDATE orders SET stripe_session=? WHERE id=?','cs_first',first.id);
    s.run('UPDATE orders SET stripe_session=? WHERE id=?','cs_second',second.id);
    assert.ok(s.order(first.id).expires>Date.now());
    assert.equal(s.pendingCheckoutReconciliation(1)[0].id,first.id);
    s.markReconcile('checkout',first.id);
    assert.equal(s.pendingCheckoutReconciliation(1)[0].id,second.id);
    s.db.close();
    const restarted=new Store(filename,{mode:'stripe-test'});
    assert.equal(restarted.pendingCheckoutReconciliation(1)[0].id,second.id);
    assert.deepEqual(new Set(restarted.pendingCheckoutReconciliation(2,Date.now()+61000).map(o=>o.id)),new Set([first.id,second.id]));
    restarted.db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a later failed refund corrects an earlier success and alerts the organiser',()=>{
  const{s,o}=setup();paid(s,o);
  const ticket=s.order(o.id).tickets[0];
  s.applyProviderSnapshot('pi_safe',snapshot([{id:'re_late',amount:3500,status:'succeeded',metadata:{}}]));
  assert.equal(s.order(o.id).status,'refunded');assert.throws(()=>s.checkIn(ticket.token,'staff','safe-show'),/not valid/);
  assert.equal(s.get("SELECT status FROM mail WHERE order_id=? AND subject LIKE 'Refund confirmed%'",o.id).status,'pending');
  s.applyProviderSnapshot('pi_safe',snapshot([{id:'re_late',amount:3500,status:'failed',metadata:{}}]));
  assert.equal(s.order(o.id).status,'paid');assert.equal(s.get("SELECT status FROM refund_attempts WHERE provider_refund_id='re_late'").status,'failed');
  assert.equal(s.get("SELECT kind FROM alerts WHERE kind='refund_failed' AND subject=?",o.id).kind,'refund_failed');
  assert.equal(s.get("SELECT status FROM mail WHERE order_id=? AND subject LIKE 'Refund confirmed%'",o.id).status,'superseded');
  assert.ok(s.get("SELECT 1 FROM mail WHERE subject LIKE 'Important update%' AND order_id=?",o.id));s.db.close();
});

test('refunded orders remain eligible for fair reconciliation after restart',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-refunded-reconcile-'));
  try{
    const filename=path.join(dir,'test.sqlite');
    const s=new Store(filename,{mode:'stripe-test'});s.saveEvent(event());
    const first=s.reserve({eventId:'safe-show',name:'Guest',email:'guest@example.com',items:[{tierId:'safe-ga',quantity:1}]});
    const second=s.reserve({eventId:'safe-show',name:'Guest',email:'guest@example.com',items:[{tierId:'safe-ga',quantity:1}]});
    paid(s,first,'pi_first');paid(s,second,'pi_second');
    s.applyProviderSnapshot('pi_first',snapshot([{id:'re_first',amount:3500,status:'succeeded',metadata:{}}]));
    s.applyProviderSnapshot('pi_second',snapshot([{id:'re_second',amount:3500,status:'succeeded',metadata:{}}]));
    s.db.close();
    const restarted=new Store(filename,{mode:'stripe-test'});
    assert.equal(restarted.paymentReconciliationCandidates(1)[0].id,first.id);
    restarted.markReconcile('payment',first.id);
    assert.equal(restarted.paymentReconciliationCandidates(1)[0].id,second.id);
    restarted.db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('multiple partial refunds and unresolved disputes block admission',()=>{
  const{s,o}=setup();paid(s,o);const ticket=s.order(o.id).tickets[0];
  s.applyProviderSnapshot('pi_safe',snapshot([{id:'re_1',amount:1000,status:'succeeded',metadata:{}}]));
  assert.equal(s.order(o.id).status,'payment_review');assert.throws(()=>s.checkIn(ticket.token,'staff','safe-show'),/not valid/);
  s.applyProviderSnapshot('pi_safe',snapshot([{id:'re_1',amount:1000,status:'succeeded',metadata:{}},{id:'re_2',amount:2500,status:'pending',metadata:{}}]));
  assert.equal(s.order(o.id).status,'refunding');
  s.applyProviderSnapshot('pi_safe',snapshot([{id:'re_1',amount:1000,status:'succeeded',metadata:{}},{id:'re_2',amount:2500,status:'succeeded',metadata:{}}]));
  assert.equal(s.order(o.id).status,'refunded');
  s.applyProviderSnapshot('pi_safe',snapshot([],[{id:'du_1',status:'needs_response'}]));
  assert.equal(s.order(o.id).status,'disputed');assert.throws(()=>s.checkIn(ticket.token,'staff','safe-show'),/not valid/);s.db.close();
});

test('a pending refund received before payment prevents ticket creation',()=>{
  const{s,o}=setup();
  s.applyProviderSnapshot('pi_safe',snapshot([{id:'re_early',amount:3500,status:'pending',metadata:{}}]));
  paid(s,o);
  assert.equal(s.order(o.id).status,'refunding');assert.equal(s.order(o.id).tickets.length,0);
  s.db.close();
});

test('contradictory Charge and refund history blocks admission',()=>{
  const{s,o}=setup();paid(s,o);
  const ticket=s.order(o.id).tickets[0];
  s.applyProviderSnapshot('pi_safe',{...snapshot(),charge:{refunded:true,amount_refunded:3500,disputed:false}});
  assert.equal(s.order(o.id).status,'payment_review');
  assert.throws(()=>s.checkIn(ticket.token,'staff','safe-show'),/not valid/);
  assert.equal(s.get("SELECT kind FROM alerts WHERE kind='provider_refund_mismatch' AND subject=?",o.id).kind,'provider_refund_mismatch');
  s.applyProviderSnapshot('pi_safe',{...snapshot([{id:'re_resolved',amount:3500,status:'succeeded',metadata:{}}]),charge:{refunded:true,amount_refunded:3500,disputed:false}});
  assert.equal(s.get("SELECT status FROM alerts WHERE kind='provider_refund_mismatch' AND subject=?",o.id).status,'resolved');
  s.db.close();
});

test('a pending full refund does not create a false Charge mismatch alert',()=>{
  const{s,o}=setup();paid(s,o);
  s.applyProviderSnapshot('pi_safe',{...snapshot([{id:'re_pending',amount:3500,status:'pending',metadata:{}}]),charge:{refunded:true,amount_refunded:3500,disputed:false}});
  assert.equal(s.order(o.id).status,'refunding');
  assert.equal(s.get("SELECT 1 FROM alerts WHERE kind='provider_refund_mismatch' AND subject=?",o.id),undefined);
  s.db.close();
});

test('refund claims share one stable key across connections and restart',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-refund-'));
  try{
    const filename=path.join(dir,'test.sqlite'),{s,o}=setup(filename);paid(s,o);
    const other=new Store(filename),first=s.claimRefund(o.id,'admin'),second=other.claimRefund(o.id,'admin');
    assert.equal(first.id,second.id);assert.equal(first.idempotency_key,second.idempotency_key);
    s.markRefundUnknown(first.id);other.db.close();s.db.close();
    const restarted=new Store(filename);assert.equal(restarted.claimRefund(o.id,'admin').id,first.id);
    restarted.applyProviderSnapshot('pi_safe',snapshot([{id:'re_attempt',amount:3500,status:'failed',metadata:{mirariAttemptId:first.id}}]));
    const retry=restarted.claimRefund(o.id,'admin');assert.notEqual(retry.id,first.id);
    restarted.db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('concurrent refund sends and lost responses reuse one provider operation',async()=>{
  const{s,o}=setup();paid(s,o);
  const attempts=[s.claimRefund(o.id,'admin'),s.claimRefund(o.id,'admin')];
  const operations=new Map();let sends=0;
  const send=async attempt=>{
    sends++;
    if(!operations.has(attempt.idempotency_key))operations.set(attempt.idempotency_key,{id:'re_single',amount:attempt.amount,status:'pending',metadata:{mirariAttemptId:attempt.id}});
    if(sends===1)throw Error('response lost');
    return operations.get(attempt.idempotency_key);
  };
  await assert.rejects(send(attempts[0]),/response lost/);
  s.markRefundUnknown(attempts[0].id);
  assert.equal((await send(attempts[1])).id,'re_single');
  s.applyProviderSnapshot('pi_safe',snapshot([...operations.values()]));
  assert.equal(operations.size,1);assert.equal(s.order(o.id).status,'refunding');s.db.close();
});

test('Checkout attempt survives restart and rejects a mismatched Session',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mirari-checkout-'));
  try{
    const filename=path.join(dir,'test.sqlite'),{s,o}=setup(filename),attempt=s.checkoutAttempt(o.id);s.db.close();
    const restarted=new Store(filename);assert.equal(restarted.checkoutAttempt(o.id).idempotency_key,attempt.idempotency_key);
    const session={id:'cs_safe',client_reference_id:o.id,metadata:{orderId:o.id},currency:'gbp',amount_total:3500,mode:'payment'};
    assert.throws(()=>restarted.bindCheckout(o.id,{...session,amount_total:3499}),/verified/);
    assert.equal(restarted.get('SELECT stripe_session FROM orders WHERE id=?',o.id).stripe_session,null);
    restarted.bindCheckout(o.id,session);assert.equal(restarted.order(o.id).stripe_session,'cs_safe');
    assert.throws(()=>restarted.bindCheckout(o.id,{...session,id:'cs_other'}),/different/);restarted.db.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Checkout recovers from a lost API response and a failed local binding write',async()=>{
  const{s,o}=setup(),attempt=s.checkoutAttempt(o.id),sessions=new Map();let calls=0;
  const stripe={checkout:{sessions:{
    create:async(input,options)=>{
      calls++;let session=sessions.get(options.idempotencyKey);
      if(!session){session={id:'cs_recovered',client_reference_id:input.client_reference_id,metadata:input.metadata,currency:'gbp',amount_total:3500,mode:'payment',status:'open',url:'https://checkout.stripe.test/session'};sessions.set(options.idempotencyKey,session);}
      if(calls===1)throw Error('response lost after creation');
      return session;
    },retrieve:async id=>[...sessions.values()].find(s=>s.id===id)
  }}};
  const appUrl='https://mirari.example';
  await assert.rejects(ensureCheckoutSession(s,stripe,s.order(o.id),attempt,appUrl),/response lost/);
  assert.equal(s.get('SELECT stripe_session FROM orders WHERE id=?',o.id).stripe_session,null);
  const original=s.bindCheckout.bind(s);let failWrite=true;
  s.bindCheckout=(...args)=>{if(failWrite){failWrite=false;throw Error('local write failed');}return original(...args);};
  await assert.rejects(ensureCheckoutSession(s,stripe,s.order(o.id),attempt,appUrl),/local write failed/);
  assert.equal(s.get('SELECT stripe_session FROM orders WHERE id=?',o.id).stripe_session,null);
  const recovered=await ensureCheckoutSession(s,stripe,s.order(o.id),attempt,appUrl);
  assert.equal(recovered.id,'cs_recovered');assert.equal(s.order(o.id).stripe_session,recovered.id);
  assert.equal(sessions.size,1);assert.equal(calls,3);s.db.close();
});

test('stale admission fails closed on provider outage and refreshes against external refund',async()=>{
  const{s,o}=setup();paid(s,o);const ticket=s.order(o.id).tickets[0];
  await assert.rejects(verifyAdmissionPayment(s,s.order(o.id),async()=>{throw Error('offline');},0),/unavailable/);
  assert.equal(s.get("SELECT kind FROM alerts WHERE kind='admission_provider_unavailable' AND subject=?",o.id).kind,'admission_provider_unavailable');
  await assert.rejects(verifyAdmissionPayment(s,s.order(o.id),async()=>snapshot([{id:'re_external',amount:3500,status:'succeeded',metadata:{}}]),0),/not valid/);
  assert.throws(()=>s.checkIn(ticket.token,'staff','safe-show'),/not valid/);s.db.close();
});

test('zero freshness verifies each scan while an explicit short cache can skip a repeat check',async()=>{
  const{s,o}=setup();paid(s,o);let calls=0;
  const fetch=async()=>{calls++;return snapshot();};
  await verifyAdmissionPayment(s,s.order(o.id),fetch,0);
  await verifyAdmissionPayment(s,s.order(o.id),fetch,0);
  assert.equal(calls,2);
  await verifyAdmissionPayment(s,s.order(o.id),fetch,3000);
  assert.equal(calls,2);s.db.close();
});
