import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../lib/store.js';

if (process.env.APP_MODE !== 'stripe-test') throw new Error('This import requires APP_MODE=stripe-test.');
if (!process.env.DATABASE_PATH) throw new Error('Set DATABASE_PATH explicitly to the intended Stripe test database.');
const databasePath = resolve(process.env.DATABASE_PATH);
if (!existsSync(databasePath)) throw new Error('Database does not exist; this import will not create one.');
const event = JSON.parse(readFileSync(new URL('../content/diwali-pahat-london-2026.json', import.meta.url), 'utf8'));
if (event.status !== 'announced' || event.tiers.length) throw new Error('The event manifest must remain an unpriced announcement.');
const store = new Store(databasePath, { mode: 'stripe-test' });
try {
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
