const $=(selector,root=document)=>root.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const eventPath=id=>`/event/${encodeURIComponent(id)}`;
const date=(value,options={day:'numeric',month:'short',year:'numeric'})=>new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',...options}).format(new Date(value));
const time=value=>date(value,{hour:'2-digit',minute:'2-digit'});
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const main=$('#main');
let events=[];
let cleanup=()=>{};

function closeMenu(){
  $('#nav').classList.remove('open');
  $('#menu-button').setAttribute('aria-expanded','false');
  $('#menu-button').setAttribute('aria-label','Open navigation');
}

$('#menu-button').addEventListener('click',()=>{
  const open=$('#nav').classList.toggle('open');
  $('#menu-button').setAttribute('aria-expanded',String(open));
  $('#menu-button').setAttribute('aria-label',open?'Close navigation':'Open navigation');
});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
$('#year').textContent=new Date().getFullYear();

let scrollFrame=false;
window.addEventListener('scroll',()=>{
  if(scrollFrame)return;
  scrollFrame=true;
  requestAnimationFrame(()=>{
    $('#header').classList.toggle('scrolled',scrollY>20);
    if(!reduced.matches&&innerWidth>760)$('.hero-bg')?.style.setProperty('--hero-y',`${Math.min(scrollY*.12,65)}px`);
    scrollFrame=false;
  });
},{passive:true});

function reveal(){
  const nodes=document.querySelectorAll('.reveal');
  if(reduced.matches||!('IntersectionObserver' in window)){document.body.classList.remove('motion-ready');return()=>{};}
  nodes.forEach(node=>{
    const siblings=[...node.parentElement.children].filter(child=>child.classList.contains('reveal'));
    node.style.setProperty('--reveal-delay',`${Math.min(siblings.indexOf(node),3)*75}ms`);
  });
  document.body.classList.add('motion-ready');
  const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{
    if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target);}
  }),{threshold:.08,rootMargin:'0px 0px 36px 0px'});
  nodes.forEach(node=>observer.observe(node));
  return()=>observer.disconnect();
}

function card(event){
  return `<a class="event-card reveal" href="${eventPath(event.id)}"><div class="event-image poster-art"><img src="${esc(event.image)}" alt="${esc(event.title)} event poster" loading="lazy" width="600" height="400"></div><span class="eyebrow">${esc(event.city)} · ${esc(event.category)}</span><h3>${esc(event.title)}</h3><p>${date(event.startAt)} · ${esc(event.venue)}</p><div class="event-card-bottom"><span>Book via Ticket Tailor</span><span aria-hidden="true">↗</span></div></a>`;
}

function setMetadata(title,path,description){
  document.title=title;
  const canonical=`https://mirari.events${path}`;
  $('link[rel="canonical"]').href=canonical;
  $('meta[property="og:url"]').content=canonical;
  $('meta[property="og:title"]').content=title;
  if(description){$('meta[name="description"]').content=description;$('meta[property="og:description"]').content=description;}
  $('meta[name="robots"]').content='index,follow';
}

