// Browser test for the scroll reveal (public/scroll-reveal.js): node tests/scroll-reveal-ui.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const dir = mkdtempSync(path.join(tmpdir(), 'mirari-reveal-'));
const port = 24000 + Math.floor(Math.random() * 10000), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', APP_URL: origin, DATABASE_PATH: path.join(dir, 'reveal.sqlite'), UPLOADS_PATH: path.join(dir, 'uploads'), DEMO_MODE: 'true', NODE_ENV: 'test', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', RESEND_API_KEY: '', EMAIL_FROM: '' },
  stdio: 'ignore',
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ready, 'Server did not start');
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

  // ---- the homepage statement: scrub mode ---------------------------------------------------------------------------
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.waitForTimeout(800);
    const original = await page.evaluate(() => document.querySelector('.scroll-reveal').textContent.replace(/\s+/g, ' ').trim());
    assert.match(original, /^Tradition inspires us\. Creativity connects us\. Community defines us\./, 'The statement keeps its words');
    assert.equal(await page.locator('.scroll-reveal strong').innerText(), 'Community', 'The <strong> word is kept inside the split text');
    const read = () => page.evaluate(() => {
      const block = document.querySelector('.scroll-reveal'), pieces = [...block.querySelectorAll('.scroll-reveal-piece')];
      return { opacity: pieces.map(p => (p.style.opacity === '' ? 1 : Number(p.style.opacity))), blur: pieces[0].style.filter, rotate: block.style.rotate };
    });
    const scrollTo = async (y) => { await page.evaluate(top => window.scrollTo(0, top), Math.max(0, y)); await page.waitForTimeout(450); };
    const top = await page.evaluate(() => document.querySelector('.scroll-reveal').getBoundingClientRect().top + scrollY);
    const vh = viewport.height;

    // Before it is reached: every word faint and blurred, the block tilted.
    await scrollTo(0);
    let s = await read();
    assert.ok(s.opacity.length > 15 && s.opacity.every(o => Math.abs(o - 0.1) < 0.01), 'Every word starts at the base opacity');
    assert.equal(s.blur, 'blur(4px)');
    assert.equal(s.rotate, '3deg');

    // Mid-way: a soft wave, earlier words clearer than later ones, tilt partly gone.
    // (the reveal range depends on the block's height, so walk down the page until the wave is part-way across)
    let found = false;
    for (let y = top - vh; y < top && !found; y += 30) {
      await scrollTo(y);
      s = await read();
      found = s.opacity.some(o => o > 0.9) && s.opacity.some(o => o < 0.5);
    }
    assert.ok(found, 'Part of the text is revealed while the rest waits');
    assert.ok(s.opacity.every((o, i) => i === 0 || o <= s.opacity[i - 1] + 0.001), 'Words reveal in reading order');
    assert.ok(parseFloat(s.rotate) < 3 && parseFloat(s.rotate) > 0, 'The block is part-way to level');

    // Revealed: everything clear and level, with no leftover inline effects.
    await scrollTo(top - vh * 0.08);
    s = await read();
    assert.ok(s.opacity.every(o => o === 1), 'Every word is fully revealed');
    assert.equal(s.blur, '');
    assert.equal(parseFloat(s.rotate), 0);

    // It runs back on the way up (scrub is tied to the scroll position).
    await scrollTo(0);
    s = await read();
    assert.ok(s.opacity.every(o => Math.abs(o - 0.1) < 0.01), 'Scrolling back up hides the words again');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, `The tilted block must not make the page scroll sideways at ${viewport.width}`);
    assert.deepEqual(errors, [], errors.join('; '));
    await page.close();
  }

  // ---- reduced motion: nothing is split or animated ------------------------------------------------------------------
  const calm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await calm.goto(origin); await calm.waitForTimeout(600);
  assert.equal(await calm.locator('.scroll-reveal-piece').count(), 0, 'Under reduced motion the text is left alone');
  assert.match(await calm.locator('.scroll-reveal').innerText(), /^Tradition inspires us\./);
  assert.equal(await calm.locator('.scroll-reveal').evaluate(el => el.style.rotate), '');
  await calm.close();

  // ---- the other options, on a synthetic block -----------------------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.waitForTimeout(500);
  const report = await page.evaluate(async () => {
    const { scrollReveal } = await import('/scroll-reveal.js');
    const lab = document.createElement('div');
    lab.style.cssText = 'position:absolute;top:0;left:0;width:520px;z-index:99;background:#fff;color:#000';
    document.body.append(lab);
    const sample = 'Every word, <b>bold part</b> and line of this sample is split and revealed on its own.';
    const results = {};
    for (const effect of ['fade', 'rise', 'flip', 'scale']) for (const splitBy of ['words', 'chars', 'lines']) {
      const el = document.createElement('p'); el.innerHTML = sample; lab.append(el);
      const text = el.textContent;
      const stop = scrollReveal(el, { effect, splitBy, baseOffset: 12, highlightColor: '#c00', smoothing: 0.3 });
      const pieces = el.querySelectorAll('.scroll-reveal-piece').length;
      const kept = el.textContent === text && el.querySelector('b')?.textContent === 'bold part';
      stop();
      results[`${effect}/${splitBy}`] = { pieces, kept, restored: el.innerHTML === sample && el.style.rotate === '' };
    }
    // enter mode plays once the block is in view and ends fully revealed
    const el = document.createElement('p'); el.textContent = 'Enter mode plays once when the text is in view.'; lab.append(el);
    const stop = scrollReveal(el, { mode: 'enter', duration: 0.3, stagger: 0.02, effect: 'rise' });
    const start = [...el.querySelectorAll('.scroll-reveal-piece')].map(p => p.style.opacity);
    await new Promise(r => setTimeout(r, 1800));
    const end = [...el.querySelectorAll('.scroll-reveal-piece')].map(p => p.style.opacity === '' && p.style.transform === '' && p.style.filter === '');
    stop(); lab.remove();
    return { results, enter: { startedHidden: start.every(o => o !== ''), endedRevealed: end.every(Boolean), rotated: el.style.rotate } };
  });
  for (const [name, r] of Object.entries(report.results)) { assert.ok(r.pieces > 5, `${name} splits the text`); assert.ok(r.kept, `${name} keeps the text and its <b>`); assert.ok(r.restored, `${name} restores the markup when stopped`); }
  assert.ok(report.results['fade/chars'].pieces > report.results['fade/words'].pieces, 'Characters make more steps than words');
  assert.ok(report.enter.startedHidden && report.enter.endedRevealed, 'Enter mode starts hidden and ends fully revealed');
  assert.deepEqual(errors, [], errors.join('; '));
  await page.close();
  console.log('Scroll reveal passed: scrub reveal and tilt follow the scroll and run back, reduced motion is left alone, and every effect, split and enter mode works at 1440px and 390px.');
} finally {
  await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS may still hold the SQLite file briefly; the temp folder is disposable */ }
  await browser?.close();
}
