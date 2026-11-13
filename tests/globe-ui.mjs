// Browser test for the homepage globe: node tests/globe-ui.mjs. Uses an isolated demo database and software WebGL.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const dir = mkdtempSync(path.join(tmpdir(), 'mirari-globe-'));
const port = 24000 + Math.floor(Math.random() * 10000), origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', APP_URL: origin, DATABASE_PATH: path.join(dir, 'globe.sqlite'), UPLOADS_PATH: path.join(dir, 'uploads'), DEMO_MODE: 'true', NODE_ENV: 'test', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', RESEND_API_KEY: '', EMAIL_FROM: '' },
  stdio: 'ignore',
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  assert.ok(ready, 'Server did not start');
  const events = await (await fetch(`${origin}/api/events`)).json();
  const cities = [...new Set(events.map(e => e.city))];
  assert.ok(cities.length > 1, 'The demo data should have several cities');

  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#atlas').scrollIntoViewIfNeeded();
    await page.locator('.globe-canvas').waitFor();

    // One pin per city, each carrying the location name (not a "live" counter).
    assert.equal(await page.locator('.globe-pin').count(), cities.length);
    assert.deepEqual((await page.locator('.globe-label').allTextContents()).sort(), [...cities].sort(), 'Every city pin needs its location name');
    assert.equal(await page.locator('.globe-wrap').getByText(/live|watching/i).count(), 0, 'The globe must not show live-viewer chips');
    assert.equal(await page.locator('.globe-card.visible, .globe-city.active').count(), 0, 'No city should be open before a click');

    // Pressing a pin opens that city; its events are links to the event pages.
    const london = events.filter(e => e.city === 'London');
    assert.ok(london.length, 'The demo data should have London events');
    // On a phone the pins are display-only (too close for a thumb): the city chips choose the city there.
    if (viewport.width < 640) await page.locator('.chip[data-city="London"]').click();
    else await page.locator('.globe-pin[data-city="London"]').click();
    await page.locator('.globe-city.active .globe-card').waitFor();
    assert.equal(await page.locator('.globe-city.active .globe-pin').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.chip[data-city="London"]').getAttribute('aria-pressed'), 'true', 'The city chips follow the globe');
    const hrefs = await page.locator('.globe-city.active .globe-card a').evaluateAll(anchors => anchors.map(a => a.getAttribute('href')));
    assert.deepEqual(hrefs.sort(), london.map(e => `/event/${e.id}`).sort());

    // Pressing an event goes to its event page.
    await page.locator('.globe-city.active .globe-card a').first().click();
    await page.waitForURL(/\/event\/[^/]+$/);
    await page.locator('#booking-form').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, `Event page overflows at ${viewport.width}`);

    // The chips still drive the globe the other way round.
    await page.goto(origin);
    await page.locator('.chip[data-city="Manchester"]').click();
    await page.locator('.globe-city.active .globe-pin[data-city="Manchester"]').waitFor();
    assert.deepEqual(errors, [], `Page errors at ${viewport.width}: ${errors.join('; ')}`);
    await page.close();
  }

  // Without WebGL the section falls back to the chips and the list.
  const noGl = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await noGl.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/.test(type) ? null : original.call(this, type, ...rest); }; });
  await noGl.goto(origin);
  await noGl.locator('#atlas-panel .rows').waitFor();
  assert.equal(await noGl.locator('#globe-wrap').isHidden(), true);
  assert.equal(await noGl.locator('.chip[data-city]').count(), cities.length + 1);
  await noGl.close();
  console.log('Globe pins, location names, event links and the no-WebGL fallback passed at 1440px and 390px.');
} finally {
  await browser?.close();
  await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS may still hold the SQLite file briefly; the temp folder is disposable */ }
}