async function home(){
  setMetadata('Mirari · Where Culture Comes Alive','/','Discover music, dance, art and meaningful cultural experiences in London.');
  const event=events[0];
  const experiences=[
    ['Music & Live Performances','From soulful classical mornings to energetic fusion concerts, discover music that brings traditions and generations together.'],
    ['Dance & Movement','Celebrate movement through Lavani, folk dance, Bollywood, contemporary fusion and interactive dance workshops.'],
    ['Art & Creative Workshops','Explore the beauty of traditional and contemporary art through Warli painting, Madhubani art, block printing and other hands-on experiences.'],
    ['Festivals & Cultural Celebrations','Experience the joy of Diwali, traditional Indian festivals and special cultural gatherings in welcoming, thoughtfully curated settings.'],
    ['Community & Connection','Meet new people, discover shared interests and become part of a growing creative community in London.']
  ];
  main.innerHTML=`
    <section class="hero"><img class="hero-bg" src="/assets/hero.webp" alt="Illustrative concert atmosphere" width="1800" height="1013" fetchpriority="high"><div class="hero-copy"><span class="eyebrow">WHERE CULTURE COMES ALIVE</span><h1>Experience culture.<br>Feel the connection.</h1><p>Discover a world of music, dance, art and unforgettable cultural experiences in London. From traditional celebrations to contemporary creative gatherings, Mirari brings communities and cultures together.</p><div class="actions"><a class="button" href="/events">Explore events <span>↗</span></a><a class="button ghost" href="/#about">Discover Mirari <span>↗</span></a></div></div><a href="/#atlas" class="scroll-note">SCROLL<span>↓</span></a></section>
    <section id="atlas" class="atlas"><div class="atlas-controls" aria-label="Choose an event city"><button class="chip active" data-city="London" aria-pressed="true">London</button></div><div class="atlas-grid"><div class="atlas-intro reveal"><span class="eyebrow">THE NIGHT ATLAS</span><h2>Find your<br>next moment.</h2><p>From iconic venues to hidden gems. A world of nights, closer to home.</p><a class="text-link" href="/events">Explore all events ↗</a><div class="compass" aria-hidden="true">✧</div></div><div class="map-wrap reveal" id="map-wrap"><div class="loading">Opening the atlas…</div></div><div class="atlas-panel reveal"><div class="panel-enter"><div class="city-banner"><img src="${esc(event.image)}" alt=""><h3>London</h3><p>1 upcoming event</p></div><article class="mini-event"><div class="date-tile"><b>${date(event.startAt,{day:'numeric'})}</b><span>${date(event.startAt,{month:'short'})}</span></div><div><h3>${esc(event.title)}</h3><p>${esc(event.venue)}<br><span class="mini-price">Book via Ticket Tailor</span></p><a class="button ghost small" href="${eventPath(event.id)}">View tickets <span>↗</span></a></div></article></div></div></div></section>
    <section class="section"><div class="section-head reveal"><div><span class="eyebrow">MAKE A MORNING OF IT</span><h2>Coming into the spotlight.</h2></div><a class="text-link" href="/events">View all events ↗</a></div><div class="event-grid">${card(event)}</div></section>
    <section class="section experiences" id="experiences"><div class="section-head reveal"><div><span class="eyebrow">DISCOVER OUR EXPERIENCES</span><h2>Culture to share.</h2></div></div><div class="experience-grid">${experiences.map(([title,copy],index)=>`<article class="experience-card reveal"><span class="eyebrow">${String(index+1).padStart(2,'0')}</span><h3>${title}</h3><p>${copy}</p></article>`).join('')}</div></section>
    <section class="section experience" id="how-it-works"><div class="reveal"><span class="eyebrow">FROM THE FIRST CLICK TO THE FIRST NOTE</span><h2>Less planning.<br>More living.</h2></div><div class="steps"><article class="step reveal"><span>01</span><h3>Find your moment.</h3><p>Explore Mirari and discover the event that brings you closer to culture and community.</p></article><article class="step reveal"><span>02</span><h3>Choose your tickets.</h3><p>Continue to Ticket Tailor to select tickets and review the complete checkout total before paying.</p></article><article class="step reveal"><span>03</span><h3>Be there.</h3><p>Keep the confirmation and tickets Ticket Tailor sends by email, then present them at the event.</p></article></div></section>
    <section class="section about" id="about"><img class="about-img reveal" src="/assets/jazz.webp" alt="Illustrative live performance atmosphere" width="1000" height="563" loading="lazy"><div class="reveal"><span class="eyebrow">ABOUT MIRARI</span><h2>Rooted in culture.<br>Made for connection.</h2><p>Mirari is a London-based cultural experiences company bringing people together through music, dance, art and meaningful community celebrations.</p><p>From intimate creative workshops to immersive cultural festivals, Mirari creates spaces where traditions meet contemporary expression and people connect through shared experiences.</p><h3>Our philosophy</h3><p>Tradition inspires us. Creativity connects us. Community defines us.</p><p>Mirari brings together heritage and modern expression, creating experiences that feel authentic, inclusive and memorable.</p><a class="text-link" href="/events">Explore Mirari events ↗</a></div></section>
    <section class="section community reveal"><div><span class="eyebrow">JOIN THE MIRARI COMMUNITY</span><h2>More moments together.</h2><p>Discover upcoming events, creative workshops, artist collaborations and special cultural experiences.</p></div><a class="button" href="/events">Explore events <span>↗</span></a></section>
    <section class="section faq"><div class="reveal"><span class="eyebrow">BEFORE THE EVENT BEGINS</span><h2>A few things<br>to know.</h2></div><div class="reveal"><details><summary>Where do I book?</summary><p>Choose Book tickets and Mirari will take you to the official Ticket Tailor listing.</p></details><details><summary>How will I receive my tickets?</summary><p>Ticket Tailor handles checkout and sends the order confirmation and tickets to the email used when booking.</p></details><details><summary>When will I see the final price?</summary><p>Ticket Tailor shows available tickets and the complete checkout total before payment.</p></details><details><summary>Where can I get help with an order?</summary><p>Use the contact and order-management information included in your Ticket Tailor confirmation.</p></details></div></section>`;
  try{
    const mapData=await fetch('/map-data.json').then(response=>response.ok?response.json():Promise.reject());
    const project=(lat,lng)=>[(lng+9)*40,(61-lat)*52];
    const [x,y]=project(event.lat,event.lng);
    $('#map-wrap').innerHTML=`<svg class="map-svg" viewBox="0 30 480 600" role="img" aria-label="Map showing the Mirari event in London"><defs><linearGradient id="land" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#784c36"/><stop offset=".45" stop-color="#4c2b24"/><stop offset="1" stop-color="#2a1716"/></linearGradient></defs><g class="map-camera">${mapData.map(part=>`<path class="${part.name==='United Kingdom'?'map-land':'map-context'}" d="${part.d}"/>`).join('')}<a href="${eventPath(event.id)}" aria-label="View ${esc(event.title)} in London"><g class="map-marker active" transform="translate(${x},${y})"><circle class="halo" r="15"/><circle class="dot" r="5"/><text x="19" y="5">London</text></g></a></g></svg><small class="map-note">LONDON · NATURAL EARTH</small>`;
  }catch{$('#map-wrap').innerHTML='<p class="empty">Explore the London event using the event card.</p>';}
}

