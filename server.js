import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import QRCode from 'qrcode';
import Stripe from 'stripe';
import sharp from 'sharp';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, token, hash, fail } from './lib/store.js';
import { seed } from './lib/seed.js';
import { derivePassword, verifyTotp } from './lib/auth.js';
import { verifyAdmissionPayment } from './lib/payment-guard.js';
import { ensureCheckoutSession as ensureCheckout } from './lib/checkout.js';
import { resolveAppMode } from './lib/mode.js';
const root=path.dirname(fileURLToPath(import.meta.url)),port=Number(process.env.PORT||4173);
const production=process.env.NODE_ENV==='production';
const mode=resolveAppMode();
const demo=mode==='demo';
const appUrl=process.env.APP_URL||`http://127.0.0.1:${port}`;
const dbPath=path.resolve(root,process.env.DATABASE_PATH||'data/mirari.sqlite');
mkdirSync(path.dirname(dbPath),{recursive:true});mkdirSync(path.join(root,'assets/uploads'),{recursive:true});
if(process.env.STRIPE_SECRET_KEY&&!process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) throw new Error('Only Stripe sk_test_ keys are permitted. Live payments are disabled.');
if(!demo&&(!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')||!process.env.STRIPE_WEBHOOK_SECRET))throw new Error('Stripe test mode requires STRIPE_SECRET_KEY=sk_test_... and STRIPE_WEBHOOK_SECRET.');
if(production&&(!process.env.ADMIN_PASSWORD||!process.env.ADMIN_EMAIL||!process.env.ADMIN_TOTP_SECRET||!process.env.TRUSTED_PROXY_CIDRS||!appUrl.startsWith('https://')||!demo&&(!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM))) throw new Error('Production requires admin credentials and MFA, a trusted proxy, HTTPS APP_URL, and email delivery in Stripe test mode.');
const store=new Store(dbPath,{mode});if(demo) seed(store);else store.supersedeStaleMail();
const stripe=process.env.STRIPE_SECRET_KEY?new Stripe(process.env.STRIPE_SECRET_KEY):null;
let adminEmail=process.env.ADMIN_EMAIL||'admin@mirari.local',adminPassword=process.env.ADMIN_PASSWORD;
if(!adminPassword){
  const file=path.join(root,'.local-admin.txt');
  if(existsSync(file)){const c=JSON.parse(readFileSync(file,'utf8'));adminEmail=c.email;adminPassword=c.password;}
  else{adminPassword=token();writeFileSync(file,JSON.stringify({email:adminEmail,password:adminPassword},null,2),{mode:0o600});}
}
if(adminPassword.length<12)throw new Error('ADMIN_PASSWORD must have at least 12 characters.');
const salt=randomBytes(16),adminHash=await derivePassword(adminPassword,salt,64);adminPassword=undefined;
if(process.env.ADMIN_TOTP_SECRET&&!/^[A-Z2-7]{32,}$/i.test(process.env.ADMIN_TOTP_SECRET.replace(/\s|=/g,'')))throw new Error('ADMIN_TOTP_SECRET must be a Base32 authenticator secret.');
const app=express();app.disable('x-powered-by');
if(process.env.TRUSTED_PROXY_CIDRS)app.set('trust proxy',process.env.TRUSTED_PROXY_CIDRS.split(',').map(s=>s.trim()).filter(Boolean));
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'","data:"],fontSrc:["'self'"],connectSrc:["'self'"],mediaSrc:["'self'","blob:"],objectSrc:["'none'"],frameAncestors:["'none'"],upgradeInsecureRequests:production?[]:null}},crossOriginEmbedderPolicy:false,strictTransportSecurity:production?undefined:false,referrerPolicy:{policy:'no-referrer'}}));
app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
const limited=(max=20)=>{
  return(req,res,next)=>{
    const bucket=hash(`${req.route?.path||req.path}:${req.ip||'unknown'}`);
    if(!store.rateLimit(bucket,max))return res.status(429).json({error:'Please wait a minute before trying again.'});next();
  };
};
const stripeEventTypes=new Set(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','charge.refunded','refund.created','refund.updated','refund.failed','charge.dispute.created','charge.dispute.closed']);
async function providerPaymentState(paymentId){
  if(!paymentId)return{};
  const intent=await stripe.paymentIntents.retrieve(paymentId,{expand:['latest_charge']});
  const charge=typeof intent.latest_charge==='string'?await stripe.charges.retrieve(intent.latest_charge):intent.latest_charge;
  const [refunds,disputes]=await Promise.all([
    stripe.refunds.list({payment_intent:paymentId,limit:100}).autoPagingToArray({limit:1000}),
    stripe.disputes.list({payment_intent:paymentId,limit:100}).autoPagingToArray({limit:1000})
  ]);
  if(refunds.length>=1000||disputes.length>=1000)throw new Error('Provider history exceeds reconciliation limit.');
  return{intent,charge,refunds,disputes};
}
function applyStripeState(paymentId,state){store.applyProviderSnapshot(paymentId,state);}
async function processStripeEvent(e){
  if(!stripeEventTypes.has(e.type))return 'ignored';
  if(!demo&&e.livemode!==false)throw new Error('Expected a Stripe test-mode event.');
  const object=e.data?.object||{};
  if(e.type.startsWith('checkout.session.')){
    const s=demo?object:await stripe.checkout.sessions.retrieve(object.id);
    const paymentId=typeof s.payment_intent==='string'?s.payment_intent:s.payment_intent?.id;
    const state=!demo&&paymentId?await providerPaymentState(paymentId):{};
    if(!demo&&paymentId)applyStripeState(paymentId,state);
    if(!demo&&s.metadata?.orderId&&store.get('SELECT 1 FROM checkout_attempts WHERE order_id=?',s.metadata.orderId)){
      try{store.bindCheckout(s.metadata.orderId,s);}catch{store.alert('checkout_binding',s.metadata.orderId,'Stripe Checkout could not be bound to its reservation. Investigate urgently.');}
    }
    const paid=s.payment_status==='paid'&&(demo||(s.mode==='payment'&&s.status==='complete'))&&(!state.intent||(state.intent.status==='succeeded'&&state.intent.amount_received===s.amount_total&&state.intent.currency===s.currency));
    if(!demo&&s.payment_status==='paid'&&!paid)store.alert('payment_unverified',s.metadata?.orderId||s.id,'Stripe reports payment, but its amount, currency or intent status could not be verified. Investigate before fulfilment.');
    const canonicalType=!demo&&s.payment_status==='paid'?'checkout.session.completed':!demo&&s.status==='expired'?'checkout.session.expired':e.type;
    if(!demo&&e.type==='checkout.session.expired'&&s.status!=='expired'&&s.payment_status!=='paid'){
      store.run("UPDATE provider_events SET result='processed' WHERE id=?",e.id);return 'stale';
    }
    return store.ingestProviderEvent({id:e.id,type:canonicalType,sessionId:s.id||null,orderId:s.metadata?.orderId||null,
      clientReferenceId:s.client_reference_id||null,paymentId:paymentId||null,amount:s.amount_total,currency:s.currency,
      paymentStatus:paid?'paid':'unverified',strict:!demo});
  }
  let paymentId=typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id;
  if(!demo&&!paymentId&&e.type.startsWith('refund.')&&object.id){const refund=await stripe.refunds.retrieve(object.id);paymentId=typeof refund.payment_intent==='string'?refund.payment_intent:refund.payment_intent?.id;}
  if(!paymentId)store.alert('unmatched_provider_event',e.id,'A refund or dispute event had no payment intent. Investigate it in Stripe.');
  const state=!demo&&paymentId?await providerPaymentState(paymentId):{};
  if(!demo&&paymentId)applyStripeState(paymentId,state);
  return store.ingestProviderEvent({id:e.id,type:e.type,paymentId:paymentId||null,
    fullyRefunded:demo&&e.type==='charge.refunded'?Boolean(object.refunded):undefined,
    amountRefunded:demo&&e.type==='charge.refunded'?object.amount_refunded:undefined,
    disputed:demo&&e.type.startsWith('charge.dispute.')?(e.type==='charge.dispute.created'):undefined,
    refundStatus:demo&&e.type.startsWith('refund.')?object.status||null:null,refundAmount:demo&&e.type.startsWith('refund.')?object.amount:null,
    refundId:demo&&e.type.startsWith('refund.')?object.id:null});
}
app.post('/api/stripe/webhook',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
  if(!stripe||!process.env.STRIPE_WEBHOOK_SECRET)return res.status(503).json({error:'Payments are not configured.'});
  let e;try{e=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);}catch{return res.status(400).json({error:'Invalid webhook signature.'});}
  if(!stripeEventTypes.has(e.type))return res.json({received:true});
  store.stageProviderEvent(e);
  try{await processStripeEvent(e);res.json({received:true});}
  catch(error){store.alert('webhook_processing',e.id,'A signed provider event could not be processed. It will be retried.');console.error('Webhook processing failed',e.id,error.type||error.name);res.status(503).json({error:'Provider event processing will be retried.'});}
});
app.use(express.json({limit:'100kb'}));
app.use('/api',(req,res,next)=>{
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin!==new URL(appUrl).origin)return res.status(403).json({error:'Request origin is not allowed.'});next();
});
const cookie=(req,name)=>(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${name}=`))?.slice(name.length+1);
function auth(req,res,next){const s=store.get('SELECT * FROM sessions WHERE hash=? AND expires>?',hash(cookie(req,'mirari_admin')||''),Date.now());if(!s)return res.status(401).json({error:'Please sign in to the organiser area.'});req.actor=s.email;next();}
function privateOrder(req){const o=store.order(req.params.id),key=req.headers['x-order-token'];if(!o||typeof key!=='string'||hash(key)!==o.access_hash)fail('Order not found or private link is invalid.',404);return o;}
function publicOrder(o){const{access_hash,access_token,payment_id,stripe_session,refund_id,refund_request_key,...safe}=o;return safe;}
app.get('/api/config',(_req,res)=>res.json({mode,demo,paymentsReady:demo||Boolean(stripe&&process.env.STRIPE_WEBHOOK_SECRET),emailReady:!demo&&Boolean(process.env.RESEND_API_KEY&&process.env.EMAIL_FROM),mfaRequired:Boolean(process.env.ADMIN_TOTP_SECRET)}));
app.get('/api/health',(_req,res)=>{store.get('SELECT 1');res.json({status:'ok',mode});});
app.get('/api/ready',(_req,res)=>{store.get('SELECT 1');const ready=demo||Boolean(stripe&&process.env.STRIPE_WEBHOOK_SECRET&&process.env.RESEND_API_KEY&&process.env.EMAIL_FROM);res.status(ready?200:503).json({ready,mode});});
app.get('/api/events',(_req,res)=>res.json(store.events(false,demo)));
app.get('/api/events/:id',(req,res)=>{store.expire();const e=store.event(req.params.id);if(!e||e.status==='draft')fail('Event not found.',404);res.json(e);});
app.get('/api/policies/:key',(req,res)=>{
  if(!['terms','refunds','privacy','cookies','accessibility','contact'].includes(req.params.key))fail('Page not found.',404);
  res.json({title:req.params.key,body:store.setting(`policy.${req.params.key}`),contact:store.setting('policy.contact')});
});
async function ensureCheckoutSession(order, attempt){
  return ensureCheckout(store,stripe,order,attempt,appUrl,process.env.STRIPE_PAYMENT_METHODS||'card');
}
app.post('/api/reservations',limited(),async(req,res)=>{
  const event=store.event(req.body.eventId);
  if(!demo&&(!stripe||!process.env.STRIPE_WEBHOOK_SECRET))fail('Booking is not yet configured. Please contact Mirari.',503);
  if(!demo&&event?.demo)fail('Demonstration events cannot be purchased.',409);
  if(!demo&&['terms','refunds','privacy','contact'].some(k=>!store.setting(`policy.${k}`).trim()))fail('Booking will open after the organiser publishes its customer policies.',503);
  if(req.body.acceptedTerms!==true)fail('Please accept the event and booking terms.');
  const o=store.reserve(req.body);
  if(demo)return res.json({id:o.id,key:o.access_token,url:`/order/${o.id}#key=${o.access_token}`});
  const attempt=store.checkoutAttempt(o.id);
  try{
    const session=await ensureCheckoutSession(o,attempt);if(!session.url)fail('Checkout is no longer open.',409);
    res.json({id:o.id,key:o.access_token,url:session.url});
  }catch(error){store.audit('stripe','checkout.error',o.id,error.type||'connection-error');store.alert('checkout_attempt',o.id,'Checkout creation or binding is uncertain. Reconcile Stripe before releasing this reservation.');fail('Checkout could not be opened. Please contact Mirari if you were charged.',502);}
});
app.get('/api/orders/:id',(req,res)=>{store.expire();res.json(publicOrder(privateOrder(req)));});
app.get('/api/orders/:id/tickets/:ticket/qr',async(req,res)=>{const o=privateOrder(req),t=o.tickets.find(t=>t.id===req.params.ticket);if(!t)fail('Ticket not found.',404);res.json({dataUrl:await QRCode.toDataURL(t.token,{width:320,margin:3,errorCorrectionLevel:'M'})});});
app.post('/api/orders/:id/demo-pay',limited(),(req,res)=>{
  if(!demo)fail('Demo checkout is disabled.',403);store.expire();const o=privateOrder(req);if(o.booking_mode!=='demo'||o.status!=='pending')fail('This reservation is no longer awaiting demo payment.',409);
  res.json(publicOrder(store.fulfil(o.id,{amount:o.total,webhookId:`demo-${o.id}`})));
});
app.post('/api/orders/:id/cancel',async(req,res)=>{
  const o=privateOrder(req);if(o.status!=='pending')fail('Only an unpaid reservation can be released.',409);
  if(o.stripe_session){const s=await stripe.checkout.sessions.retrieve(o.stripe_session);if(s.status!=='open')fail('Payment may be completing. Refresh your order.',409);await stripe.checkout.sessions.expire(s.id);}
  store.run("UPDATE orders SET status='expired' WHERE id=? AND status='pending'",o.id);res.json({ok:true});
});
app.post('/api/orders/:id/resume',async(req,res)=>{
  const o=privateOrder(req);
  if(demo||!stripe||o.status!=='pending'||!o.stripe_session)fail('There is no open checkout for this order.',409);
  const session=await stripe.checkout.sessions.retrieve(o.stripe_session);
  if(session.status!=='open'||!session.url)fail('Checkout has ended. Refresh your order for its latest status.',409);
  res.json({url:session.url});
});
app.post('/api/tickets/retrieve',limited(5),(req,res)=>{
  if(!demo&&(!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM))fail('Email delivery is temporarily unavailable. Please contact Mirari to retrieve your tickets.',503);
  const email=String(req.body.email||'').trim().toLowerCase();
  if(store.get("SELECT 1 FROM orders WHERE email=? AND booking_mode=? AND status IN ('paid','refunded','refunding','payment_review')",email,mode)){const key=token();store.run('INSERT INTO access_links(hash,email,expires,origin_mode) VALUES(?,?,?,?)',hash(key),email,Date.now()+15*60000,mode);store.queueMail(email,'Your private Mirari ticket link',`Open this link within 15 minutes to retrieve your tickets:\n${appUrl}/my-tickets#access=${key}\nThis link can be used once.`);}
  res.json({message:'If bookings match this email, a private link has been queued. Check your inbox.'});
});
app.post('/api/tickets/exchange',limited(10),(req,res)=>{
  const orders=store.tx(()=>{const digest=hash(String(req.body.token||'')),link=store.get('SELECT * FROM access_links WHERE hash=? AND expires>?',digest,Date.now());if(!link||link.origin_mode!==mode)fail('This link has expired or belongs to a different booking environment. Request a new one.',410);store.run('DELETE FROM access_links WHERE hash=?',digest);return store.all("SELECT id,access_token FROM orders WHERE email=? AND booking_mode=? AND status<>'pending' ORDER BY created DESC",link.email,mode).map(r=>({id:r.id,key:r.access_token}));});res.json(orders);
});
app.post('/api/admin/login',limited(5),async(req,res)=>{
  const candidate=await derivePassword(String(req.body?.password||'').slice(0,1000),salt,64);
  if(!timingSafeEqual(candidate,adminHash)||String(req.body?.email||'').toLowerCase()!==adminEmail.toLowerCase())fail('Incorrect email or password.',401);
  const counter=process.env.ADMIN_TOTP_SECRET?verifyTotp(process.env.ADMIN_TOTP_SECRET,req.body?.code):null;
  if(process.env.ADMIN_TOTP_SECRET&&counter===null)fail('Incorrect authenticator code.',401);
  const key=token();store.tx(()=>{
    if(counter!==null){if(counter<=Number(store.setting('admin_totp_counter','-1')))fail('Authenticator code was already used.',401);store.setSetting('admin_totp_counter',counter);}
    store.run('INSERT INTO sessions VALUES(?,?,?)',hash(key),adminEmail,Date.now()+8*3600000);
  });
  res.cookie('mirari_admin',key,{httpOnly:true,secure:production,sameSite:'strict',maxAge:8*3600000,path:'/api/admin'});res.json({email:adminEmail});
});
app.use('/api/admin',auth);
app.get('/api/admin/me',(req,res)=>res.json({email:req.actor}));
app.post('/api/admin/logout',(req,res)=>{store.run('DELETE FROM sessions WHERE hash=?',hash(cookie(req,'mirari_admin')||''));res.clearCookie('mirari_admin',{path:'/api/admin'});res.json({ok:true});});
app.get('/api/admin/events',(_req,res)=>res.json(store.events(true)));
app.post('/api/admin/events',(req,res)=>res.json(store.saveEvent(req.body,req.actor)));
app.get('/api/admin/orders',(_req,res)=>res.json(store.all('SELECT id FROM orders ORDER BY created DESC LIMIT 500').map(r=>publicOrder(store.order(r.id)))));
app.get('/api/admin/audit',(_req,res)=>res.json(store.all('SELECT * FROM audit ORDER BY id DESC LIMIT 200')));
app.get('/api/admin/alerts',(_req,res)=>res.json(store.all("SELECT * FROM alerts WHERE status='open' ORDER BY created_at DESC LIMIT 200")));
app.get('/api/admin/health',(_req,res)=>res.json({
  alerts:store.get("SELECT COUNT(*) n FROM alerts WHERE status<>'resolved'").n,
  failedMail:store.get("SELECT COUNT(*) n FROM mail WHERE status='failed'").n,
  unprocessedWebhooks:store.get("SELECT COUNT(*) n FROM provider_events WHERE result='received'").n,
  unresolvedPayments:store.get("SELECT COUNT(*) n FROM orders WHERE status IN ('payment_review','refunding','disputed')").n
}));
app.post('/api/admin/alerts/:id/ack',(req,res)=>{store.run("UPDATE alerts SET status='acknowledged' WHERE id=?",req.params.id);store.audit(req.actor,'alert.acknowledged',req.params.id);res.json({ok:true});});
app.get('/api/admin/mail',(_req,res)=>res.json(store.all('SELECT * FROM mail ORDER BY created DESC LIMIT 100').map(m=>({...m,body:expandMail(m.body)}))));
app.post('/api/admin/mail/:id/retry',(req,res)=>{const mail=store.get('SELECT origin_mode FROM mail WHERE id=?',req.params.id);if(!mail)fail('Message not found.',404);if(mail.origin_mode!==mode)fail('This message belongs to another environment and cannot be sent here.',409);store.run("UPDATE mail SET status='pending',error=NULL WHERE id=?",req.params.id);res.json({ok:true});});
app.get('/api/admin/settings',(_req,res)=>res.json(Object.fromEntries(store.all('SELECT * FROM settings').map(s=>[s.key,s.value]))));
app.post('/api/admin/settings',(req,res)=>{for(const k of ['terms','refunds','privacy','cookies','accessibility','contact'])if(typeof req.body[`policy.${k}`]==='string')store.setSetting(`policy.${k}`,req.body[`policy.${k}`].slice(0,15000));store.audit(req.actor,'policies.updated','settings');res.json({ok:true});});
app.post('/api/admin/check-in',limited(120),async(req,res)=>{
  const ticketToken=String(req.body.token||'').trim();
  const ticket=store.get('SELECT order_id FROM tickets WHERE token=?',ticketToken);
  if(ticket){
    const order=store.order(ticket.order_id);
    const freshness=Math.max(0,Math.min(5000,Number(process.env.PAYMENT_CHECKIN_MAX_AGE_MS||0)));
    if(order?.booking_mode!==mode||(!demo&&order?.payment_id==='demo'))fail('This ticket belongs to a different booking environment and is not valid for admission.',409);
    if(!demo)await verifyAdmissionPayment(store,order,providerPaymentState,freshness);
  }
  res.json(store.checkIn(ticketToken,req.actor,req.body.eventId));
});
app.post('/api/admin/orders/:id/resend',(req,res)=>{const o=store.order(req.params.id);if(!o)fail('Order not found.',404);if(o.booking_mode!==mode)fail('This booking belongs to another environment; its email cannot be sent here.',409);store.queueMail(o.email,`Your Mirari order · ${o.event.title}`,`View your order and tickets:\n{{ORDER_LINK:${o.id}}}`,o.id);store.audit(req.actor,'order.email-resent',o.id);res.json({ok:true});});
app.post('/api/admin/orders/:id/refund',async(req,res)=>{
  const o=store.order(req.params.id);if(!o||o.booking_mode!==mode||!['paid','payment_review','refunding'].includes(o.status))fail('This order cannot be refunded in this environment.',409);
  if(demo&&o.payment_id==='demo')store.applyRefundResult(o.id,{id:`demo-refund-${o.id}`,status:'succeeded'});
  else{
    if(!stripe||!o.payment_id)fail('Payment provider is unavailable.',503);
    const current=await providerPaymentState(o.payment_id);
    applyStripeState(o.payment_id,current);
    if(store.order(o.id).status==='refunded')return res.json(publicOrder(store.order(o.id)));
    if(current.intent?.status!=='succeeded'||current.intent.amount_received!==o.total||current.intent.currency!=='gbp')fail('Payment does not match this order. Review it in Stripe.',409);
    const attempt=store.claimRefund(o.id,req.actor);
    if(attempt.status==='pending')return res.json(publicOrder(store.order(o.id)));
    if(!attempt.idempotency_key)fail('A provider refund needs review before another request.',409);
    if(Date.now()-attempt.created_at>23*3600000){store.alert('refund_uncertain',o.id,'An unresolved refund attempt is too old to retry safely with its idempotency key. Resolve it in Stripe.');fail('This refund needs manual reconciliation before retry.',409);}
    store.markRefundSending(attempt.id);
    try{await stripe.refunds.create({payment_intent:o.payment_id,amount:attempt.amount,metadata:{mirariOrderId:o.id,mirariAttemptId:attempt.id}},{idempotencyKey:attempt.idempotency_key});applyStripeState(o.payment_id,await providerPaymentState(o.payment_id));}
    catch(error){store.markRefundUnknown(attempt.id);store.alert('refund_uncertain',o.id,'Refund request outcome is uncertain. Check Stripe before another attempt.');store.audit(req.actor,'refund.error',o.id,error.type||'connection-error');fail('Refund outcome is pending verification. Check Stripe before trying again.',502);}
  }
  store.audit(req.actor,'order.refund-requested',o.id);const updated=store.order(o.id);
  res.json(publicOrder(updated));
});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1}});
app.post('/api/admin/upload',upload.single('image'),async(req,res)=>{
  if(!req.file)fail('Choose an image.');const name=`${token()}.webp`;
  try{await sharp(req.file.buffer,{limitInputPixels:40_000_000}).rotate().resize({width:1800,withoutEnlargement:true}).webp({quality:82}).toFile(path.join(root,'assets/uploads',name));}catch{fail('Upload a valid JPEG, PNG or WebP image under 8 MB.');}res.json({url:`/assets/uploads/${name}`});
});
function expandMail(body){return body.replace(/\{\{ORDER_LINK:([^}]+)\}\}/g,(_m,id)=>{const o=store.order(id);return o?`${appUrl}/order/${o.id}#key=${o.access_token}`:'Order unavailable';});}
let sending=false;
async function sendMail(){
  if(sending||demo||!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM)return;sending=true;
  try{store.supersedeStaleMail();for(const mail of store.pendingDeliverableMail()){
    try{const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':mail.id},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[mail.recipient],subject:mail.subject,text:expandMail(mail.body)}),signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error(`Email provider returned ${response.status}`);store.run("UPDATE mail SET status='sent',error=NULL WHERE id=?",mail.id);if(mail.order_id)store.run("UPDATE orders SET delivery='sent' WHERE id=?",mail.order_id);
    }catch(error){store.run("UPDATE mail SET status='failed',error=? WHERE id=?",error.message,mail.id);store.alert('email_failed',mail.id,'Ticket or customer email delivery failed. Review the outbox and retry.');}
  }}finally{sending=false;}
}
let reconciling=false;
async function reconcile(){
  store.expire();if(demo||!stripe||reconciling)return;reconciling=true;
  try{
    for(const row of store.all("SELECT payload FROM provider_events WHERE result='received' ORDER BY received_at LIMIT 20")){
      try{await processStripeEvent(JSON.parse(row.payload));}catch(error){store.alert('webhook_retry','provider','Some signed Stripe events still need processing. Check provider access and webhook logs.');console.error('Webhook retry failed',error.name);}
    }
    for(const a of store.all("SELECT a.* FROM checkout_attempts a JOIN orders o ON o.id=a.order_id WHERE a.session_id IS NULL AND o.status='pending' ORDER BY a.updated_at LIMIT 20")){
      try{
        const order=store.order(a.order_id);
        if(Date.now()-a.created_at>24*3600000){store.alert('checkout_attempt',a.order_id,'An unbound Checkout attempt exceeded Stripe idempotency retention. Resolve manually before releasing seats.');continue;}
        const session=await ensureCheckoutSession(order,a);
        if(session.payment_status==='paid'||session.status==='expired')await processStripeEvent({id:`reconcile-unbound-${session.id}-${session.payment_status}`,type:session.payment_status==='paid'?'checkout.session.completed':'checkout.session.expired',livemode:false,data:{object:session}});
      }catch(error){store.alert('checkout_attempt',a.order_id,'Unbound Checkout reconciliation failed. Review Stripe and the reservation.');console.error('Unbound Checkout reconciliation failed',a.order_id,error.name);}
      finally{store.run('UPDATE checkout_attempts SET updated_at=? WHERE order_id=?',Date.now(),a.order_id);}
    }
    for(const o of store.pendingCheckoutReconciliation()){
    try{const s=await stripe.checkout.sessions.retrieve(o.stripe_session);
      if(s.payment_status==='paid'||s.status==='expired')await processStripeEvent({id:`reconcile-${s.id}-${s.payment_status}-${s.status}`,type:s.payment_status==='paid'?'checkout.session.completed':'checkout.session.expired',livemode:false,data:{object:s}});
      else if(Date.now()-o.expires>10*60000)store.alert('stuck_checkout',o.id,'A checkout hold is overdue. Confirm its Stripe status before releasing inventory.');
    }catch(error){store.alert('checkout_reconcile',o.id,'Checkout reconciliation failed; seats remain held. Check Stripe access.');console.error('Checkout reconciliation failed',o.id,error.name);}
    finally{store.markReconcile('checkout',o.id);}
    }
    const unresolved=store.paymentReconciliationCandidates();
    const paidAudit=store.all(`SELECT o.* FROM orders o LEFT JOIN reconcile_marks m ON m.kind='payment' AND m.subject=o.id
      WHERE o.status='paid' AND o.payment_id IS NOT NULL AND o.payment_id<>'demo' AND COALESCE(m.last_attempt,0)<?
      ORDER BY COALESCE(m.last_attempt,0) LIMIT 10`,Date.now()-5*60000);
    for(const o of [...unresolved,...paidAudit]){
      try{
        const state=await providerPaymentState(o.payment_id);
        applyStripeState(o.payment_id,state);
        if(o.status==='refunding'&&Date.now()-o.created>10*60000)store.alert('refund_pending',o.id,'Refund status needs confirmation in Stripe.');
      }catch(error){store.alert('payment_reconcile',o.id,'Provider payment reconciliation failed. Check Stripe access and order status.');console.error('Payment reconciliation failed',o.id,error.name);}
      finally{store.markReconcile('payment',o.id);}
    }
  }finally{reconciling=false;}
}
setInterval(()=>{void sendMail().catch(()=>console.error('Email worker failed'));},15000).unref();
setInterval(()=>{void reconcile().catch(()=>console.error('Payment reconciliation worker failed'));},60000).unref();
setTimeout(()=>{void reconcile().catch(()=>console.error('Payment reconciliation worker failed'));},1000).unref();
app.use('/assets',express.static(path.join(root,'assets'),{maxAge:'1d',dotfiles:'deny'}));
app.get('/styles.css',(_req,res)=>res.sendFile(path.join(root,'styles.css')));
app.get('/vendor/jsQR.js',(_req,res)=>res.sendFile(path.join(root,'node_modules/jsqr/dist/jsQR.js')));
app.use(express.static(path.join(root,'public'),{dotfiles:'deny'}));
app.use('/api',(_req,res)=>res.status(404).json({error:'Endpoint not found.'}));
app.get('/{*page}',(_req,res)=>res.sendFile(path.join(root,'index.html')));
app.use((error,_req,res,_next)=>{const status=Number.isInteger(error.status)&&error.status>=400&&error.status<600&&error.status!==500?error.status:500;if(status===500)console.error('Request failed:',error.name);res.status(status).json({error:status===500?'The service could not complete this request. Please try again.':error.message});});
app.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Mirari: ${appUrl} · ${demo?'DEMO — no real payments/emails':'configured payments'}\nAdmin credentials: environment or .local-admin.txt (private local file)`));
