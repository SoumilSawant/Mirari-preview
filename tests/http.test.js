import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHmac} from 'node:crypto';
import {rmSync,existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';
test('HTTP flow: secure admin, reservation, signed payment, QR, retrieval, admission, refund and event editor',async()=>{
  const port=20000+Math.floor(Math.random()*15000),origin=`http://127.0.0.1:${port}`;
  const dbPath=path.resolve(`data/integration-${randomUUID()}.sqlite`);
  const uploadsPath=path.resolve(`data/integration-uploads-${randomUUID()}`);
  const password=randomUUID(),secret='whsec_mirari_integration_test',totpSecret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const server=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),APP_URL:origin,HOST:'127.0.0.1',NODE_ENV:'test',DEMO_MODE:'true',DATABASE_PATH:dbPath,UPLOADS_PATH:uploadsPath,ADMIN_EMAIL:'qa@mirari.local',ADMIN_PASSWORD:password,ADMIN_TOTP_SECRET:totpSecret,STRIPE_SECRET_KEY:'sk_test_integration_only',STRIPE_WEBHOOK_SECRET:secret,RESEND_API_KEY:''},stdio:'pipe'});
  let logs='';server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
  const exited=new Promise(resolve=>server.on('exit',resolve));
  async function req(url,{method='GET',body,headers={}}={}){
    const r=await fetch(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return{status:r.status,data:await r.json(),headers:r.headers};
  }
  try{
    let ready=false;
    for(let i=0;i<80;i++){try{if((await req('/api/config')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
    assert.ok(ready,logs);
    assert.equal((await req('/api/health')).data.status,'ok');
    assert.equal((await req('/api/ready')).data.ready,true);
    assert.equal((await req('/api/admin/orders')).status,401);
    assert.equal((await req('/api/admin/login',{method:'POST',body:{email:'qa@mirari.local',password},headers:{Origin:'https://evil.invalid'}})).status,403);
    assert.equal((await req('/api/admin/login',{method:'POST',body:{email:'qa@mirari.local',password}})).status,401);
    const counter=Math.floor(Date.now()/30000),message=Buffer.alloc(8);message.writeBigUInt64BE(BigInt(counter));
    const digest=createHmac('sha1',Buffer.from('12345678901234567890')).update(message).digest(),offset=digest.at(-1)&15;
    const code=String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
    const login=await req('/api/admin/login',{method:'POST',body:{email:'qa@mirari.local',password,code}});
    assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],admin={Cookie:cookie};
    assert.equal((await req('/api/admin/login',{method:'POST',body:{email:'qa@mirari.local',password,code}})).status,401);
    const uploadBody=new FormData();uploadBody.append('image',new Blob([readFileSync(path.resolve('assets/mirari-logo.png'))],{type:'image/png'}),'logo.png');
    const uploaded=await fetch(origin+'/api/admin/upload',{method:'POST',headers:{Origin:origin,...admin},body:uploadBody});
    assert.equal(uploaded.status,200);const uploadUrl=(await uploaded.json()).url;
    assert.match(uploadUrl,/^\/assets\/uploads\/[A-Za-z0-9_-]+\.webp$/);
    const served=await fetch(origin+uploadUrl);assert.equal(served.status,200);assert.match(served.headers.get('content-type'),/^image\/webp/);
    const list=(await req('/api/events')).data,e=list[0];
    const created=await req('/api/reservations',{method:'POST',body:{eventId:e.id,name:'HTTP Test',email:'http-test@example.com',acceptedTerms:true,items:[{tierId:e.tiers[0].id,quantity:1}]}});
    assert.equal(created.status,200);const{id,key}=created.data,guest={'x-order-token':key};
    assert.equal((await req(`/api/orders/${id}`)).status,404);
    const stripe=new Stripe('sk_test_integration_only');
    const webhook=async(event,valid=true)=>{
      const payload=JSON.stringify(event),signature=stripe.webhooks.generateTestHeaderString({payload,secret:valid?secret:'wrong-secret'});
      return fetch(origin+'/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature},body:payload});
    };
    const event={id:'evt_integration',type:'checkout.session.completed',data:{object:{metadata:{orderId:id},amount_total:e.tiers[0].price,currency:'gbp',payment_status:'paid',payment_intent:'demo'}}};
    assert.equal((await webhook(event,false)).status,400);
    assert.equal((await webhook(event)).status,200);assert.equal((await webhook(event)).status,200);
    const paid=(await req(`/api/orders/${id}`,{headers:guest})).data;
    assert.equal(paid.status,'paid');assert.equal(paid.tickets.length,1);assert.ok(!('access_token'in paid));
    assert.equal((await req('/api/admin/health',{headers:admin})).status,200);
    const qr=await req(`/api/orders/${id}/tickets/${paid.tickets[0].id}/qr`,{headers:guest});assert.match(qr.data.dataUrl,/^data:image\/png;base64,/);
    let scan=await req('/api/admin/check-in',{method:'POST',headers:admin,body:{token:paid.tickets[0].token,eventId:e.id}});assert.equal(scan.status,200);
    scan=await req('/api/admin/check-in',{method:'POST',headers:admin,body:{token:paid.tickets[0].token,eventId:e.id}});assert.equal(scan.status,409);
    await req('/api/tickets/retrieve',{method:'POST',body:{email:'http-test@example.com'}});
    const mail=(await req('/api/admin/mail',{headers:admin})).data;
    const retrieval=mail.find(m=>m.subject==='Your private Mirari ticket link').body.match(/#access=([^\s]+)/)[1];
    const exchange=await req('/api/tickets/exchange',{method:'POST',body:{token:retrieval}});assert.equal(exchange.status,200);assert.equal(exchange.data[0].id,id);
    assert.equal((await req('/api/tickets/exchange',{method:'POST',body:{token:retrieval}})).status,410);
    await webhook({id:'evt_refund',type:'charge.refunded',data:{object:{payment_intent:'demo',refunded:true}}});
    assert.equal((await req(`/api/orders/${id}`,{headers:guest})).data.status,'refunded');
    const edit=await req('/api/admin/events',{method:'POST',headers:admin,body:{...e,id:undefined,title:'Admin test event',status:'draft',tiers:e.tiers.map(t=>({...t,id:undefined}))}});
    assert.equal(edit.status,200);
    assert.equal((await req(`/api/events/${edit.data.id}`)).status,404);
    await req('/api/admin/settings',{method:'POST',headers:admin,body:{'policy.contact':'Contact information test'}});
    assert.equal((await req('/api/policies/contact')).data.body,'Contact information test');
    const second=await req('/api/reservations',{method:'POST',body:{eventId:e.id,name:'Refund Test',email:'refund-test@example.com',acceptedTerms:true,items:[{tierId:e.tiers[0].id,quantity:1}]}});
    await req(`/api/orders/${second.data.id}/demo-pay`,{method:'POST',headers:{'x-order-token':second.data.key},body:{}});
    assert.equal((await req(`/api/admin/orders/${second.data.id}/refund`,{method:'POST',headers:admin,body:{}})).data.status,'refunded');
  }finally{
    server.kill();await exited;
    assert.ok(dbPath.startsWith(path.resolve('data')+path.sep+'integration-'));
    for(const suffix of ['','-wal','-shm'])if(existsSync(dbPath+suffix))rmSync(dbPath+suffix);
    assert.ok(uploadsPath.startsWith(path.resolve('data')+path.sep+'integration-uploads-'));
    if(existsSync(uploadsPath))rmSync(uploadsPath,{recursive:true});
  }
});
