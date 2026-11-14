// The "booking confirmed" ticket shown at the top of a paid order: an animated card plus a one-off confetti burst.
// Pure DOM; app.js passes in its own formatters so the wording and currency stay in one place.
const NS = 'http://www.w3.org/2000/svg';
const CONFETTI = ['#d9b576', '#faf1e5', '#c9475a', '#7a1f2b', '#e8cf9f'];

export function confirmation(order, { demo, live, money, date, time, esc, reduced }) {
  const kind = demo ? 'demo' : live ? 'live' : 'test';
  const tickets = order.tickets?.length || order.items.reduce((n, i) => n + i.quantity, 0);
  const lines = order.items.map(i => `${i.quantity} × ${i.name}`).join(' · ');
  const sub = kind === 'live' ? 'Your tickets have been issued successfully' : kind === 'demo' ? 'Your demo tickets have been issued' : 'Your test tickets have been issued';
  const bars = Array.from({ length: 56 }, (_, i) => {
    const seed = (order.id.charCodeAt(i % order.id.length) * (i + 7)) % 5;
    return `<i style="--i:${i};--w:${1 + (seed % 3)}px"></i>`;
  }).join('');

  const el = document.createElement('section');
  el.className = 'confirm';
  el.setAttribute('aria-labelledby', 'confirm-title');
  el.innerHTML = `
    <div class="confirm__card">
      <span class="confirm__tick" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
          <circle class="confirm__ring" cx="32" cy="32" r="26" pathLength="1"/>
          <path class="confirm__check" d="M21 33l8 8 15-17" pathLength="1"/>
        </svg>
      </span>
      <h2 id="confirm-title" class="confirm__title">Thank you!</h2>
      <p class="confirm__sub">${esc(sub)}</p>
      <hr class="confirm__rule">
      <dl class="confirm__row">
        <div><dt>Order ID</dt><dd class="confirm__mono">${esc(order.id.slice(0, 8).toUpperCase())}</dd></div>
        <div class="confirm__end"><dt>Amount</dt><dd class="confirm__amount">${money(order.total)}</dd></div>
      </dl>
      <dl class="confirm__row confirm__row--solo">
        <div><dt>Date &amp; time</dt><dd>${date(order.event.startAt)} • ${time(order.event.startAt)} UK</dd></div>
      </dl>
      <div class="confirm__event">
        <span class="confirm__badge" aria-hidden="true">${tickets}</span>
        <div><strong>${esc(order.event.title)}</strong><small>${esc(order.event.venue || order.event.city)} · ${esc(lines)}</small></div>
      </div>
      <div class="confirm__rule confirm__rule--notch" role="presentation"></div>
      <div class="confirm__bars" aria-hidden="true">${bars}</div>
      <p class="confirm__hint"><a href="#tickets">Your QR ticket${tickets === 1 ? ' is' : 's are'} below</a></p>
      ${kind === 'live' ? '' : `<p class="confirm__flag">${kind === 'demo' ? 'Demo' : 'Stripe test'} booking · not valid for real admission</p>`}
    </div>`;

  let played = false;
  const play = () => {
    if (played) return; played = true;
    el.classList.add('is-in');
    let seen = false;
    try { seen = sessionStorage.getItem('confetti:' + order.id) === '1'; sessionStorage.setItem('confetti:' + order.id, '1'); } catch { /* storage blocked: just celebrate */ }
    if (!reduced && !seen) confetti();
  };
  return { el, play };
}

export function confetti(count = 70) {
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    const left = Math.random() * 100;
    p.style.cssText = `left:${left}%;--c:${CONFETTI[i % CONFETTI.length]};--dx:${(Math.random() - .5) * 160}px;--r:${(Math.random() * 720 - 360) | 0}deg;` +
      `--d:${(2.4 + Math.random() * 1.8).toFixed(2)}s;--delay:${(Math.random() * .9).toFixed(2)}s;--w:${6 + (Math.random() * 6 | 0)}px;--h:${10 + (Math.random() * 8 | 0)}px`;
    layer.append(p);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 5200);
}
