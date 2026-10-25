// Browser smoke test for Stripe test-mode copy and historical demo data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { Store } from '../lib/store.js';
import { seed } from '../lib/seed.js';

const output = path.resolve('output');
mkdirSync(output, { recursive: true });
const dir = mkdtempSync(path.join(output, 'mode-ui-'));
const dbPath = path.join(dir, 'ui.sqlite');
let store = new Store(dbPath, { mode: 'demo' });
seed(store);
const event = store.events()[0];
const old = store.reserve({ eventId: event.id, name: 'Historical Demo Guest', email: 'old-demo@example.com',
  items: [{ tierId: event.tiers[0].id, quantity: 1 }] });
store.fulfil(old.id, { amount: old.total, webhookId: 'mode-ui-demo' });
store.db.close();
store = new Store(dbPath, { mode: 'stripe-test' });
store.saveEvent({ id: 'mode-ui-test-event', title: 'Staging Event', city: 'London', lat: 51.5074, lng: -0.1278,
  category: 'Live music', venue: 'Test Venue', address: 'London', image: '/assets/hero.webp', demo: false,
  status: 'published', startAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  description: 'Test-only event.', tiers: [{ id: 'mode-ui-tier', name: 'General admission', price: 3500, capacity: 20 }] });
store.alert('refund_failed', old.id, 'A Stripe refund failed. Check the payment and customer communication.');
store.db.close();

const port = 24000 + Math.floor(Math.random() * 10000), origin = `http://127.0.0.1:${port}`;
const password = randomUUID(), email = 'mode-ui@mirari.local';
const env = { ...process.env, APP_MODE: 'stripe-test', NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', APP_URL: origin,
  DATABASE_PATH: dbPath, ADMIN_EMAIL: email, ADMIN_PASSWORD: password, ADMIN_TOTP_SECRET: '',
  STRIPE_SECRET_KEY: 'sk_test_mode_ui_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_mode_ui_fixture', RESEND_API_KEY: '', EMAIL_FROM: '' };
delete env.DEMO_MODE;
const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env, stdio: 'pipe' });
let logs = '';
server.stdout.on('data', chunk => logs += chunk);
server.stderr.on('data', chunk => logs += chunk);
let browser;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#demo-notice').getByText('STRIPE TEST MODE').waitFor();
    assert.equal(await page.locator('.event-card').count(), 1);
    assert.equal(await page.locator('.event-card .tag').count(), 0);
    await page.goto(`${origin}/event/mode-ui-test-event`);
    await page.locator('#booking-form button[type=submit]').getByText('Continue to Stripe test checkout').waitFor();
    await page.goto(`${origin}/order/${old.id}#key=${old.access_token}`);
    await page.locator('.ticket .tag').getByText('Demo ticket').waitFor();
    await page.getByText('DEMO BOOKING · No money is charged.').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true,
      `Order page overflows at ${viewport.width}`);
    await page.goto(`${origin}/admin`);
    await page.locator('#admin-login [name=email]').fill(email);
    await page.locator('#admin-login [name=password]').fill(password);
    await page.locator('#admin-login button[type=submit]').click();
    await page.locator('[data-tab="Orders"]').click();
    await page.getByText('STRIPE TEST BOOKING VALUE').waitFor();
    await page.getByText('£0.00').first().waitFor();
    await page.getByText('DEMO · paid').waitFor();
    await page.locator('[data-tab="Email outbox"]').click();
    await page.getByText('DEMO HELD').waitFor();
    await page.getByText('Email delivery is not configured.').waitFor();
    await page.locator('[data-tab="Alerts"]').click();
    await page.getByRole('heading', { name: 'Refund failed' }).waitFor();
    await page.getByText(`Order ID: ${old.id}`).waitFor();
    await page.getByRole('button', { name: 'View order' }).click();
    assert.equal(await page.locator('#order-search').inputValue(), old.id);
    assert.deepEqual(errors, [], `Browser errors at ${viewport.width}`);
    await page.close();

    // Exercise live-mode presentation only. The fixture server still rejects real payments.
    const livePage = await browser.newPage({ viewport });
    await livePage.route('**/api/config', route => route.fulfill({ json: {
      mode: 'stripe-live', demo: false, live: true, salesReady: true, paymentsReady: true, emailReady: true, mfaRequired: false
    } }));
    await livePage.goto(`${origin}/event/mode-ui-test-event`);
    await livePage.locator('#booking-form button[type=submit]').getByText('Continue to secure checkout').waitFor();
    assert.equal(await livePage.locator('#demo-notice').isHidden(), true);
    assert.equal(await livePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true,
      `Live event page overflows at ${viewport.width}`);
    await livePage.close();

    const closedPage = await browser.newPage({ viewport });
    await closedPage.route('**/api/config', route => route.fulfill({ json: {
      mode: 'stripe-live', demo: false, live: true, salesReady: false,
      paymentsReady: true, emailReady: true, mfaRequired: false
    } }));
    await closedPage.goto(`${origin}/event/mode-ui-test-event`);
    await closedPage.getByText('Bookings are not open yet. Please check back for updates.').waitFor();
    assert.equal(await closedPage.locator('#booking-form button[type=submit]').isDisabled(), true);
    await closedPage.close();
  }
  console.log('Desktop/mobile Stripe test UI and simulated live UI labels passed; no provider checkout was opened.');
} finally {
  await browser?.close();
  const closed = new Promise(resolve => server.once('close', resolve));
  server.kill();
  await closed;
  assert.ok(dir.startsWith(output + path.sep + 'mode-ui-'));
  for (const name of readdirSync(dir)) {
    const file = path.resolve(dir, name);
    assert.equal(path.dirname(file), dir);
    unlinkSync(file);
  }
  rmdirSync(dir);
}
