import { existsSync, readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { Store } from '../lib/store.js';

if (!['stripe-test', 'stripe-live'].includes(process.env.APP_MODE)) throw new Error('This import requires an explicit Stripe test or live APP_MODE.');
if (process.env.APP_MODE === 'stripe-live' && process.env.CONFIRM_LIVE_EVENT_IMPORT !== 'diwali-pahat-london-2026') throw new Error('Confirm the live event import explicitly.');
if (!process.env.DATABASE_PATH) throw new Error('Set DATABASE_PATH explicitly to the intended database.');
const databasePath = resolve(process.env.DATABASE_PATH);
const live = process.env.APP_MODE === 'stripe-live';
if (live && !isAbsolute(process.env.DATABASE_PATH)) throw new Error('Live import requires an absolute database path.');
if (!live && !existsSync(databasePath)) throw new Error('Database does not exist; this import will not create one in test mode.');
const event = JSON.parse(readFileSync(new URL('../content/diwali-pahat-london-2026.json', import.meta.url), 'utf8'));
if (event.status !== 'announced' || event.tiers.length) throw new Error('The event manifest must remain an unpriced announcement.');
const store = new Store(databasePath, { mode: process.env.APP_MODE });
try {
  if (live) {
    const marker = store.setting('system.payment_mode');
    if (marker && marker !== 'stripe-live') throw new Error('This database belongs to another payment environment.');
    if (!marker && ['events', 'orders', 'mail', 'provider_events'].some(table => store.get(`SELECT COUNT(*) n FROM ${table}`).n)) throw new Error('Live import requires a clean dedicated database.');
    if (store.get("SELECT 1 FROM orders WHERE booking_mode<>'stripe-live'") || store.get("SELECT 1 FROM mail WHERE origin_mode<>'stripe-live'")) throw new Error('Live database contains non-live bookings or messages.');
    if (!marker) store.setSetting('system.payment_mode', 'stripe-live');
  }
  const existing = store.event(event.id);
  if (existing?.status === 'announced') {
    process.stdout.write(`Announcement ${event.id} already exists. No data was changed.\n`);
  } else if (existing?.status === 'draft' && !existing.tiers.length && !store.get('SELECT 1 FROM orders WHERE event_id=?', event.id)) {
    store.saveEvent(event, 'content-import');
    process.stdout.write(`Updated ${event.id} from draft to public announcement. No tickets are for sale.\n`);
  } else if (existing) {
    throw new Error('Event already exists with organiser changes or orders; edit it in Admin instead.');
  } else {
    store.saveEvent(event, 'content-import');
    process.stdout.write(`Created announcement ${event.id}. It has no tickets for sale.\n`);
  }
} finally {
  store.db.close();
}
