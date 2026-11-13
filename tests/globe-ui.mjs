// Browser test for the homepage globe and its callouts: node tests/globe-ui.mjs.
// Uses an isolated demo database and software WebGL.
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
    const wide = viewport.width >= 1024;
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#atlas').scrollIntoViewIfNeeded();
    await page.locator('.globe-canvas').waitFor();

    // Whole globe: one badge for the region instead of a pile of overlapping pins; no zoom, no "live" counters.
    assert.equal(await page.locator('.globe-cluster').count(), 1, 'The demo cities share one region badge');
    assert.match(await page.locator('.globe-cluster').innerText(), new RegExp(`${cities.length} cities · ${events.length} events`));
    assert.equal(await page.locator('.globe-wrap').getByText(/live|watching/i).count(), 0, 'The globe must not show live-viewer chips');
    assert.equal(await page.locator('[data-zoom], .globe-zoom, .globe-controls, .region-map').count(), 0, 'There are no zoom controls or map panel');
    assert.equal(await page.locator('#globe-stage.has-callouts').count(), 0, 'The callouts start closed');
    const globeBefore = await page.locator('.globe-canvas').evaluate(el => el.getBoundingClientRect().width);

    // The badge fans the city names out into a column beside the globe; the globe stays whole.
    await page.locator('.globe-cluster').click();
    await page.locator('#globe-stage.has-callouts').waitFor();
    assert.equal(await page.locator('.callout').count(), cities.length, 'One callout per city');
    assert.deepEqual((await page.locator('.callout__name').allTextContents()).sort(), [...cities].sort());
    assert.equal(await page.locator('#atlas-panel .rows li').count(), events.length, 'The list shows every event of the region');
    assert.ok(await page.locator('.globe-canvas').evaluate(el => el.getBoundingClientRect().width) > 150, 'The globe stays visible');
    await page.waitForTimeout(900);   // let the columns finish moving

    // The names never overlap (they are a column), and on a wide screen the column sits beside the globe, joined by leader lines.
    const heads = await page.locator('.callout__head').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }));
    heads.sort((a, b) => a.top - b.top);
    heads.forEach((h, i) => { if (i) assert.ok(h.top >= heads[i - 1].bottom - 0.5, 'Callout names must not overlap'); });
    const globeBox = await page.locator('.globe-canvas').boundingBox();
    if (wide) {
      assert.ok(heads.every(h => h.left >= globeBox.x + globeBox.width - 4), 'On a wide screen the names sit beside the globe');
      assert.ok(globeBox.width < globeBefore, 'The globe makes room for the column');
      assert.equal(await page.locator('.leader').count(), cities.length);
      assert.equal(await page.locator('.leader.off').count(), 0, 'Every pin is on the visible side of the globe');
      const joins = await page.evaluate(() => {
        const stage = document.querySelector('#globe-stage').getBoundingClientRect(), host = document.querySelector('#globe-wrap').getBoundingClientRect();
        return [...document.querySelectorAll('.leader')].map(g => {
          const nums = g.querySelector('path').getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number);
          const head = document.querySelector(`.callout[data-city="${g.dataset.city}"] .callout__head`).getBoundingClientRect();
          const [sx, sy, ex, ey] = [nums[0], nums[1], nums[nums.length - 2], nums[nums.length - 1]];
          return { city: g.dataset.city,
            endsOnName: Math.abs(ex - (head.left - stage.left)) < 2 && Math.abs(ey - (head.top + head.height / 2 - stage.top)) < 2,
            startsOnGlobe: sx > host.left - stage.left && sx < host.right - stage.left && sy > host.top - stage.top && sy < host.bottom - stage.top };
        });
      });
      assert.deepEqual(joins.filter(j => !j.endsOnName || !j.startsOnGlobe), [], 'Each leader line joins its pin on the globe to its name');
    } else {
      assert.ok(heads.every(h => h.top >= globeBox.y + globeBox.height - 4), 'On a phone the names open under the globe');
      assert.equal(await page.locator('.globe-leaders').evaluate(el => getComputedStyle(el).display), 'none', 'Leader lines are only drawn when the column sits beside the globe');
    }

    // A name opens its city's events as links to the event pages.
    const london = events.filter(e => e.city === 'London');
    assert.ok(london.length, 'The demo data should have London events');
    await page.locator('.callout[data-city="London"] .callout__head').click();
    await page.locator('.callout.active .callout__events a').first().waitFor();
    assert.equal(await page.locator('.callout.active .callout__head').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.chip[data-city="London"]').getAttribute('aria-pressed'), 'true', 'The city chips follow the column');
    if (wide) assert.equal(await page.locator('.leader.active').count(), 1, 'The chosen city\'s line is highlighted');
    const hrefs = await page.locator('.callout.active .callout__events a').evaluateAll(anchors => anchors.map(a => a.getAttribute('href')));
    assert.deepEqual(hrefs.sort(), london.map(e => `/event/${e.id}`).sort());

    // Pressing the open name closes it; the close button closes the column and lists every event again.
    await page.locator('.callout.active .callout__head').click();
    assert.equal(await page.locator('.callout.active').count(), 0);
    await page.locator('.callouts__close').click();
    assert.equal(await page.locator('#globe-stage.has-callouts').count(), 0);
    assert.equal(await page.locator('.chip[data-city="all"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#atlas-panel .rows li').count(), events.length);

    // Escape steps back out once focus is in the column.
    await page.locator('.globe-cluster').click();
    await page.locator('.callouts__close').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#globe-stage.has-callouts').count(), 0);

    // Pressing an event goes to its event page.
    await page.locator('.chip[data-city="London"]').click();
    await page.locator('.callout.active .callout__events a').first().click();
    await page.waitForURL(/\/event\/[^/]+$/);
    await page.locator('#booking-form').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, `Event page overflows at ${viewport.width}`);

    // The chips still drive the column the other way round.
    await page.goto(origin);
    await page.locator('.chip[data-city="Manchester"]').click();
    await page.locator('.callout.active[data-city="Manchester"] .callout__events a').first().waitFor();
    assert.deepEqual(errors, [], `Page errors at ${viewport.width}: ${errors.join('; ')}`);
    await page.close();
  }

  // Without WebGL the section falls back to the chips and the list.
  const noGl = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await noGl.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/.test(type) ? null : original.call(this, type, ...rest); }; });
  await noGl.goto(origin);
  await noGl.locator('#atlas-panel .rows').waitFor();
  assert.equal(await noGl.locator('#globe-stage').isHidden(), true);
  assert.equal(await noGl.locator('.chip[data-city]').count(), cities.length + 1);
  await noGl.close();
  console.log('Whole globe, region badge, callout column with leader lines, location names, event links and the no-WebGL fallback passed at 1440px and 390px.');
} finally {
  await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS may still hold the SQLite file briefly; the temp folder is disposable */ }
  await browser?.close();
}
