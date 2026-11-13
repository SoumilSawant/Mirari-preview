// Scroll reveal for text: a plain JavaScript port of React Bits' <ScrollReveal /> (no React, no GSAP).
// Each word (or character, or line) of an element starts faint, blurred and tilted, and clears as the page scrolls ('scrub')
// or plays once when it scrolls into view ('enter'). The element's own markup (a <strong>, a link) is kept.
//
//   <p data-scroll-reveal data-effect="rise" data-split-by="chars">Text to reveal.</p>
//
// Options (as data- attributes, or an object passed to scrollReveal):
//   mode            'scrub' | 'enter'              scrub ties the reveal to the scroll position (default); enter plays it once
//   splitBy         'words' | 'chars' | 'lines'    what each step of the reveal is (default words)
//   effect          'fade' | 'rise' | 'flip' | 'scale'                                (default fade)
//   stagger         number   spacing between pieces; in seconds in enter mode          (default 0.05)
//   duration        number   seconds each piece takes in enter mode                    (default 0.8)
//   smoothing       number   seconds the reveal takes to catch up with the scroll (0 = tied directly)
//   baseOpacity     0..1     opacity before a piece is revealed                        (default 0.1)
//   baseRotation    degrees  tilt of the whole block before it levels out              (default 3)
//   baseOffset      px       how far below its place each piece starts                 (default 0)
//   enableBlur      boolean  start each piece out of focus                              (default true)
//   blurStrength    px       how blurred pieces start                                  (default 4)
//   highlightColor  CSS colour each word lights up to while it is revealed (default none)
// Both scroll ranges are fixed to React Bits' defaults: the words finish and the block levels out when its bottom reaches
// the bottom of the window (or the end of the page, so text near the end still finishes). Under prefers-reduced-motion
// nothing is split or animated and the text simply stands.

const SCRUB_SPAN = 0.5;
const RISE_MASK = 'inset(-1em -1em -0.15em -1em)';

const clamp01 = (value) => Math.min(Math.max(value, 0), 1);
const smooth = (value) => value * value * (3 - 2 * value);
const easeOut = (value) => 1 - Math.pow(1 - value, 3);
const easeBack = (value, overshoot) => { const shifted = value - 1; return 1 + (overshoot + 1) * shifted * shifted * shifted + overshoot * shifted * shifted; };
const glowAt = (t) => (t <= 0 || t >= 1 ? 0 : t < 0.35 ? smooth(t / 0.35) : 1 - smooth((t - 0.35) / 0.65));

// How one piece looks at progress t (0 = hidden, 1 = revealed), the same maths as the React Bits component.
function paintPiece(piece, t, look) {
  let reveal = t, fadeIn = t, motion = '';
  if (look.effect === 'rise') {
    reveal = easeOut(t);
    fadeIn = clamp01(reveal * 1.25);
    if (reveal < 1) {
      motion = look.masked
        ? `translateY(${((1 - reveal) * 100).toFixed(2)}%) translateY(${((1 - reveal) * 0.2).toFixed(3)}em)`
        : `translateY(${((1 - reveal) * 0.8).toFixed(3)}em)`;
    }
  } else if (look.effect === 'flip') {
    reveal = easeBack(t, 1.2);
    fadeIn = clamp01(t * 2);
    if (t < 1) motion = `perspective(6em) rotateX(${((1 - reveal) * 90).toFixed(2)}deg)`;
  } else if (look.effect === 'scale') {
    reveal = easeBack(t, 1.6);
    fadeIn = clamp01(t * 1.6);
    if (t < 1) motion = `scale(${(0.35 + 0.65 * reveal).toFixed(4)})`;
  }
  if (look.highlightColor) fadeIn = Math.max(fadeIn, clamp01(t / 0.35));
  const settle = clamp01(reveal), lift = look.offset * (1 - settle);
  piece.style.opacity = t >= 1 ? '' : (look.baseOpacity + (1 - look.baseOpacity) * fadeIn).toFixed(3);
  piece.style.transform = [lift ? `translateY(${lift.toFixed(2)}px)` : '', motion].filter(Boolean).join(' ');
  piece.style.filter = look.blur && settle < 1 ? `blur(${(look.blur * (1 - settle)).toFixed(2)}px)` : '';
  if (look.highlightColor) {
    const glow = glowAt(t);
    piece.style.color = glow > 0.002 ? `color-mix(in srgb, ${look.highlightColor} ${(glow * 100).toFixed(1)}%, currentColor)` : '';
  }
}

