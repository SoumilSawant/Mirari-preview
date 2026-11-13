// Interactive 3D globe for the "Events by city" section: COBE (WebGL, ~5KB, served from /vendor/cobe.js).
//
// The globe always stays whole. Cities in one country sit only a few pixels apart on a sphere, so their names cannot
// be written on it. Instead:
//   - the globe shows one badge per region ("5 cities - 6 events")
//   - pressing the badge turns the globe so the region faces the right-hand side and fans the city names out into a
//     tidy column beside it, each name joined to its pin on the globe by a thin curved leader line
//   - pressing a name opens that city's events as links to their event pages
// A column cannot overlap however many cities there are (it scrolls when long). Plain JavaScript port of the
// cobe-globe-live component.
import createGlobe from '/vendor/cobe.js';

const DEG = Math.PI / 180, TAU = Math.PI * 2;
const GOLD = [0.85, 0.71, 0.46], GOLD_BRIGHT = [1, 0.88, 0.58];
const REGION_KM = 600;           // cities closer than this share a region badge
const EARTH_KM = 6371;
const FACE_RIGHT = 28;           // degrees: an open region is turned this far east of centre, towards the callout column
const SVG = 'http://www.w3.org/2000/svg';
// cobe centres longitude (-90deg - phi) and latitude (theta).
const viewOf = (lat, lng) => ({ phi: -(lng + 90) * DEG, theta: lat * DEG });
const wrap = (delta) => ((delta % TAU) + TAU + Math.PI) % TAU - Math.PI;
const km = (a, b) => {
  const dLat = (b.lat - a.lat) * DEG, dLng = (b.lng - a.lng) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function globeSupported() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    return Boolean(gl) && CSS.supports('position-anchor', '--a');   // the region badges use CSS anchor positioning
  } catch { return false; }
}

/** Groups cities that are close together into regions, each with a centre. */
function buildRegions(cities) {
  const parent = cities.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  cities.forEach((a, i) => cities.forEach((b, j) => { if (j > i && km(a, b) < REGION_KM) parent[find(j)] = find(i); }));
  const groups = new Map();
  cities.forEach((c, i) => { const r = find(i); groups.set(r, [...(groups.get(r) || []), c]); });
  return [...groups.values()].map((members, index) => ({
    id: `c${index}`, members,
    lat: members.reduce((n, c) => n + c.lat, 0) / members.length,
    lng: members.reduce((n, c) => n + c.lng, 0) / members.length,
    events: members.reduce((n, c) => n + c.events.length, 0),
  }));
}
const regionText = (r) => (r.members.length === 1 ? `${r.members[0].name} · ${plural(r.events, 'event', 'events')}` : `${plural(r.members.length, 'city', 'cities')} · ${plural(r.events, 'event', 'events')}`);

/**
 * @param {HTMLElement} host      empty element the globe is built in
 * @param {{name:string,lat:number,lng:number,events:{href:string,title:string,meta:string}[]}[]} cities
 * @param {{stage:HTMLElement, callouts:HTMLElement, onSelect:(name:string)=>void, onRegion:(names:string[])=>void, onZoomOut:()=>void, reduced:boolean}} options
 *   stage: the element holding the globe and the callout column; callouts: the empty column the city names are built in.
 *   Callbacks fire only for the visitor's own actions; the returned methods change the view silently.
 */