function listing(){
  setMetadata('Events · Mirari','/events','Explore upcoming Mirari cultural experiences in London.');
  main.innerHTML=`<section class="page"><div class="page-header"><span class="eyebrow">YOUR NEXT CHAPTER</span><h1>Find your kind of moment.</h1><p>Music, art, celebration and experiences worth stepping out for.</p></div><form class="filters" id="filters" role="search"><label class="field"><span>Search events</span><input name="q" type="search" placeholder="Event or venue" autocomplete="off"></label><label class="field"><span>City</span><select name="city"><option>London</option></select></label><label class="field"><span>Experience</span><select name="category"><option>${esc(events[0].category)}</option></select></label><label class="field"><span>When</span><select name="when"><option>Upcoming</option></select></label></form><p class="count-line" id="result-count" role="status"></p><div class="event-grid" id="event-results"></div></section>`;
  const render=()=>{
    const query=$('#filters').q.value.trim().toLowerCase();
    const matches=events.filter(event=>!query||`${event.title} ${event.venue} ${event.city}`.toLowerCase().includes(query));
    $('#result-count').textContent=`${matches.length} ${matches.length===1?'event':'events'}`;
    $('#event-results').innerHTML=matches.map(card).join('')||'<div class="empty"><h3>No event found.</h3><p>Try another search.</p></div>';
    cleanup();cleanup=reveal();
  };
  $('#filters').addEventListener('input',render);$('#filters').addEventListener('submit',event=>event.preventDefault());render();
}