// Wraps every word (and, for 'chars', every character) of the element's text, keeping elements like <strong> in place.
function split(root, splitBy) {
  const wrappers = [], pieces = [];
  const make = (cls, text) => { const span = document.createElement('span'); span.className = cls; if (text !== undefined) span.textContent = text; return span; };
  const walk = (node) => {
    [...node.childNodes].forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        const fragment = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach(part => {
          if (part === '') return;
          if (part.trim() === '') { fragment.append(part); return; }
          const wrapper = make('scroll-reveal-word');
          if (splitBy === 'chars') for (const char of Array.from(part)) { const piece = make('scroll-reveal-piece', char); wrapper.append(piece); pieces.push(piece); }
          else { const piece = make('scroll-reveal-piece', part); wrapper.append(piece); pieces.push(piece); }
          wrappers.push(wrapper); fragment.append(wrapper);
        });
        child.replaceWith(fragment);
      } else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
    });
  };
  walk(root);
  return { wrappers, pieces };
}

function start(el, options) {
  const { mode, splitBy, effect, stagger, duration, smoothing, baseOpacity, baseRotation, baseOffset, enableBlur, blurStrength, highlightColor } = options;
  const original = el.innerHTML;
  const { wrappers, pieces } = split(el, splitBy);
  if (!pieces.length) return () => {};
  el.classList.toggle('is-plain', effect === 'fade' && !baseOffset);   // opacity and blur work on inline text; only the other effects need inline-block
  const look = { effect, masked: effect === 'rise', baseOpacity, blur: enableBlur ? blurStrength : 0, offset: baseOffset, highlightColor };
  const span = mode === 'enter' ? Math.max(0.05, duration) : SCRUB_SPAN, gap = Math.max(0, stagger);
  const order = pieces.map((_, index) => index), last = pieces.map(() => -1);
  let count = pieces.length, progress = 0, shownRotation = null, docTop = 0, height = 0, raf = 0, disposed = false, played = false;

  // 'lines' groups the words of each rendered line, so it measures where each word wrapped
  const measure = () => {
    if (splitBy !== 'lines') return;
    let line = -1, top = -Infinity;
    wrappers.forEach((wrapper, index) => { const next = wrapper.offsetTop; if (Math.abs(next - top) > 2) { line += 1; top = next; } order[index] = line; });
    count = line + 1;
  };
  const total = () => span + Math.max(0, count - 1) * gap;
  const render = () => {
    const at = progress * total();
    pieces.forEach((piece, index) => {
      const t = clamp01((at - order[index] * gap) / span);
      if (t === last[index]) return;
      last[index] = t;
      paintPiece(piece, t, look);
    });
  };
  const rotate = (degrees) => { const next = degrees.toFixed(3); if (next !== shownRotation) { shownRotation = next; el.style.rotate = `${next}deg`; } };

  pieces.forEach(piece => {
    piece.style.willChange = pieces.length > 80 ? '' : effect === 'fade' && !baseOffset ? 'opacity' : 'opacity, transform';
    piece.style.transformOrigin = effect === 'flip' ? '50% 100%' : '';
  });
  if (look.masked) wrappers.forEach(wrapper => { wrapper.style.clipPath = RISE_MASK; });
  if (baseRotation) el.style.transformOrigin = '0% 100%';   // React Bits tilts about the left middle; the bottom-left corner keeps every word on the left line
  measure(); render();
  if (baseRotation) rotate(baseRotation);

  // Where the element sits in the page, measured with its tilt removed so the tilt cannot feed back into the measurement.
  const place = () => {
    const tilt = el.style.rotate; el.style.rotate = '0deg';
    docTop = el.getBoundingClientRect().top + window.scrollY; height = el.offsetHeight;
    el.style.rotate = tilt;
  };
  const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

  let target = 0, targetRotation = 1, lastTime = 0;
  const aim = () => {
    const vh = window.innerHeight, y = window.scrollY;
    const wordsStart = docTop - (vh - 0.2 * Math.min(height, vh));
    const end = Math.max(Math.min(docTop + height - vh, maxScroll()), wordsStart + 1);   // 'bottom bottom', clamped to the end of the page
    const levelStart = docTop - vh, levelEnd = Math.max(end, levelStart + 1);
    target = clamp01((y - wordsStart) / (end - wordsStart));
    targetRotation = clamp01((y - levelStart) / (levelEnd - levelStart));
  };
  const apply = (p, r) => { progress = p; render(); if (baseRotation) rotate(baseRotation * (1 - r)); };

  let shown = { p: 0, r: 0 };
  function frame(now) {
    raf = 0;
    if (disposed) return;
    const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0.016; lastTime = now;
    if (smoothing > 0) {
      const k = 1 - Math.exp(-dt / (smoothing / 3));
      shown = { p: shown.p + (target - shown.p) * k, r: shown.r + (targetRotation - shown.r) * k };
      if (Math.abs(target - shown.p) < 0.0005 && Math.abs(targetRotation - shown.r) < 0.0005) shown = { p: target, r: targetRotation };
      else raf = requestAnimationFrame(frame);
    } else shown = { p: target, r: targetRotation };
    apply(shown.p, shown.r);
  }
  const schedule = () => { if (!raf && !disposed) { lastTime = 0; raf = requestAnimationFrame(frame); } };

  // enter mode: wait until the text has scrolled into view, then play once
  function playOnce() {
    if (played) return;
    played = true;
    const began = performance.now(), length = total() * 1000, levelFor = Math.min(total(), 1.4) * 1000;
    const tick = (now) => {
      if (disposed) return;
      const elapsed = now - began;
      apply(clamp01(elapsed / length), easeOut(clamp01(elapsed / levelFor)));
      if (elapsed < Math.max(length, levelFor)) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const check = () => {
    place();
    if (mode === 'enter') {
      const vh = window.innerHeight;
      if (docTop - window.scrollY <= vh - 0.2 * Math.min(height, vh) || window.scrollY >= maxScroll() - 1) playOnce();
    } else { aim(); schedule(); }
  };
  const onScroll = () => { if (mode === 'enter') check(); else { aim(); schedule(); } };
  const onResize = () => { measure(); last.fill(-1); check(); };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  // late layout changes (fonts, images) move the element, so re-measure when the page's height changes
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (splitBy === 'lines') { measure(); last.fill(-1); render(); } check(); }) : null;
  observer?.observe(el); observer?.observe(document.documentElement);
  if (document.fonts?.ready) document.fonts.ready.then(() => { if (!disposed) onResize(); });
  check();
  if (mode !== 'enter') { shown = { p: target, r: targetRotation }; apply(shown.p, shown.r); }

  return () => {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onResize); observer?.disconnect();
    el.innerHTML = original; el.style.rotate = ''; el.style.transformOrigin = ''; el.classList.remove('is-plain');
  };
}

