export async function renderAdmin(c) {
  const {$,esc,money,date,time,api,post,toast,form,confirmAction,main,config,navigate}=c;
  const modeLabel=value=>value==='demo'?'DEMO':value==='stripe-live'?'LIVE':'STRIPE TEST';
  let stopCamera=()=>{};
  document.title='Organiser studio · Mirari';
  try{await api('/api/admin/me');}catch{
    main.innerHTML=`<section class="page narrow"><span class="eyebrow">THE ORGANISER STUDIO</span><h1 style="font-size:52px">Behind the moments.</h1><p>Sign in to manage events, bookings and admission.</p><form class="panel" id="admin-login"><label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required></label><label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>${config.mfaRequired?'<label class="field"><span>Authenticator code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>':''}<p class="form-error" role="alert"></p><button type="submit" class="button full">Sign in ↗</button></form>${config.demo?'<p class="help-text" style="margin-top:20px">Local setup: your private generated credentials are in .local-admin.txt in the project folder.</p>':''}</section>`;
    form('#admin-login',async f=>{await post('/api/admin/login',{email:f.get('email'),password:f.get('password'),code:f.get('code')});await navigate('/admin');});return;
  }
  main.innerHTML=`<section class="page"><div class="admin-top"><div><span class="eyebrow">MIRARI ORGANISER STUDIO</span><h1>Make the night happen.</h1></div><button class="button ghost small" id="logout">Sign out</button></div><nav class="admin-tabs" aria-label="Organiser sections">${['Events','Orders','Check-in','Email outbox','Alerts','Policies','Audit'].map(t=>`<button class="button ghost small" data-tab="${t}">${t}</button>`).join('')}</nav><div id="admin-content"></div></section>`;
  $('#logout').onclick=async()=>{await post('/api/admin/logout');await navigate('/admin');};
  const content=$('#admin-content');
  async function tab(name){
    stopCamera();stopCamera=()=>{};
    document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===name);b.setAttribute('aria-current',b.dataset.tab===name?'page':'false');});
    content.innerHTML='<div class="loading">Loading…</div>';
    try{
      if(name==='Events')await eventList();
      if(name==='Orders')await orderList();
      if(name==='Check-in')await checkIn();
      if(name==='Email outbox')await outbox();
      if(name==='Alerts')await alerts();
      if(name==='Policies')await settings();
      if(name==='Audit')await audit();
    }catch(e){content.innerHTML=`<div class="notice error">${esc(e.message)}</div>`;}
  }
  document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.tab));
  const field=(name,label,value='',type='text',required=false)=>`<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${required?'required':''}></label>`;
  const area=(name,label,value='')=>`<label class="field wide"><span>${label}</span><textarea name="${name}">${esc(value)}</textarea></label>`;
  const ukInput=iso=>{
    if(!iso)return'';
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso));
    const p=Object.fromEntries(parts.map(p=>[p.type,p.value]));return`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  const fromUK=value=>{
    if(!value)return'';
    let guess=new Date(value+'Z');
    for(let i=0;i<2;i++){const name=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',timeZoneName:'shortOffset'}).formatToParts(guess).find(p=>p.type==='timeZoneName').value;guess=new Date(Date.parse(value+'Z')-(name==='GMT+1'?3600000:0));}
    if(ukInput(guess)!==value)throw new Error('That UK local time does not exist because clocks change. Choose another time.');
    return guess.toISOString();
  };
  async function eventList(){
    const list=await api('/api/admin/events');
    content.innerHTML=`<div class="page-title-row"><h2>Your events</h2><button class="button" id="new-event">Create event +</button></div><div class="admin-list">${list.map(e=>`<article class="admin-row"><div><span class="eyebrow">${esc(e.status)}${e.demo?' · DEMO':''}</span><h3>${esc(e.title)}</h3><p>${date(e.startAt)} · ${esc(e.city)} · ${e.tiers.reduce((n,t)=>n+t.available,0)} tickets available</p></div><div class="actions"><a class="button small ghost" href="/event/${e.id}">Preview</a><button class="button small" data-edit="${e.id}">Edit event</button></div></article>`).join('')||'<div class="empty">Create your first event.</div>'}</div>`;
    $('#new-event').onclick=()=>editEvent();
    document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editEvent(list.find(e=>e.id===b.dataset.edit)));
  }
  async function editEvent(e={}){
    content.innerHTML=`<div class="page-title-row"><h2>${e.id?'Edit event':'Create an event'}</h2><button class="button ghost small" id="back-events">Back to events</button></div><form class="panel" id="event-editor"><div class="form-grid">${field('title','Event name',e.title,'text',true)}${field('city','City',e.city||'London','text',true)}
      <label class="field"><span>Status</span><select name="status">${['draft','announced','published','postponed','cancelled'].map(s=>`<option ${e.status===s?'selected':''}>${s}</option>`).join('')}</select></label>${field('category','Experience / category',e.category||'Live music')}
      ${field('startAt','Event starts · UK local time',ukInput(e.startAt),'datetime-local',true)}${field('doorsAt','Doors open · UK local time',ukInput(e.doorsAt),'datetime-local')}
      ${field('venue','Venue name',e.venue,'text',true)}${field('address','Full venue address',e.address,'text',true)}
      ${field('lat','Latitude (UK)',e.lat??51.5074,'number',true)}${field('lng','Longitude (UK)',e.lng??-0.1278,'number',true)}
      ${field('age','Age & ID requirements',e.age)}${field('image','Event image URL',e.image||'/assets/hero.webp')}
      <label class="field"><span>Event image layout</span><select name="imageFit"><option value="cover" ${e.imageFit!=='contain'?'selected':''}>Landscape photo · fill frame</option><option value="contain" ${e.imageFit==='contain'?'selected':''}>Poster · show full artwork</option></select></label>
      <label class="field wide"><span>Upload event image · JPEG, PNG or WebP, up to 8 MB</span><input type="file" id="upload-image" accept="image/png,image/jpeg,image/webp"><small id="upload-status"></small></label>
      ${area('description','Description',e.description)}${area('lineup','Programme / line-up',e.lineup)}${area('accessibility','Access information and companion tickets',e.accessibility)}${area('policy','Event-specific booking / transfer policy',e.policy)}${area('notice','Customer update (for changes or cancellations)',e.notice)}
      </div><label class="check-field"><input type="checkbox" name="demo" ${e.demo?'checked disabled':''}><span>Demonstration event — permanently labelled; create a new event for provider bookings</span></label>
      <h3 style="margin-top:30px">Ticket tiers</h3><p class="help-text">Enter the all-in price in pounds. Tiers share no capacity: allocate the venue’s total capacity across them. Sales dates use UK local time. Draft and announced events may have no tiers; only published events can sell tickets.</p><div id="tier-editors"></div><button type="button" class="button ghost small" id="add-tier">Add tier +</button><p class="notice" style="margin-top:25px">Changing an event’s date or status queues an update for paid customers. Cancellation blocks admission; refund affected orders in Orders.</p><p class="form-error" role="alert"></p><button type="submit" class="button">Save event ↗</button></form>`;
    for(const name of ['lat','lng'])$(`[name="${name}"]`).step='any';
    $('#back-events').onclick=()=>eventList();
    function addTier(t={}){
      const row=document.createElement('div');row.className='tier-editor';row.dataset.id=t.id||'';
      row.innerHTML=`${field('tierName','Tier name',t.name||'General admission','text',true)}${field('tierPrice','Total price (£)',t.price!==undefined?(t.price/100).toFixed(2):'35.00','number',true)}${field('tierCapacity','Capacity',t.capacity??100,'number',true)}${field('tierOpens','Sales open',ukInput(t.opens),'datetime-local')}${field('tierCloses','Sales close',ukInput(t.closes),'datetime-local')}<button class="button ghost small" type="button" aria-label="Remove ticket tier">×</button>`;
      $('[name=tierPrice]',row).step='.01';$('[name=tierPrice]',row).min='1';$('[name=tierCapacity]',row).min='0';
      $('button',row).onclick=()=>row.remove();$('#tier-editors').append(row);
    }
    (e.id?e.tiers||[]:[{}]).forEach(addTier);$('#add-tier').onclick=()=>addTier();
    $('#upload-image').onchange=async ev=>{
      if(!ev.target.files[0])return;$('#upload-status').textContent='Uploading…';
      try{const body=new FormData();body.append('image',ev.target.files[0]);const r=await api('/api/admin/upload',{method:'POST',body});$('[name=image]').value=r.url;$('#upload-status').textContent='Image uploaded and optimised.';}catch(error){$('#upload-status').textContent=error.message;}
    };
    form('#event-editor',async f=>{
      const data=Object.fromEntries(f);data.id=e.id;data.demo=Boolean(e.demo)||f.get('demo')==='on';data.lat=Number(data.lat);data.lng=Number(data.lng);data.startAt=fromUK(data.startAt);data.doorsAt=fromUK(data.doorsAt);
      data.tiers=[...document.querySelectorAll('.tier-editor')].map(row=>({id:row.dataset.id||undefined,name:$('[name=tierName]',row).value,price:Math.round(Number($('[name=tierPrice]',row).value)*100),capacity:Number($('[name=tierCapacity]',row).value),opens:fromUK($('[name=tierOpens]',row).value),closes:fromUK($('[name=tierCloses]',row).value)}));
      if(e.id&&['cancelled','postponed'].includes(data.status)&&data.status!==e.status&&!await confirmAction('Change this event’s status?',`Mark this event ${data.status}, block admission and queue an update for booked customers? Refunds are managed separately in Orders.`))return;
      await post('/api/admin/events',data);toast('Event saved.');await eventList();
    });
  }
  async function orderList(){
    const orders=await api('/api/admin/orders'),paid=orders.filter(o=>o.status==='paid'&&o.booking_mode===config.mode);
    content.innerHTML=`<div class="page-title-row"><h2>Bookings & attendees</h2></div><div class="admin-stats"><div><strong>${orders.length}</strong><span>ORDERS (LATEST 500)</span></div><div><strong>${money(paid.reduce((n,o)=>n+o.total,0))}</strong><span>${config.demo?'DEMO BOOKING VALUE':config.live?'LIVE SALES (LATEST 500)':'STRIPE TEST BOOKING VALUE'}</span></div><div><strong>${paid.reduce((n,o)=>n+o.tickets.length,0)}</strong><span>${config.live?'TICKETS':'TEST TICKETS'}</span></div><div><strong>${paid.reduce((n,o)=>n+o.tickets.filter(t=>t.checked_at).length,0)}</strong><span>${config.live?'CHECK-INS':'TEST CHECK-INS'}</span></div></div><p class="help-text">${config.live?'Totals include only paid live bookings in the latest 500 orders. Compare these figures with Stripe before accounting or refunds.':`Totals include only ${config.demo?'demo':'Stripe test'} bookings in the latest 500 orders. No real money is represented here.`}</p><label class="field"><span>Search order, event or customer</span><input type="search" id="order-search" placeholder="Name, email, event or order reference"></label><div class="admin-list" id="orders-list"></div>`;
    function render(){
      const q=$('#order-search').value.toLowerCase(),filtered=orders.filter(o=>`${o.id} ${o.name} ${o.email} ${o.event.title}`.toLowerCase().includes(q));
      $('#orders-list').innerHTML=filtered.map(o=>`<article class="panel"><div class="admin-row" style="padding:0;border:0"><div><span class="eyebrow">${modeLabel(o.booking_mode)} · ${esc(o.status.replaceAll('_',' '))} · ${esc(o.id.slice(0,8))}</span><h3>${esc(o.event.title)}</h3><p>${esc(o.name)} · ${esc(o.email)}<br>${money(o.total)} · ${o.items.reduce((n,i)=>n+i.quantity,0)} tickets · Email: ${esc(o.delivery)}</p></div><div class="actions">${o.booking_mode===config.mode?`<button class="button ghost small" data-resend="${o.id}">Resend email</button>`:''}${o.booking_mode===config.mode&&['paid','payment_review','refunding'].includes(o.status)?`<button class="button danger small" data-refund="${o.id}">Full refund</button>`:''}</div></div>${o.refund_status==='failed'?'<p class="notice error" style="margin-top:15px"><strong>Refund failed in Stripe.</strong> This order remains paid. Check the payment and contact the customer before attempting another refund.</p>':''}${o.tickets.length?`<details style="margin-top:15px"><summary>Attendee tickets & check-in</summary><div class="table-wrap"><table class="data-table"><thead><tr><th>Ticket</th><th>Tier</th><th>Admission</th></tr></thead><tbody>${o.tickets.map(t=>`<tr><td>${esc(t.id.slice(0,8))}</td><td>${esc(t.tier_name)}</td><td>${t.checked_at?`${date(t.checked_at)} ${time(t.checked_at)}`:'Not checked in'}</td></tr>`).join('')}</tbody></table></div></details>`:''}</article>`).join('')||'<div class="empty">No matching orders.</div>';
      document.querySelectorAll('[data-resend]').forEach(b=>b.onclick=async()=>{try{await post(`/api/admin/orders/${b.dataset.resend}/resend`);toast('Email queued.');}catch(e){toast(e.message);}});
      document.querySelectorAll('[data-refund]').forEach(b=>b.onclick=async()=>{const o=orders.find(o=>o.id===b.dataset.refund);if(!await confirmAction('Refund this order?',`Refund ${money(o.total)} for ${o.name}? Every ticket in this order will become invalid.`))return;b.disabled=true;try{await post(`/api/admin/orders/${o.id}/refund`);toast('Refund request recorded. Check the order status for the outcome.');await orderList();}catch(e){toast(e.message);b.disabled=false;}});
    }
    $('#order-search').oninput=render;render();
  }
  async function checkIn(){
    const list=await api('/api/admin/events');
    content.innerHTML=`<div class="narrow"><h2>${config.live?'Ticket check-in':'Test check-in'}.</h2><p>${config.live?'Select the event before scanning. Only paid, valid tickets can be admitted once. Stripe payment state is verified before admission.':'Select the event before scanning. Every test ticket can be scanned once. A successful scan does not authorise real admission.'}</p><label class="field"><span>${config.live?'Event':'Test event'}</span><select id="scan-event"><option value="">Choose an event</option>${list.filter(e=>e.status==='published'&&(config.demo||!e.demo)).map(e=>`<option value="${e.id}">${esc(e.title)} · ${esc(e.city)}</option>`).join('')}</select></label><div class="actions"><button class="button" id="start-camera">Start camera</button><button class="button ghost" id="stop-camera" hidden>Stop camera</button></div><video class="scanner-video" id="scan-video" autoplay playsinline muted hidden></video><canvas id="scan-canvas" hidden></canvas><form class="panel" id="scan-form" style="margin-top:25px"><label class="field"><span>Or paste the ticket code</span><input name="token" autocomplete="off" spellcheck="false" required></label><p class="form-error" role="alert"></p><button type="submit" class="button full">Check ticket</button></form><div id="scan-result" style="margin-top:20px" role="status"></div></div>`;
    let stream,frame,busy=false,last='',lastAt=0;
    stopCamera=()=>{if(frame)cancelAnimationFrame(frame);stream?.getTracks().forEach(t=>t.stop());stream=null;const v=$('#scan-video');if(v){v.srcObject=null;v.hidden=true;$('#stop-camera').hidden=true;$('#start-camera').disabled=false;}};
    async function scan(value){
      const eventId=$('#scan-event').value;if(!eventId)throw new Error('Choose the event before scanning.');
      try{const r=await post('/api/admin/check-in',{token:value,eventId});$('#scan-result').className='scan-result';$('#scan-result').innerHTML=`<h3>✓ ${config.live?'Check-in accepted':'Test scan accepted'} for ${esc(r.name)}</h3><p>${esc(r.event)} · ${esc(r.tier)}</p>${config.live?'':'<p>No real admission is authorised.</p>'}`;}
      catch(e){$('#scan-result').className='scan-result error';$('#scan-result').textContent=e.message;throw e;}
    }
    form('#scan-form',async(f,form)=>{await scan(f.get('token'));form.reset();});
    $('#stop-camera').onclick=()=>stopCamera();
    $('#start-camera').onclick=async()=>{
      try{
        if(!$('#scan-event').value)throw new Error('Choose the event before starting the camera.');
        if(!window.jsQR)await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/vendor/jsQR.js';s.onload=resolve;s.onerror=()=>reject(new Error('QR decoder could not load. Use the ticket code instead.'));document.head.append(s);});
        stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:640}},audio:false});
        const video=$('#scan-video'),canvas=$('#scan-canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});video.srcObject=stream;video.hidden=false;await video.play();$('#stop-camera').hidden=false;$('#start-camera').disabled=true;
        const tick=async()=>{
          if(!stream)return;
          if(video.readyState>=2&&!busy){canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);const im=ctx.getImageData(0,0,canvas.width,canvas.height),qr=window.jsQR(im.data,im.width,im.height,{inversionAttempts:'dontInvert'});
            if(qr&&(qr.data!==last||Date.now()-lastAt>5000)){last=qr.data;lastAt=Date.now();busy=true;try{await scan(qr.data);}catch{}busy=false;}}
          frame=requestAnimationFrame(tick);
        };void tick();
      }catch(e){stopCamera();toast(e.message||'Camera unavailable. Use the ticket code.');}
    };
  }
  async function outbox(){
    const mails=await api('/api/admin/mail');
    const linked=body=>esc(body).replace(/https?:\/\/[^\s<>]+/g,url=>`<a class="text-link" href="${url}">${url}</a>`);
    const pending=mails.filter(m=>m.origin_mode===config.mode&&m.status==='pending').length;
    content.innerHTML=`<h2 style="font-size:38px">Email outbox</h2><p>${config.demo?'Demo mode: nothing is sent. Open a queued message to test its private ticket link.':config.live?'Only live booking messages are sent through Resend. Demo and Stripe test messages remain held.':'Only Stripe test-mode messages are sent through Resend. Old demo messages remain held.'}</p>${!config.demo&&!config.emailReady?`<p class="notice error"><strong>Email delivery is not configured.</strong> ${pending} ${config.live?'live':'Stripe test'} message${pending===1?' is':'s are'} pending. Review every recipient and message before adding a verified sender and Resend API key; eligible queued messages will then send automatically.</p>`:''}${mails.map(m=>`<details class="mail-item"><summary><strong>${esc(m.subject)}</strong><br><small>${esc(m.recipient)} · ${m.origin_mode==='demo'?'DEMO HELD':modeLabel(m.origin_mode)} · ${esc(m.status)} · ${date(m.created)} ${time(m.created)}</small></summary><pre>${linked(m.body)}</pre>${m.error?`<p class="form-error">${esc(m.error)}</p>`:''}${m.status==='failed'&&m.origin_mode===config.mode?`<button class="button small" data-retry="${m.id}">Retry delivery</button>`:''}</details>`).join('')||'<div class="empty">No messages yet.</div>'}`;
    document.querySelectorAll('[data-retry]').forEach(b=>b.onclick=async()=>{await post(`/api/admin/mail/${b.dataset.retry}/retry`);toast('Queued for another delivery attempt.');await outbox();});
  }
  async function settings(){
    const data=await api('/api/admin/settings');
    content.innerHTML=`<h2 style="font-size:38px">Customer information</h2><p>Publish Mirari’s approved policies and contact details. These pages are visible to customers. Live booking requires terms, refunds, privacy and contact information.</p><form class="panel" id="settings-form">${['terms','refunds','privacy','cookies','accessibility','contact'].map(k=>area(`policy.${k}`,k[0].toUpperCase()+k.slice(1),data[`policy.${k}`])).join('')}<p class="form-error" role="alert"></p><button class="button" type="submit">Save information</button></form>`;
    form('#settings-form',async f=>{await post('/api/admin/settings',Object.fromEntries(f));toast('Customer information saved.');});
  }
  async function audit(){
    const log=await api('/api/admin/audit');
    content.innerHTML=`<h2 style="font-size:38px">Activity history</h2><p>Latest 200 inventory, payment, event and admission actions.</p><div class="table-wrap"><table class="data-table"><thead><tr><th>UK time</th><th>Actor</th><th>Action</th><th>Reference</th><th>Detail</th></tr></thead><tbody>${log.map(l=>`<tr><td>${date(l.at)} ${time(l.at)}</td><td>${esc(l.actor)}</td><td>${esc(l.action)}</td><td>${esc(l.subject.slice(0,12))}</td><td>${esc(l.detail)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  async function alerts(){
    const list=await api('/api/admin/alerts');
    const isOrder=a=>/^[0-9a-f]{8}-/i.test(a.subject);
    content.innerHTML=`<h2 style="font-size:38px">Needs attention</h2><p>Check the payment provider before resolving money or admission issues.</p><div class="admin-list">${list.map(a=>`<article class="panel"><span class="eyebrow">${a.kind==='refund_failed'?`${modeLabel(config.mode)} · PAYMENT ALERT`:'NEEDS ATTENTION'}</span><h3>${esc(a.kind==='refund_failed'?'Refund failed':a.kind.replaceAll('_',' '))}</h3><p>${esc(a.detail)}</p><p class="help-text">${isOrder(a)?'Order ID':'Reference'}: <code>${esc(a.subject)}</code></p><small>${date(a.created_at)} ${time(a.created_at)}</small><div class="actions">${isOrder(a)?`<button class="button small" data-alert-order="${esc(a.subject)}">View order</button>`:''}<button class="button ghost small" data-ack="${esc(a.id)}">Acknowledge</button></div></article>`).join('')||'<div class="empty">No open alerts.</div>'}</div>`;
    document.querySelectorAll('[data-alert-order]').forEach(b=>b.onclick=async()=>{await tab('Orders');const search=$('#order-search');if(search){search.value=b.dataset.alertOrder;search.dispatchEvent(new Event('input'));}});
    document.querySelectorAll('[data-ack]').forEach(b=>b.onclick=async()=>{await post(`/api/admin/alerts/${b.dataset.ack}/ack`,{});await alerts();});
  }
  await tab('Events');
  return()=>stopCamera();
}