export function mountGlobe(host, cities, { stage, callouts, onSelect, onRegion, onZoomOut, reduced }) {
  const regions = buildRegions(cities);
  const regionOf = (name) => regions.findIndex(r => r.members.some(c => c.name === name));
  const anchored = (id) => `position-anchor:--cobe-${id};scale:var(--cobe-visible-${id},0)`;

  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Globe of event locations. Press a region badge to list its cities.');
  host.innerHTML = '<canvas class="globe-canvas" aria-hidden="true"></canvas>'
    + regions.map((r, i) => `<button type="button" class="globe-cluster" data-region="${i}" aria-pressed="false" style="${anchored(r.id)}" aria-label="List the cities of ${esc(regionText(r))}">${esc(regionText(r))}</button>`).join('');
  const canvas = host.querySelector('.globe-canvas');

  // The leader lines are one SVG laid over the stage, so they can run from the globe's pins to the column's names.
  const leaders = document.createElementNS(SVG, 'svg');
  leaders.setAttribute('class', 'globe-leaders'); leaders.setAttribute('aria-hidden', 'true');
  stage.append(leaders);

  // ---- the globe: whole, turning to face the open region ----------------------------------------------------------------
  const mean = (k) => cities.reduce((n, c) => n + c[k], 0) / (cities.length || 1);
  const world = { ...viewOf(cities.length ? mean('lat') : 53, cities.length ? mean('lng') : -2), scale: 1.15 };
  const state = { phi: world.phi - (reduced ? 0 : 1.1), theta: world.theta, scale: reduced ? world.scale : 0.9 };
  const target = { ...world };
  let level = 'world', region = null, active = '', globe = null, frame = 0, dragging = null, last = '', swayPhase = 0, warmup = 240;

  const markers = () => regions.flatMap((r, i) => (level !== 'world' && i === region
    ? r.members.map(c => ({ id: `m${cities.indexOf(c)}`, location: [c.lat, c.lng], size: c.name === active ? 0.026 : 0.014, color: c.name === active ? GOLD_BRIGHT : GOLD }))
    : [{ id: r.id, location: [r.lat, r.lng], size: 0.035, color: GOLD }]));

  // Where a city is drawn on the globe, in the host's pixels (cobe's projection: disc radius 0.4 * scale * width).
  function project(c) {
    const lat = c.lat * DEG, lon = (c.lng + 90) * DEG, x = Math.cos(lat) * Math.sin(lon), y = Math.sin(lat), z = Math.cos(lat) * Math.cos(lon);
    const cp = Math.cos(state.phi), sp = Math.sin(state.phi), ct = Math.cos(state.theta), st = Math.sin(state.theta), w = host.clientWidth, k = 0.4 * state.scale;
    return { x: (0.5 + k * (cp * x + sp * z)) * w, y: (0.5 - k * (sp * st * x + ct * y - cp * st * z)) * w, front: -sp * ct * x + st * y + cp * ct * z > 0.05 };
  }

  function draw() {
    // a slow sway while no region is open keeps the sphere visibly 3D without losing the region
    const idle = !reduced && level === 'world' && !dragging;
    if (idle) swayPhase += 0.004;
    const sway = idle ? Math.sin(swayPhase) * 0.14 : 0;
    const gap = Math.log(target.scale) - Math.log(state.scale);
    if (Math.abs(wrap(target.phi - state.phi)) > 0.0004 || Math.abs(target.theta - state.theta) > 0.0004 || Math.abs(gap) > 0.002 || dragging) {
      const ease = reduced ? 1 : 0.075;
      state.phi += wrap(target.phi - state.phi) * ease;
      state.theta += (target.theta - state.theta) * ease;
      state.scale = Math.exp(Math.log(state.scale) + gap * ease);
    }
    // cobe loads its dotted map asynchronously and only paints on update(), so keep painting for the first seconds even when nothing moves
    if (warmup-- > 0) last = '';
    const key = `${state.phi.toFixed(4)}|${sway.toFixed(4)}|${state.theta.toFixed(4)}|${state.scale.toFixed(3)}|${region}|${active}`;
    if (key !== last) { last = key; globe.update({ phi: state.phi + sway, theta: state.theta, scale: state.scale, markers: markers() }); }
    if (level !== 'world') drawLeaders();   // the column and the stage resize while the map opens, so the lines follow every frame
    frame = requestAnimationFrame(draw);
  }

  function init() {
    const width = canvas.offsetWidth;
    if (!width || globe) return;
    globe = createGlobe(canvas, {
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2), width, height: width,
      phi: state.phi, theta: state.theta, scale: state.scale, dark: 0.92, diffuse: 1.9,
      mapSamples: 30000, mapBrightness: 2.8, baseColor: [0.72, 0.5, 0.34], markerColor: GOLD, glowColor: [0.6, 0.22, 0.2],
      markerElevation: 0.012, markers: markers(), opacity: 0.95,
    });
    requestAnimationFrame(() => { canvas.style.opacity = '1'; });
    draw();
  }
  if (canvas.offsetWidth > 0) init();
  else { const ro = new ResizeObserver(() => { if (canvas.offsetWidth > 0) { ro.disconnect(); init(); } }); ro.observe(canvas); }
  const resizeGlobe = new ResizeObserver(() => { if (globe && canvas.offsetWidth) { globe.update({ width: canvas.offsetWidth, height: canvas.offsetWidth }); last = ''; } });
  resizeGlobe.observe(canvas);

  // Drag to turn the globe; the eased follow in draw() gives it weight.
  canvas.addEventListener('pointerdown', e => {
    dragging = { x: e.clientX, y: e.clientY, phi: target.phi, theta: target.theta };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    target.phi = dragging.phi + (e.clientX - dragging.x) / 260;
    target.theta = Math.max(-1.2, Math.min(1.2, dragging.theta + (e.clientY - dragging.y) / 520));
  });
  const release = () => { dragging = null; canvas.style.cursor = ''; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  // ---- the callout column and its leader lines -------------------------------------------------------------------------
  let calloutRegion = null, list = null;

  function buildCallouts(index) {
    calloutRegion = index;
    const r = regions[index], members = [...r.members].sort((a, b) => b.lat - a.lat);   // north to south keeps the lines from crossing
    callouts.setAttribute('role', 'group');
    callouts.setAttribute('aria-label', `Cities in ${regionText(r)}`);
    callouts.innerHTML = `<div class="callouts__bar"><span class="callouts__title">${esc(regionText(r))}</span><button type="button" class="callouts__close" aria-label="Close the city list">&times;</button></div>
      <ul class="callouts__list">${members.map(c => `
        <li class="callout" data-city="${esc(c.name)}">
          <button type="button" class="callout__head" aria-expanded="false"><span class="callout__name">${esc(c.name)}</span><span class="callout__count">${esc(plural(c.events.length, 'event', 'events'))}</span></button>
          <ul class="callout__events">${c.events.map(e => `<li><a href="${e.href}"><strong>${esc(e.title)}</strong><span>${esc(e.meta)}</span></a></li>`).join('')}</ul>
        </li>`).join('')}</ul>`;
    list = callouts.querySelector('.callouts__list');
    leaders.replaceChildren(...members.map(c => {
      const g = document.createElementNS(SVG, 'g'); g.setAttribute('class', 'leader'); g.dataset.city = c.name;
      g.innerHTML = '<path></path><circle class="ring" r="9"></circle><circle class="dot" r="3.2"></circle>';
      return g;
    }));
    list.addEventListener('scroll', drawLeaders, { passive: true });
  }
  function destroyCallouts() { callouts.innerHTML = ''; leaders.replaceChildren(); calloutRegion = null; list = null; }

  // Draws each leader from its pin on the globe to the left edge of its name, as a smooth S-curve.
  function drawLeaders() {
    if (!list) return;
    const s = stage.getBoundingClientRect(), h = host.getBoundingClientRect(), l = list.getBoundingClientRect(), scale = h.width / (host.clientWidth || h.width);
    for (const g of leaders.children) {
      const c = cities.find(x => x.name === g.dataset.city), head = list.querySelector(`.callout[data-city="${CSS.escape(c.name)}"] .callout__head`).getBoundingClientRect();
      const p = project(c), px = h.left - s.left + p.x * scale, py = h.top - s.top + p.y * scale;
      const lx = head.left - s.left, ly = head.top + head.height / 2 - s.top;
      const shown = p.front && ly > l.top - s.top + 6 && ly < l.bottom - s.top - 6 && lx > px;
      const bend = Math.max(24, (lx - px) * 0.55);
      g.firstChild.setAttribute('d', `M${px.toFixed(1)},${py.toFixed(1)} C${(px + bend).toFixed(1)},${py.toFixed(1)} ${(lx - bend).toFixed(1)},${ly.toFixed(1)} ${lx.toFixed(1)},${ly.toFixed(1)}`);
      for (const dot of g.querySelectorAll('circle')) { dot.setAttribute('cx', px.toFixed(1)); dot.setAttribute('cy', py.toFixed(1)); }
      g.classList.toggle('off', !shown);
    }
  }

  // ---- state ------------------------------------------------------------------------------------------------------------
  function applyLevel() {
    stage.classList.toggle('has-callouts', level !== 'world');
    host.querySelectorAll('.globe-cluster').forEach((b, i) => { const open = level !== 'world' && i === region; b.classList.toggle('is-open', open); b.setAttribute('aria-pressed', String(open)); });
    callouts.querySelectorAll('.callout').forEach(el => {
      const on = level === 'city' && el.dataset.city === active;
      el.classList.toggle('active', on);
      el.querySelector('.callout__head').setAttribute('aria-expanded', String(on));
    });
    leaders.querySelectorAll('.leader').forEach(g => g.classList.toggle('active', level === 'city' && g.dataset.city === active));
    last = '';
  }
  // an open region is turned a little east of centre so its pins sit on the side of the globe facing the column
  const faceRight = (lat, lng) => viewOf(lat, lng - FACE_RIGHT);
  function setWorld() { level = 'world'; region = null; active = ''; Object.assign(target, world); applyLevel(); destroyCallouts(); }
  function setRegion(index) {
    level = 'region'; region = index; active = '';
    Object.assign(target, faceRight(regions[index].lat, regions[index].lng), { scale: world.scale });
    if (calloutRegion !== index) buildCallouts(index);
    applyLevel();
  }
  function setCity(name) {
    const index = regionOf(name), city = cities.find(c => c.name === name);
    if (index < 0 || !city) return setWorld();
    level = 'city'; region = index; active = name;
    Object.assign(target, faceRight(city.lat, city.lng), { scale: world.scale });
    if (calloutRegion !== index) buildCallouts(index);
    applyLevel();
  }
  const names = (i) => regions[i].members.map(c => c.name);
  // one step back: open city -> region list -> whole globe
  const stepOut = () => {
    if (level === 'city') { setRegion(region); onRegion?.(names(region)); }
    else if (level === 'region') { setWorld(); onZoomOut?.(); }
  };

  // ---- input ------------------------------------------------------------------------------------------------------------
  host.addEventListener('click', e => {
    const badge = e.target.closest('.globe-cluster');
    if (!badge) return;
    const i = Number(badge.dataset.region);
    setRegion(i); onRegion?.(names(i));
  });
  callouts.addEventListener('click', e => {
    if (e.target.closest('.callouts__close')) { setWorld(); onZoomOut?.(); return; }
    const head = e.target.closest('.callout__head');
    if (!head) return;
    const name = head.closest('.callout').dataset.city;
    if (level === 'city' && active === name) { stepOut(); return; }   // pressing the open name closes it
    setCity(name); onSelect?.(name);
  });
  // hovering a name lights its leader line
  callouts.addEventListener('pointerover', e => { const el = e.target.closest('.callout'); leaders.querySelector(`.leader[data-city="${CSS.escape(el?.dataset.city || '')}"]`)?.classList.add('hot'); });
  callouts.addEventListener('pointerout', e => { const el = e.target.closest('.callout'); leaders.querySelector(`.leader[data-city="${CSS.escape(el?.dataset.city || '')}"]`)?.classList.remove('hot'); });
  callouts.addEventListener('focusin', e => { const el = e.target.closest('.callout'); leaders.querySelector(`.leader[data-city="${CSS.escape(el?.dataset.city || '')}"]`)?.classList.add('hot'); });
  callouts.addEventListener('focusout', e => { const el = e.target.closest('.callout'); leaders.querySelector(`.leader[data-city="${CSS.escape(el?.dataset.city || '')}"]`)?.classList.remove('hot'); });
  stage.addEventListener('keydown', e => { if (e.key === 'Escape' && level !== 'world') { e.stopPropagation(); stepOut(); } });

  applyLevel();
  return {
    focusCity: setCity,
    focusWorld: setWorld,
    destroy() { cancelAnimationFrame(frame); resizeGlobe.disconnect(); globe?.destroy(); },
  };
}
