// Spotlight cards: a soft glow follows the pointer across a card and lights its nearest edge.
// Works on any card matching SELECTOR, including ones rendered later, through one delegated listener.
// Fine pointers only, and nothing moves under prefers-reduced-motion.
const SELECTOR = '.box, .tile, .faq__item, .callout';
const TONES = ['gold', 'ember', 'copper'];
const fine = matchMedia('(hover: hover) and (pointer: fine)');
const calm = matchMedia('(prefers-reduced-motion: reduce)');

if (fine.matches && !calm.matches) {
  const state = new Map();            // card -> { x, y, tx, ty, o, to, fx }
  let raf = 0;

  const make = (card) => {
    const fx = document.createElement('span');
    fx.className = 'spot-fx';
    fx.setAttribute('aria-hidden', 'true');
    // event tiles are a photo with text under it, so the light lives on the photo's rounded frame
    const host = card.matches('.tile') ? (card.querySelector('.tile__media') || card) : card;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const index = [...card.parentElement.children].filter(n => n.matches(SELECTOR)).indexOf(card);
    fx.dataset.tone = TONES[Math.max(0, index) % TONES.length];
    host.append(fx);
    const s = { x: 0, y: 0, tx: 0, ty: 0, o: 0, to: 0, fx, host, fresh: true };
    state.set(card, s);
    return s;
  };

  const tick = () => {
    raf = 0;
    let busy = false;
    for (const [card, s] of state) {
      if (s.fresh) { s.x = s.tx; s.y = s.ty; s.fresh = false; }   // start where the pointer entered, never sweep in from a corner
      s.x += (s.tx - s.x) * 0.2; s.y += (s.ty - s.y) * 0.2;
      s.o += (s.to - s.o) * 0.12;
      s.fx.style.setProperty('--mx', s.x.toFixed(1) + 'px');
      s.fx.style.setProperty('--my', s.y.toFixed(1) + 'px');
      s.fx.style.opacity = s.o.toFixed(3);
      const moving = Math.abs(s.tx - s.x) > 0.3 || Math.abs(s.ty - s.y) > 0.3 || Math.abs(s.to - s.o) > 0.005;
      if (moving) busy = true;
      else if (s.to === 0) { s.fx.remove(); state.delete(card); }
    }
    if (busy) raf = requestAnimationFrame(tick);
  };
  const wake = () => { if (!raf) raf = requestAnimationFrame(tick); };

  document.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    const card = event.target instanceof Element ? event.target.closest(SELECTOR) : null;
    for (const [other, s] of state) if (other !== card) s.to = 0;
    if (card) {
      const s = state.get(card) || make(card);
      const box = s.host.getBoundingClientRect();
      s.tx = event.clientX - box.left; s.ty = event.clientY - box.top; s.to = 1;
    }
    wake();
  }, { passive: true });
  document.addEventListener('pointerleave', () => { for (const s of state.values()) s.to = 0; wake(); });
}