function detail(event){
  setMetadata(`${event.title} · Mirari`,eventPath(event.id),`${event.title} at ${event.venue}, London on 8 November 2026.`);
  main.innerHTML=`<section class="detail-hero poster-hero"><img src="${esc(event.image)}" alt=""><div><span class="eyebrow">${esc(event.city)} · ${esc(event.category)}</span><h1>${esc(event.title)}</h1></div></section><div class="detail-layout"><div class="detail-copy"><figure class="event-poster"><img src="${esc(event.image)}" alt="Full poster for ${esc(event.title)}" loading="lazy"></figure><div class="facts"><div><b>When</b><span>${date(event.startAt)}<br>${time(event.startAt)}–${time(event.endAt)} · GMT</span></div><div><b>Where</b><span>${esc(event.venue)}<br>Richmond, London</span></div><div><b>Organised by</b><span>Mirari</span></div><div><b>Tickets</b><span>Sold through Ticket Tailor</span></div></div><h2>About this event</h2><p>${esc(event.description)}</p><h2>Programme and highlights</h2><p>${esc(event.lineup)}</p><h2>Getting there</h2><p>${esc(event.venue)}<br>${esc(event.address)}</p><a class="text-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.address)}">Open directions ↗</a><h2>Before booking</h2><p>Ticket Tailor manages ticket selection, payment, confirmation emails and tickets for this event. Review the listing and checkout information before paying.</p><a class="text-link" href="${esc(event.externalBookingUrl)}">Review the Ticket Tailor listing ↗</a></div><aside class="panel booking-panel"><span class="eyebrow">TICKETS AVAILABLE</span><h2>Book securely through Ticket Tailor.</h2><div class="notice">You will continue to the official Ticket Tailor listing to select tickets, review the final total and complete payment.</div><a class="button full" href="${esc(event.externalBookingUrl)}">Book tickets ↗</a><p class="provider-note">Ticket Tailor handles payment, confirmation emails and ticket delivery.</p></aside></div>`;
}

function notFound(){
  setMetadata('Page not found · Mirari',location.pathname,'Return to Mirari and explore upcoming cultural experiences.');
  $('meta[name="robots"]').content='noindex,follow';
  main.innerHTML='<section class="page narrow not-found"><span class="eyebrow">404</span><h1>Page not found.</h1><p>This page is not part of the Mirari public event website.</p><a class="button" href="/">Return home</a></section>';
}

async function route(){
  cleanup();cleanup=()=>{};closeMenu();window.scrollTo({top:0,behavior:'instant'});
  const path=location.pathname.replace(/\/$/,'')||'/';
  if(path==='/')await home();
  else if(path==='/events')listing();
  else if(path.startsWith('/event/')){
    const event=events.find(item=>item.id===decodeURIComponent(path.slice(7)));
    event?detail(event):notFound();
  }else notFound();
  cleanup=reveal();
  if(location.hash)document.getElementById(location.hash.slice(1))?.scrollIntoView({behavior:'instant'});
}

async function navigate(href){
  const url=new URL(href,location.origin);
  history.pushState({},'',url.pathname+url.search+url.hash);
  await route();
}

document.addEventListener('click',event=>{
  const anchor=event.target.closest('a[href]');
  if(!anchor||event.defaultPrevented||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||anchor.target||anchor.hasAttribute('download'))return;
  const url=new URL(anchor.href);
  if(url.origin!==location.origin)return;
  if(url.pathname===location.pathname&&url.hash){const target=document.getElementById(url.hash.slice(1));if(target){event.preventDefault();target.scrollIntoView({behavior:reduced.matches?'instant':'smooth'});closeMenu();return;}}
  event.preventDefault();void navigate(anchor.href);
});
window.addEventListener('popstate',()=>void route());

try{
  events=await fetch('/event-data.json',{cache:'no-store'}).then(response=>{if(!response.ok)throw new Error();return response.json();});
  if(events.length!==1||events[0].id!=='diwali-pahat-london-2026')throw new Error();
  await route();
}catch{
  main.innerHTML='<section class="page narrow"><h1>The event page is temporarily unavailable.</h1><p>Please visit the official Ticket Tailor listing.</p><a class="button" href="https://buytickets.at/mirarievents/2495970">Open Ticket Tailor ↗</a></section>';
}
