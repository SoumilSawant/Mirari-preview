import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';

test('Ticket Tailor public channel hides native test events and blocks Mirari customer ticket flows', async () => {
  const tempRoot = path.resolve(tmpdir());
  const dir = mkdtempSync(path.join(tempRoot, 'mirari-public-channel-'));
  const database = path.join(dir, 'public.sqlite');
  const manifest = JSON.parse(readFileSync(path.resolve('content/diwali-pahat-london-2026.json'), 'utf8'));
  const store = new Store(database, { mode: 'stripe-test' });
  store.saveEvent({ ...manifest, status: 'published', externalBookingEnabled: true }, 'test');
  store.saveEvent({ ...manifest, id: 'internal-stripe-test', title: 'Internal Stripe Test', externalBookingUrl: '', externalBookingEnabled: false,
    status: 'published', tiers: [{ name: 'Test ticket', price: 100, capacity: 2 }] }, 'test');
  store.db.close();

  const port = 24000 + Math.floor(Math.random() * 10000);
  const origin = `http://127.0.0.1:${port}`;
  const adminEmail = 'public-channel@mirari.local';
  const adminPassword = randomUUID();
  const child = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', APP_URL: origin, DATABASE_PATH: database,
    UPLOADS_PATH: path.join(dir, 'uploads'), APP_MODE: 'stripe-test', PUBLIC_SALES_CHANNEL: 'ticket-tailor',
    NODE_ENV: 'test', ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: adminPassword, ADMIN_TOTP_SECRET: '',
    TRUSTED_PROXY_CIDRS: '', TRUSTED_PROXY_HOPS: '', STRIPE_SECRET_KEY: 'sk_test_public_channel_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_public_channel_fixture', RESEND_API_KEY: '', EMAIL_FROM: ''
  }, stdio: 'pipe' });
  let logs = '';
  child.stdout.on('data', chunk => logs += chunk);
  child.stderr.on('data', chunk => logs += chunk);
  const request = async (url, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(origin + url, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };

  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited during startup: ${logs}`);
      try { if ((await request('/api/health')).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, logs);
    assert.equal((await request('/api/config')).data.publicSalesChannel, 'ticket-tailor');
    assert.deepEqual((await request('/api/events')).data.map(event => event.id), [manifest.id]);
    assert.equal((await request(`/api/events/${manifest.id}`)).status, 200);
    assert.equal((await request('/api/events/internal-stripe-test')).status, 404);
    assert.equal((await request('/api/reservations', { method: 'POST', body: { eventId: manifest.id } })).status, 409);
    assert.equal((await request('/api/tickets/retrieve', { method: 'POST', body: { email: 'guest@example.com' } })).status, 404);
    assert.equal((await request('/api/tickets/exchange', { method: 'POST', body: { token: 'unused' } })).status, 404);

    const login = await request('/api/admin/login', { method: 'POST', body: { email: adminEmail, password: adminPassword } });
    assert.equal(login.status, 200);
    const admin = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    assert.deepEqual((await request('/api/admin/events', { headers: admin })).data.map(event => event.id).sort(),
      ['internal-stripe-test', manifest.id].sort());
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('close', resolve));
    }
    assert.ok(path.resolve(dir).startsWith(tempRoot + path.sep));
    rmSync(dir, { recursive: true, force: true });
  }
});
