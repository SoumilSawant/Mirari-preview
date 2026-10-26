// Manual browser regression: real-ticket link rendering without any payment or email.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Store } from '../lib/store.js';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempRoot = path.resolve(tmpdir());
const dir = mkdtempSync(path.join(tempRoot, 'mirari-external-ui-'));
const database = path.join(dir, 'preview.sqlite');
const manifest = JSON.parse(readFileSync(path.join(project, 'content/diwali-pahat-london-2026.json'), 'utf8'));
const store = new Store(database, { mode: 'stripe-test' });
store.saveEvent({ ...manifest, status: 'published', externalBookingEnabled: true }, 'external-ui');
store.saveEvent({ ...manifest, id: 'hidden-native-test', title: 'Hidden Native Test Event', status: 'published',
  externalBookingUrl: '', externalBookingEnabled: false, tiers: [{ name: 'Test ticket', price: 100, capacity: 2 }] }, 'external-ui');
store.db.close();

const port = 24000 + Math.floor(Math.random() * 10000);
const origin = `http://127.0.0.1:${port}`;
const adminEmail = 'external-ui@mirari.local';
const adminPassword = randomUUID();
const server = spawn(process.execPath, ['server.js'], {
  cwd: project,
  env: {
    ...process.env,
    PORT: String(port), HOST: '127.0.0.1', APP_URL: origin,
    DATABASE_PATH: database, UPLOADS_PATH: path.join(dir, 'uploads'),
    APP_MODE: 'stripe-test', PUBLIC_SALES_CHANNEL: 'ticket-tailor', DEMO_MODE: 'false', NODE_ENV: 'test',
    ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: adminPassword, ADMIN_TOTP_SECRET: '',
    TRUSTED_PROXY_CIDRS: '', TRUSTED_PROXY_HOPS: '',
    STRIPE_SECRET_KEY: 'sk_test_external_ui_fake', STRIPE_WEBHOOK_SECRET: 'whsec_external_ui_fake',
    RESEND_API_KEY: '', EMAIL_FROM: ''
  },
  stdio: 'pipe'
});
let logs = '';
server.stdout.on('data', data => logs += data);
server.stderr.on('data', data => logs += data);
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, logs);
  const visibleEvents = await fetch(`${origin}/api/events`).then(response => response.json());
  assert.deepEqual(visibleEvents.map(event => event.id), [manifest.id]);
  assert.equal((await fetch(`${origin}/api/events/hidden-native-test`)).status, 404);
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const screenshots = path.join(project, 'output/screenshots');
  mkdirSync(screenshots, { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/event/${manifest.id}`);
    const bookingPanel = page.locator('.booking-panel');
    await bookingPanel.getByRole('link', { name: /Continue to Ticket Tailor/ }).waitFor();
    const bookingLink = bookingPanel.getByRole('link', { name: /Continue to Ticket Tailor/ });
    assert.equal(await bookingLink.getAttribute('href'), manifest.externalBookingUrl);
    assert.equal(await bookingLink.getAttribute('target'), '_blank');
    assert.match(await bookingLink.getAttribute('rel') || '', /noopener/);
    assert.equal(await page.locator('#booking-form').isVisible(), false);
    assert.match(await bookingPanel.innerText(), /real ticket purchase on Ticket Tailor/);
    assert.equal(await page.locator('#demo-notice').isHidden(), true);
    assert.equal(await page.locator('a[href="/my-tickets"]:visible').count(), 0);
    assert.equal((await page.locator('body').innerText()).includes('STRIPE TEST MODE'), false);
    assert.match(await page.locator('.facts').innerText(), /15:00/);
    assert.match(await page.locator('.detail-copy').innerText(), /contact the organiser through Ticket Tailor before buying/i);
    assert.equal(await page.locator('.detail-copy a[href="/policy/refunds"]').count(), 0);
    assert.equal(await page.locator('.detail-copy a[href="' + manifest.externalBookingUrl + '"]').count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(screenshots, `mirari-ticket-tailor-${viewport.width}.png`), fullPage: true });
    await page.close();
  }
  const admin = await browser.newPage();
  await admin.goto(`${origin}/admin`);
  await admin.locator('#admin-login [name=email]').fill(adminEmail);
  await admin.locator('#admin-login [name=password]').fill(adminPassword);
  await admin.locator('#admin-login button[type=submit]').click();
  await admin.locator('[data-tab="Events"]').click();
  const eventRow = admin.locator('.admin-row').filter({ hasText: manifest.title });
  await eventRow.getByText(manifest.title).waitFor();
  await eventRow.locator('[data-edit]').click();
  assert.equal(await admin.locator('#event-editor [name=status]').inputValue(), 'published');
  assert.equal(await admin.locator('#event-editor [name=externalBookingUrl]').inputValue(), manifest.externalBookingUrl);
  assert.equal(await admin.locator('#event-editor [name=externalBookingEnabled]').isChecked(), true);
  assert.equal(await admin.locator('.tier-editor').count(), 0);
  await admin.close();
  console.log('Ticket Tailor event link and admin state passed at 1440px and 390px; no checkout, payment or email was initiated.');
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
  }
  if (!path.resolve(dir).startsWith(tempRoot + path.sep)) throw new Error('Refusing to remove a directory outside the temporary root.');
  rmSync(dir, { recursive: true, force: true });
}