/** Applies the reveal to one element and returns a function that undoes it. */
export function scrollReveal(el, userOptions = {}) {
  const options = { mode: 'scrub', splitBy: 'words', effect: 'fade', stagger: 0.05, duration: 0.8, smoothing: 0, baseOpacity: 0.1, baseRotation: 3, baseOffset: 0, enableBlur: true, blurStrength: 4, highlightColor: '', ...userOptions };
  const quiet = window.matchMedia('(prefers-reduced-motion: reduce)');
  let stop = null;
  const sync = () => { if (quiet.matches) { stop?.(); stop = null; } else if (!stop) stop = start(el, options); };
  quiet.addEventListener?.('change', sync);
  sync();
  return () => { quiet.removeEventListener?.('change', sync); stop?.(); stop = null; };
}

const fromData = (el) => {
  const d = el.dataset, number = (value) => (value === undefined || value === '' || Number.isNaN(Number(value)) ? undefined : Number(value));
  const pick = { mode: d.mode, splitBy: d.splitBy, effect: d.effect, stagger: number(d.stagger), duration: number(d.duration), smoothing: number(d.smoothing), baseOpacity: number(d.baseOpacity), baseRotation: number(d.baseRotation), baseOffset: number(d.baseOffset), blurStrength: number(d.blurStrength), highlightColor: d.highlightColor, enableBlur: d.enableBlur === undefined ? undefined : d.enableBlur !== 'false' };
  return Object.fromEntries(Object.entries(pick).filter(([, value]) => value !== undefined && value !== ''));
};
document.querySelectorAll('[data-scroll-reveal]').forEach(el => scrollReveal(el, fromData(el)));
