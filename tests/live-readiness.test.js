import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const event = (id, demo = false) => ({
  id, title: 'Fixture event', city: 'London', lat: 51.5, lng: -0.1,
  status: 'published', startAt: new Date(Date.now() + 86400000).toISOString(),
  image: '/assets/hero.webp', demo,
  tiers: [{ id: `${id}-ga`, name: 'Admission', price: 1000, capacity: 2 }]
});

test('live orders use a distinct mode; demo events and demo mail stay isolated', () => {
  const store = new Store(':memory:', { mode: 'stripe-live' });
  try {
    store.saveEvent(event('live-event'));
    store.saveEvent(event('demo-event', true));
    assert.throws(() => store.reserve({ eventId: 'demo-event', name: 'Guest', email: 'guest@example.com',
      items: [{ tierId: 'demo-event-ga', quantity: 1 }] }), /not currently on sale/);
    const order = store.reserve({ eventId: 'live-event', name: 'Guest', email: 'guest@example.com',
      items: [{ tierId: 'live-event-ga', quantity: 1 }] });
    assert.equal(order.booking_mode, 'stripe-live');
    assert.throws(() => store.fulfil(order.id, { amount: order.total }), /Provider payment verification is required/);
    assert.equal(store.order(order.id).tickets.length, 0);
    store.run('UPDATE orders SET stripe_session=? WHERE id=?', 'cs_live_fixture', order.id);
    store.ingestProviderEvent({ id: 'evt_live_paid', type: 'checkout.session.completed',
      orderId: order.id, clientReferenceId: order.id, sessionId: 'cs_live_fixture',
      paymentId: 'pi_live_fixture', amount: order.total, currency: 'gbp', paymentStatus: 'paid', strict: true });
    const ticket = store.order(order.id).tickets[0];
    assert.ok(ticket);
    assert.equal(store.checkIn(ticket.token, 'staff', 'live-event').testOnly, false);
    store.applyProviderSnapshot('pi_live_fixture', { intent: { status: 'succeeded', amount_received: order.total, currency: 'gbp' },
      refunds: [{ id: 're_live_fixture', amount: order.total, status: 'succeeded' }], disputes: [] });
    assert.throws(() => store.checkIn(ticket.token, 'staff', 'live-event'), /not valid for admission/);
    const liveMail = store.queueMail('guest@example.com', 'Manual update', 'For this live order', order.id);
    store.run("INSERT INTO mail(id,recipient,subject,body,status,created,origin_mode) VALUES('held-demo','guest@example.com','Demo','Do not send','pending',?,'demo')", Date.now());
    assert.ok(store.pendingDeliverableMail().some(m => m.id === liveMail));
    assert.ok(!store.pendingDeliverableMail().some(m => m.id === 'held-demo'));
    assert.equal(store.events(false, false).some(e => e.demo), false);
  } finally { store.db.close(); }
});

test('a confirmed live announcement import creates only a clean, unpriced live database', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mirari-live-import-'));
  const databasePath = path.join(dir, 'live.sqlite');
  try {
    const env = { ...process.env, APP_MODE: 'stripe-live', DATABASE_PATH: databasePath,
      CONFIRM_LIVE_EVENT_IMPORT: 'diwali-pahat-london-2026' };
    const first = spawnSync(process.execPath, ['scripts/import-event-announcement.mjs'],
      { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(databasePath), true);
    const store = new Store(databasePath, { mode: 'stripe-live' });
    try {
      assert.equal(store.setting('system.payment_mode'), 'stripe-live');
      assert.equal(store.event('diwali-pahat-london-2026').status, 'announced');
      assert.equal(store.event('diwali-pahat-london-2026').tiers.length, 0);
      assert.equal(store.get('SELECT COUNT(*) n FROM orders').n, 0);
    } finally { store.db.close(); }
    const again = spawnSync(process.execPath, ['scripts/import-event-announcement.mjs'],
      { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stderr);
    const testDatabasePath = path.join(dir, 'existing-test.sqlite');
    const testStore = new Store(testDatabasePath, { mode: 'stripe-test' });
    testStore.saveEvent(event('preexisting-test-event'));
    testStore.db.close();
    const refused = spawnSync(process.execPath, ['scripts/import-event-announcement.mjs'],
      { cwd: process.cwd(), env: { ...env, DATABASE_PATH: testDatabasePath }, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /clean dedicated database/);
    const after = new Store(testDatabasePath, { mode: 'stripe-test' });
    try {
      assert.equal(after.event('preexisting-test-event').title, 'Fixture event');
      assert.equal(after.event('diwali-pahat-london-2026'), null);
      assert.equal(after.setting('system.payment_mode'), '');
    } finally { after.db.close(); }
  } finally {
    const target = path.resolve(dir), tempRoot = path.resolve(tmpdir());
    if (!target.startsWith(tempRoot + path.sep) || !path.basename(target).startsWith('mirari-live-import-')) throw new Error('Unsafe temporary cleanup path.');
    rmSync(target, { recursive: true, force: true });
  }
});
