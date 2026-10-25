import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.js';

const output = path.resolve('output');

async function launch(dbPath, mode) {
  const port = 20000 + Math.floor(Math.random() * 15000);
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, APP_MODE: mode, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), APP_URL: origin,
    DATABASE_PATH: dbPath, ADMIN_EMAIL: 'mode-test@mirari.local', ADMIN_PASSWORD: randomUUID(), ADMIN_TOTP_SECRET: '',
    STRIPE_SECRET_KEY: mode === 'stripe-test' ? 'sk_test_mode_fixture' : '', STRIPE_WEBHOOK_SECRET: mode === 'stripe-test' ? 'whsec_mode_fixture' : '',
    RESEND_API_KEY: '', EMAIL_FROM: '' };
  delete env.DEMO_MODE;
  const child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env, stdio: 'pipe' });
  let logs = '';
  child.stdout.on('data', chunk => logs += chunk);
  child.stderr.on('data', chunk => logs += chunk);
  const request = async (url, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(origin + url, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup: ${logs}`);
    try { if ((await request('/api/config')).status === 200) return { child, request, password: env.ADMIN_PASSWORD, logs: () => logs }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`Server did not start: ${logs}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('close', resolve));
  child.kill();
  await exited;
}

test('demo orders, events, admission and mail remain isolated after a test-mode restart', async () => {
  mkdirSync(output, { recursive: true });
  const dir = mkdtempSync(path.join(output, 'mode-test-'));
  const dbPath = path.join(dir, 'mirari.sqlite');
  let app;
  try {
    app = await launch(dbPath, 'demo');
    const demoEvent = (await app.request('/api/events')).data[0];
    assert.equal(demoEvent.demo, true);
    const reserved = await app.request('/api/reservations', { method: 'POST', body: { eventId: demoEvent.id, name: 'Demo Guest',
      email: 'demo-guest@example.com', acceptedTerms: true, items: [{ tierId: demoEvent.tiers[0].id, quantity: 1 }] } });
    assert.equal(reserved.status, 200);
    const { id, key } = reserved.data;
    assert.equal((await app.request(`/api/orders/${id}/demo-pay`, { method: 'POST', headers: { 'x-order-token': key }, body: {} })).status, 200);
    const ticket = (await app.request(`/api/orders/${id}`, { headers: { 'x-order-token': key } })).data.tickets[0];
    assert.ok(ticket);
    await app.request('/api/tickets/retrieve', { method: 'POST', body: { email: 'demo-guest@example.com' } });
    await stop(app.child);
    const beforeSwitch = new Store(dbPath, { mode: 'demo' });
    const recoveryBody = beforeSwitch.get("SELECT body FROM mail WHERE subject='Your private Mirari ticket link'").body;
    const recoveryToken = recoveryBody.match(/#access=([^\s]+)/)[1];
    beforeSwitch.db.close();

    app = await launch(dbPath, 'stripe-test');
    assert.equal((await app.request('/api/config')).data.mode, 'stripe-test');
    assert.equal((await app.request('/api/health')).data.mode, 'stripe-test');
    assert.equal((await app.request('/api/ready')).status, 503); // Email is deliberately unconfigured.
    assert.deepEqual((await app.request('/api/events')).data, []);
    assert.equal((await app.request(`/api/events/${demoEvent.id}`)).data.demo, true); // Private previews remain labelled.
    const oldOrder = (await app.request(`/api/orders/${id}`, { headers: { 'x-order-token': key } })).data;
    assert.equal(oldOrder.booking_mode, 'demo');
    assert.equal(oldOrder.payment_id, undefined);
    assert.equal((await app.request(`/api/orders/${id}/demo-pay`, { method: 'POST', headers: { 'x-order-token': key }, body: {} })).status, 403);
    assert.equal((await app.request('/api/tickets/exchange', { method: 'POST', body: { token: recoveryToken } })).status, 410);
    assert.equal((await app.request('/api/reservations', { method: 'POST', body: { eventId: demoEvent.id, name: 'No Sale', email: 'no-sale@example.com',
      acceptedTerms: true, items: [{ tierId: demoEvent.tiers[0].id, quantity: 1 }] } })).status, 409);

    const login = await app.request('/api/admin/login', { method: 'POST', body: { email: 'mode-test@mirari.local', password: app.password } });
    assert.equal(login.status, 200);
    const admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    assert.ok((await app.request('/api/admin/events', { headers: admin })).data.some(event => event.id === demoEvent.id));
    assert.equal((await app.request('/api/admin/check-in', { method: 'POST', headers: admin,
      body: { token: ticket.token, eventId: demoEvent.id } })).status, 409);
    const orders = (await app.request('/api/admin/orders', { headers: admin })).data;
    assert.equal(orders.find(order => order.id === id).booking_mode, 'demo');
    const mail = (await app.request('/api/admin/mail', { headers: admin })).data.find(message => message.order_id === id);
    assert.equal(mail.origin_mode, 'demo');
    assert.equal(mail.status, 'pending');
    assert.equal((await app.request(`/api/admin/mail/${mail.id}/retry`, { method: 'POST', headers: admin, body: {} })).status, 409);
    assert.equal((await app.request(`/api/admin/orders/${id}/resend`, { method: 'POST', headers: admin, body: {} })).status, 409);
    assert.equal((await app.request(`/api/admin/orders/${id}/refund`, { method: 'POST', headers: admin, body: {} })).status, 409);
    const unavailableRecovery = await app.request('/api/tickets/retrieve', { method: 'POST', body: { email: 'demo-guest@example.com' } });
    assert.equal(unavailableRecovery.status, 503);
    assert.match(unavailableRecovery.data.error, /Email delivery is temporarily unavailable/);
    assert.equal((await app.request('/api/admin/mail', { headers: admin })).data.length, 2);
    await stop(app.child); app = null;

    const store = new Store(dbPath, { mode: 'stripe-test' });
    assert.equal(store.get('PRAGMA user_version').user_version, 4);
    assert.equal(store.order(id).booking_mode, 'demo');
    assert.equal(store.get('SELECT origin_mode FROM mail WHERE order_id=?', id).origin_mode, 'demo');
    assert.throws(() => store.checkIn(ticket.token, 'staff', demoEvent.id), /different booking environment/);
    assert.throws(() => store.saveEvent({ ...store.event(demoEvent.id), demo: false }), /Create a new event/);
    const testMail = store.queueMail('test@example.com', 'Test email', 'Test only');
    assert.equal(store.get('SELECT origin_mode FROM mail WHERE id=?', testMail).origin_mode, 'stripe-test');
    assert.deepEqual(store.pendingDeliverableMail().map(message => message.id), [testMail]);
    store.db.close();
  } finally {
    if (app) await stop(app.child);
    assert.ok(dir.startsWith(output + path.sep + 'mode-test-'));
    for (const name of readdirSync(dir)) {
      const file = path.resolve(dir, name);
      assert.equal(path.dirname(file), dir);
      for (let attempt = 0; attempt < 20; attempt++) {
        try { unlinkSync(file); break; }
        catch (error) {
          if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 19) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    rmdirSync(dir);
  }
});

test('a live Stripe key in demo mode is rejected before a database is opened', () => {
  const dbPath = path.join(output, `forbidden-${randomUUID()}.sqlite`);
  const env = { ...process.env, APP_MODE: 'demo', NODE_ENV: 'test', DATABASE_PATH: dbPath, STRIPE_SECRET_KEY: 'sk_live_forbidden_fixture' };
  delete env.DEMO_MODE;
  const result = spawnSync(process.execPath, ['server.js'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live Stripe key cannot be configured in demo mode/);
  assert.equal(existsSync(dbPath), false);
});

test('live mode requires explicit production configuration before a database is opened', () => {
  const dbPath = path.join(output, `unconfigured-live-${randomUUID()}.sqlite`);
  const env = { ...process.env, APP_MODE: 'stripe-live', NODE_ENV: 'test', DATABASE_PATH: dbPath,
    STRIPE_SECRET_KEY: 'sk_live_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', ENABLE_LIVE_PAYMENTS: 'true' };
  delete env.DEMO_MODE;
  const result = spawnSync(process.execPath, ['server.js'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Stripe live mode requires production/);
  assert.equal(existsSync(dbPath), false);
});

test('a wildcard proxy trust setting is rejected before opening a database', () => {
  const dbPath = path.join(output, `unsafe-proxy-${randomUUID()}.sqlite`);
  const env = { ...process.env, APP_MODE: 'demo', NODE_ENV: 'test', DATABASE_PATH: dbPath,
    STRIPE_SECRET_KEY: '', TRUSTED_PROXY_CIDRS: '0.0.0.0/0' };
  delete env.DEMO_MODE;
  const result = spawnSync(process.execPath, ['server.js'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Do not trust arbitrary forwarded headers/);
  assert.equal(existsSync(dbPath), false);
});
