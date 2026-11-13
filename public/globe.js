// Interactive globe for the "Events by city" section: COBE (WebGL, ~5KB, served from /vendor/cobe.js)
// with one clickable pin per event city. Each pin shows the location name; the selected city opens a card
// whose event titles link to their event pages. Plain JavaScript port of the cobe-globe-live component:
// the "LIVE" viewer chips are replaced by location names, and the pins are real buttons and links.
import createGlobe from '/vendor/cobe.js';

const DEG = Math.PI / 180, TAU = Math.PI * 2;
const GOLD = [0.85, 0.71, 0.46];
// cobe centres longitude (-90deg - phi) and latitude (theta); the zoom is its `scale` option.
const viewOf = (lat, lng) => ({ phi: -(lng + 90) * DEG, theta: lat * DEG });
const wrap = (delta) => ((delta % TAU) + TAU + Math.PI) % TAU - Math.PI;

export function globeSupported() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    return Boolean(gl) && CSS.supports('position-anchor', '--a');   // labels use CSS anchor positioning
  } catch { return false; }
}

/**
 * @param {HTMLElement} host   empty element the globe is built in
 * @param {{name:string,lat:number,lng:number,events:{href:string,title:string,meta:string}[]}[]} cities
 * @param {{onSelect:(name:string)=>void, reduced:boolean}} options
 */
export function mountGlobe(host, cities, { onSelect, reduced }) {
  const ids = new Map(cities.map((c, i) => [c.name, `g${i}`]));
  // Each name label sits on the side of its pin that faces away from the other cities (west of the centre: left).
  const centreLng = cities.reduce((n, c) => n + c.lng, 0) / (cities.length || 1);
  const sides = new Map(cities.map(c => [c.name, c.lng < centreLng ? 'left' : 'right']));
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Globe of cities with events. Choose a city pin to see its events.');
  host.innerHTML = '<canvas class="globe-canvas" aria-hidden="true"></canvas>' + cities.map(c => {
    const id = ids.get(c.name);
    return `<div class="globe-city" data-id="${id}" style="position-anchor:--cobe-${id};scale:var(--cobe-visible-${id},0)">
      <button type="button" class="globe-pin" data-city="${escapeHtml(c.name)}" aria-pressed="false" aria-label="Show events in ${escapeHtml(c.name)}"></button>
      <div class="globe-card"><p class="globe-card__name">${escapeHtml(c.name)}</p><ul class="globe-card__events">${c.events.map(e => `<li><a href="${e.href}"><strong>${escapeHtml(e.title)}</strong><span>${escapeHtml(e.meta)}</span></a></li>`).join('')}</ul></div>
    </div>`;
  }).join('') + cities.map(c => {
    const id = ids.get(c.name);
    return `<div class="globe-label globe-label--${sides.get(c.name)}" data-id="${id}" aria-hidden="true" style="position-anchor:--cobe-${id};scale:var(--cobe-visible-${id},0)">${escapeHtml(c.name)}</div>`;
  }).join('');
  const canvas = host.querySelector('canvas');

  // The overview centres on the cities themselves; a selected city zooms in on its own pin.
  const mean = (k) => cities.reduce((n, c) => n + c[k], 0) / (cities.length || 1);
  const overview = { ...viewOf(cities.length ? mean('lat') : 53, cities.length ? mean('lng') : -2), scale: 6 };
  const state = { phi: overview.phi - (reduced ? 0 : 1.1), theta: overview.theta, scale: reduced ? overview.scale : 1.6 };
  const target = { ...overview };
  let active = '', globe = null, frame = 0, dragging = null, last = '';

  const markers = () => cities.map(c => ({
    id: ids.get(c.name), location: [c.lat, c.lng],
    size: c.name === active ? 0.014 : 0.009, color: c.name === active ? [1, 0.88, 0.58] : GOLD,
  }));

  function draw() {
    const moving = Math.abs(wrap(target.phi - state.phi)) > 0.0004 || Math.abs(target.theta - state.theta) > 0.0004
      || Math.abs(target.scale - state.scale) > 0.002 || dragging;
    if (moving) {
      const ease = reduced ? 1 : 0.075;
      state.phi += wrap(target.phi - state.phi) * ease;
      state.theta += (target.theta - state.theta) * ease;
      state.scale += (target.scale - state.scale) * ease;
    }
    const key = `${state.phi.toFixed(4)}|${state.theta.toFixed(4)}|${state.scale.toFixed(3)}|${active}`;
    if (key !== last) {
      last = key;
      globe.update({ phi: state.phi, theta: state.theta, scale: state.scale, markers: markers() });
      keepCardOnscreen();
    }
    frame = requestAnimationFrame(draw);
  }

  // The open card flips to the side with room when its pin is near the globe's edge.
  function keepCardOnscreen() {
    const id = active && ids.get(active), el = id && host.querySelector(`.globe-city[data-id="${id}"]`);
    if (!el) return;
    const anchor = host.querySelector(`div[style*="--cobe-${id}"]`), x = anchor ? parseFloat(anchor.style.left) : 50;
    el.classList.toggle('globe-city--left', x > 62);
    el.classList.toggle('globe-city--right', x < 38);
  }

  function init() {
    const width = canvas.offsetWidth;
    if (!width || globe) return;
    globe = createGlobe(canvas, {
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2), width, height: width,
      phi: state.phi, theta: state.theta, scale: state.scale, dark: 1, diffuse: 1.4,
      mapSamples: 50000, mapBrightness: 2.6, baseColor: [0.62, 0.42, 0.3], markerColor: GOLD, glowColor: [0.35, 0.12, 0.14],
      markerElevation: 0.01, markers: markers(), opacity: 0.95,
    });
    requestAnimationFrame(() => { canvas.style.opacity = '1'; });
    draw();
  }
  if (canvas.offsetWidth > 0) init();
  else { const ro = new ResizeObserver(() => { if (canvas.offsetWidth > 0) { ro.disconnect(); init(); } }); ro.observe(canvas); }
  const resize = new ResizeObserver(() => { if (globe && canvas.offsetWidth) globe.update({ width: canvas.offsetWidth, height: canvas.offsetWidth }); });
  resize.observe(canvas);

  // Drag to turn the globe; the eased follow in draw() gives it weight.
  canvas.addEventListener('pointerdown', e => {
    dragging = { x: e.clientX, y: e.clientY, phi: target.phi, theta: target.theta };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const k = 1 / state.scale;
    target.phi = dragging.phi + (e.clientX - dragging.x) / 260 * k;
    target.theta = Math.max(-1.2, Math.min(1.2, dragging.theta + (e.clientY - dragging.y) / 520 * k));
  });
  const release = () => { dragging = null; canvas.style.cursor = ''; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  host.addEventListener('click', e => {
    const pin = e.target.closest('.globe-pin');
    if (pin) onSelect(pin.dataset.city);
  });

  return {
    focus(name) {
      const city = cities.find(c => c.name === name);
      active = city ? city.name : '';
      Object.assign(target, city ? { ...viewOf(city.lat, city.lng), scale: 8 } : overview);
      host.querySelectorAll('.globe-city').forEach(el => {
        const on = ids.get(name) === el.dataset.id;
        el.classList.toggle('active', on);
        el.querySelector('.globe-pin').setAttribute('aria-pressed', String(on));
      });
      host.querySelectorAll('.globe-label').forEach(el => el.classList.toggle('active', ids.get(name) === el.dataset.id));
      last = '';
    },
    destroy() { cancelAnimationFrame(frame); resize.disconnect(); globe?.destroy(); },
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
