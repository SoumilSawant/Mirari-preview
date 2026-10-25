import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export class Store {
  constructor(filename = ':memory:', { mode = 'demo' } = {}) {
    if (!['demo', 'stripe-test', 'stripe-live'].includes(mode)) throw new Error('Invalid application mode.');
    this.mode = mode;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT NOT NULL, city TEXT NOT NULL, status TEXT NOT NULL, start_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tiers (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0), capacity INTEGER NOT NULL CHECK(capacity>=0), opens TEXT, closes TEXT);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL, access_hash TEXT NOT NULL, access_token TEXT NOT NULL, stripe_session TEXT UNIQUE, payment_id TEXT, marketing INTEGER NOT NULL DEFAULT 0, delivery TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS order_items (order_id TEXT NOT NULL REFERENCES orders(id), tier_id TEXT NOT NULL REFERENCES tiers(id), name TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), PRIMARY KEY(order_id,tier_id));
      CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), tier_name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, checked_at INTEGER, checked_by TEXT);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_links (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mail (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, error TEXT, order_id TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS orders_email ON orders(email);
      CREATE INDEX IF NOT EXISTS orders_event ON orders(event_id,status);
      CREATE INDEX IF NOT EXISTS tickets_order ON tickets(order_id);
    `);
    const version = this.get('PRAGMA user_version').user_version;
    if (version > 4) throw new Error(`Database schema ${version} is newer than this application.`);
    if (version < 1) this.tx(() => {
      if (this.get('PRAGMA user_version').user_version >= 1) return;
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS orders_unique_provider_payment ON orders(payment_id) WHERE payment_id IS NOT NULL AND payment_id <> 'demo';
        CREATE TABLE IF NOT EXISTS provider_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payment_id TEXT, session_id TEXT, order_id TEXT, received_at INTEGER NOT NULL, result TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS provider_state (payment_id TEXT PRIMARY KEY, fully_refunded INTEGER NOT NULL DEFAULT 0, disputed INTEGER NOT NULL DEFAULT 0, refund_status TEXT, updated_at INTEGER NOT NULL, amount_refunded INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, UNIQUE(kind,subject));
        CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
        ALTER TABLE orders ADD COLUMN refund_id TEXT;
        ALTER TABLE orders ADD COLUMN refund_status TEXT;
        ALTER TABLE orders ADD COLUMN refund_request_key TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS orders_unique_refund ON orders(refund_id) WHERE refund_id IS NOT NULL;
        PRAGMA user_version=1;
      `);
    });
    if (this.get('PRAGMA user_version').user_version < 2) this.tx(() => {
      if (this.get('PRAGMA user_version').user_version >= 2) return;
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS checkout_attempts (order_id TEXT PRIMARY KEY REFERENCES orders(id), idempotency_key TEXT NOT NULL UNIQUE, session_id TEXT UNIQUE, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS refund_attempts (id TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(id), payment_id TEXT NOT NULL, provider_refund_id TEXT UNIQUE, idempotency_key TEXT UNIQUE, amount INTEGER NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS refund_attempts_payment ON refund_attempts(payment_id);
        CREATE TABLE IF NOT EXISTS provider_disputes (id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS provider_disputes_payment ON provider_disputes(payment_id);
        CREATE TABLE IF NOT EXISTS reconcile_marks (kind TEXT NOT NULL, subject TEXT NOT NULL, last_attempt INTEGER NOT NULL, PRIMARY KEY(kind,subject));
        ALTER TABLE provider_state ADD COLUMN verified_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE provider_state ADD COLUMN intent_status TEXT;
        ALTER TABLE provider_state ADD COLUMN amount_received INTEGER;
        ALTER TABLE provider_state ADD COLUMN currency TEXT;
        PRAGMA user_version=2;
      `);
      // Historical refund data is retained and remains unverified until Stripe is queried.
      for (const o of this.all('SELECT id,payment_id,total,refund_id,refund_status,refund_request_key,created FROM orders WHERE payment_id IS NOT NULL AND payment_id<>\'demo\' AND (refund_id IS NOT NULL OR refund_request_key IS NOT NULL)')) {
        this.run('INSERT OR IGNORE INTO refund_attempts VALUES(?,?,?,?,?,?,?,?,?,?)', randomUUID(), o.id, o.payment_id, o.refund_id, o.refund_request_key, o.total, o.refund_status || 'unknown', 'migration', o.created, Date.now());
      }
    });
    if (this.get('PRAGMA user_version').user_version < 3) this.tx(() => {
      if (this.get('PRAGMA user_version').user_version >= 3) return;
      this.db.exec(`
        ALTER TABLE orders ADD COLUMN booking_mode TEXT NOT NULL DEFAULT 'demo';
        ALTER TABLE mail ADD COLUMN origin_mode TEXT NOT NULL DEFAULT 'demo';
        UPDATE orders SET booking_mode='stripe-test' WHERE
          (payment_id IS NOT NULL AND payment_id<>'demo') OR stripe_session IS NOT NULL OR
          EXISTS(SELECT 1 FROM checkout_attempts a WHERE a.order_id=orders.id);
        UPDATE mail SET origin_mode='stripe-test' WHERE
          EXISTS(SELECT 1 FROM orders o WHERE o.id=mail.order_id AND o.booking_mode='stripe-test');
        PRAGMA user_version=3;
      `);
    });
    if (this.get('PRAGMA user_version').user_version < 4) this.tx(() => {
      if (this.get('PRAGMA user_version').user_version >= 4) return;
      // Legacy recovery links have no trustworthy environment marker; keep them demo-only.
      this.db.exec(`ALTER TABLE access_links ADD COLUMN origin_mode TEXT NOT NULL DEFAULT 'demo'; PRAGMA user_version=4;`);
    });
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor, action, subject, detail = '') { this.run('INSERT INTO audit(at,actor,action,subject,detail) VALUES(?,?,?,?,?)', Date.now(), actor, action, subject, detail); }
  alert(kind, subject, detail) {
    this.run("INSERT INTO alerts(id,kind,subject,detail,created_at) VALUES(?,?,?,?,?) ON CONFLICT(kind,subject) DO UPDATE SET detail=excluded.detail,status='open'", randomUUID(), kind, subject, detail, Date.now());
  }
  resolveAlert(kind, subject) { this.run("UPDATE alerts SET status='resolved' WHERE kind=? AND subject=?", kind, subject); }
  markReconcile(kind, subject) { this.run('INSERT INTO reconcile_marks VALUES(?,?,?) ON CONFLICT(kind,subject) DO UPDATE SET last_attempt=excluded.last_attempt', kind, subject, Date.now()); }
  pendingCheckoutReconciliation(limit = 20, now = Date.now()) {
    return this.all(`SELECT o.* FROM orders o LEFT JOIN reconcile_marks m ON m.kind='checkout' AND m.subject=o.id
      WHERE o.status='pending' AND o.booking_mode=? AND o.stripe_session IS NOT NULL
        AND COALESCE(m.last_attempt,0) <= ?
      ORDER BY COALESCE(m.last_attempt,0), o.created LIMIT ?`, this.mode, now - 60000, limit);
  }
  paymentReconciliationCandidates(limit = 25) {
    return this.all(`SELECT o.* FROM orders o LEFT JOIN reconcile_marks m ON m.kind='payment' AND m.subject=o.id
      WHERE o.status IN ('refunding','refunded','disputed','payment_review')
        AND o.booking_mode=? AND o.payment_id IS NOT NULL AND o.payment_id<>'demo'
      ORDER BY COALESCE(m.last_attempt,0), o.created LIMIT ?`, this.mode, limit);
  }
  stageProviderEvent(event) {
    this.run("INSERT OR IGNORE INTO provider_events(id,type,received_at,result,payload) VALUES(?, ?, ?, 'received', ?)", event.id, event.type, Date.now(), JSON.stringify(event));
  }
  rateLimit(bucket, max, now = Date.now()) {
    return this.tx(() => {
      this.run('DELETE FROM rate_limits WHERE until<?', now);
      const row = this.get('SELECT count,until FROM rate_limits WHERE bucket=?', bucket);
      if (!row) { this.run('INSERT INTO rate_limits VALUES(?,?,?)', bucket, 1, now + 60000); return true; }
      this.run('UPDATE rate_limits SET count=count+1 WHERE bucket=?', bucket);
      return row.count < max;
    });
  }
  checkoutAttempt(orderId) {
    return this.tx(() => {
      const order = this.get('SELECT status FROM orders WHERE id=?', orderId);
      if (!order || order.status !== 'pending') fail('This reservation cannot start checkout.', 409);
      let attempt = this.get('SELECT * FROM checkout_attempts WHERE order_id=?', orderId);
      if (!attempt) {
        const now = Date.now();
        this.run('INSERT INTO checkout_attempts VALUES(?,?,?,?,?,?)', orderId, `checkout-${orderId}`, null, 'creating', now, now);
        attempt = this.get('SELECT * FROM checkout_attempts WHERE order_id=?', orderId);
      }
      return attempt;
    });
  }
  bindCheckout(orderId, session) {
    return this.tx(() => {
      const order = this.get('SELECT id,total,stripe_session FROM orders WHERE id=?', orderId);
      const attempt = this.get('SELECT * FROM checkout_attempts WHERE order_id=?', orderId);
      if (!order || !attempt || !session?.id || session.client_reference_id !== orderId || session.metadata?.orderId !== orderId || session.currency !== 'gbp' || session.amount_total !== order.total || session.mode !== 'payment') {
        this.alert('checkout_binding', orderId, 'Stripe Checkout could not be matched to the reservation. Investigate before fulfilment.');
        fail('Checkout could not be verified.', 409);
      }
      if ((order.stripe_session && order.stripe_session !== session.id) || (attempt.session_id && attempt.session_id !== session.id)) fail('A different Checkout Session is already attached.', 409);
      this.run('UPDATE orders SET stripe_session=? WHERE id=?', session.id, orderId);
      this.run("UPDATE checkout_attempts SET session_id=?,status='bound',updated_at=? WHERE order_id=?", session.id, Date.now(), orderId);
      return this.order(orderId);
    });
  }
  claimRefund(orderId, actor) {
    return this.tx(() => {
      const o = this.order(orderId);
      if (!o || !o.payment_id || o.payment_id === 'demo' || !['paid','payment_review','refunding'].includes(o.status)) fail('This order cannot be refunded.', 409);
      const active = this.get("SELECT * FROM refund_attempts WHERE order_id=? AND status IN ('claimed','sending','pending','unknown') ORDER BY created_at DESC LIMIT 1", orderId);
      if (active) return active;
      const refunded = this.get("SELECT COALESCE(SUM(amount),0) n FROM refund_attempts WHERE payment_id=? AND status='succeeded'",o.payment_id).n;
      if(refunded>=o.total)fail('Payment is already fully refunded.',409);
      const id = randomUUID(), key = `refund-${id}`, now = Date.now();
      this.run('INSERT INTO refund_attempts VALUES(?,?,?,?,?,?,?,?,?,?)', id, orderId, o.payment_id, null, key, o.total-refunded, 'claimed', actor, now, now);
      this.run("UPDATE orders SET status='refunding',refund_status='pending',refund_request_key=? WHERE id=?", key, orderId);
      this.audit(actor, 'refund.claimed', orderId, id);
      return this.get('SELECT * FROM refund_attempts WHERE id=?', id);
    });
  }
  markRefundSending(id) { this.run("UPDATE refund_attempts SET status='sending',updated_at=? WHERE id=? AND status='claimed'", Date.now(), id); }
  markRefundUnknown(id) { this.run("UPDATE refund_attempts SET status='unknown',updated_at=? WHERE id=? AND status IN ('claimed','sending')", Date.now(), id); }
  applyProviderSnapshot(paymentId, snapshot) {
    return this.tx(() => {
      const now = Date.now(), refunds = snapshot.refunds || [], disputes = snapshot.disputes || [];
      const order = this.get('SELECT id,status,total FROM orders WHERE payment_id=?', paymentId);
      for (const refund of refunds) {
        const byId = this.get('SELECT id FROM refund_attempts WHERE provider_refund_id=?', refund.id);
        const byMetadata = refund.metadata?.mirariAttemptId ? this.get('SELECT id FROM refund_attempts WHERE id=? AND payment_id=?', refund.metadata.mirariAttemptId, paymentId) : null;
        const id = byId?.id || byMetadata?.id || randomUUID();
        if (byId || byMetadata) this.run('UPDATE refund_attempts SET provider_refund_id=?,amount=?,status=?,updated_at=? WHERE id=?', refund.id, refund.amount, refund.status, now, id);
        else this.run('INSERT INTO refund_attempts VALUES(?,?,?,?,?,?,?,?,?,?)', id, order?.id || null, paymentId, refund.id, null, refund.amount, refund.status, 'stripe', now, now);
      }
      const listed = new Set(refunds.map(r=>r.id));
      for(const prior of this.all('SELECT id,provider_refund_id FROM refund_attempts WHERE payment_id=? AND provider_refund_id IS NOT NULL',paymentId)){
        if(!listed.has(prior.provider_refund_id)){
          this.run("UPDATE refund_attempts SET status='unknown',updated_at=? WHERE id=?",now,prior.id);
          if(order)this.alert('refund_missing',order.id,'A previously recorded refund was absent from Stripe reconciliation. Admission is blocked until reviewed.');
        }
      }
      for (const dispute of disputes) this.run('INSERT INTO provider_disputes VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at', dispute.id, paymentId, dispute.status, now);
      const succeeded = refunds.filter(r=>r.status==='succeeded').reduce((n,r)=>n+r.amount,0);
      const unsettled = refunds.filter(r=>!['succeeded','failed','canceled'].includes(r.status));
      const pending = unsettled.length>0;
      const pendingAmount = unsettled.reduce((n,r)=>n+r.amount,0);
      const unresolvedLocal = this.get("SELECT 1 FROM refund_attempts WHERE payment_id=? AND status IN ('claimed','sending','unknown') LIMIT 1", paymentId);
      const blockedDispute = Boolean(snapshot.charge?.disputed) || disputes.some(d=>d.status!=='won');
      const full = snapshot.intent.amount_received > 0 && succeeded >= snapshot.intent.amount_received;
      const accountedRefunds = succeeded + pendingAmount;
      const providerGap = Number(snapshot.charge?.amount_refunded||0)>accountedRefunds || Boolean(snapshot.charge?.refunded&&accountedRefunds<snapshot.intent.amount_received);
      this.run(`INSERT INTO provider_state(payment_id,fully_refunded,disputed,refund_status,updated_at,amount_refunded,verified_at,intent_status,amount_received,currency)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(payment_id) DO UPDATE SET fully_refunded=excluded.fully_refunded,disputed=excluded.disputed,refund_status=excluded.refund_status,updated_at=excluded.updated_at,amount_refunded=excluded.amount_refunded,verified_at=excluded.verified_at,intent_status=excluded.intent_status,amount_received=excluded.amount_received,currency=excluded.currency`,
        paymentId, Number(full), Number(blockedDispute), providerGap?'unknown':pending?'pending':full?'succeeded':null, now, Math.max(succeeded,Number(snapshot.charge?.amount_refunded||0)), now, snapshot.intent.status, snapshot.intent.amount_received, snapshot.intent.currency);
      if (!order) return;
      const old = order.status;
      const tickets = Boolean(this.get('SELECT 1 FROM tickets WHERE order_id=?',order.id));
      let next = old;
      if (snapshot.intent.status !== 'succeeded' && ['paid','refunding','refunded','disputed','payment_review'].includes(old)) next = 'payment_review';
      else if (full) next = 'refunded';
      else if (blockedDispute) next = 'disputed';
      else if (pending || unresolvedLocal) next = 'refunding';
      else if (providerGap) next = 'payment_review';
      else if (succeeded > 0) next = 'payment_review';
      else if (snapshot.intent.status === 'succeeded' && ['paid','refunding','refunded','disputed','payment_review'].includes(old)) next = tickets?'paid':'payment_review';
      if (next !== old) {
        this.run('UPDATE orders SET status=?,refund_status=? WHERE id=?', next, full?'succeeded':next==='refunding'?'pending':refunds.some(r=>r.status==='failed')?'failed':null, order.id);
        this.audit('stripe','order.provider-state',order.id,`${old} -> ${next}`);
        if (next === 'refunded') { const o=this.order(order.id);this.queueMail(o.email,`Refund confirmed · ${o.event.title}`,`Your order has been refunded. These tickets are no longer valid.\n{{ORDER_LINK:${o.id}}}`,o.id); }
        if (old === 'refunded' && refunds.some(r=>r.status==='failed')) {
          this.run("UPDATE mail SET status='superseded',error=NULL WHERE order_id=? AND status IN ('pending','failed') AND subject LIKE 'Refund confirmed · %'", order.id);
          const o=this.order(order.id);
          this.queueMail(o.email,`Important update about your Mirari refund · ${o.event.title}`,`Stripe has reported that an earlier refund failed. Please contact Mirari about your payment before relying on the previous refund notice.\n{{ORDER_LINK:${o.id}}}`,o.id);
        }
      }
      if (refunds.some(r=>r.status==='failed')) this.alert('refund_failed',order.id,'A Stripe refund failed. Check the payment and customer communication.');
      if (blockedDispute) this.alert('dispute',order.id,'A Stripe dispute blocks admission. Review its status and evidence.');
      else this.resolveAlert('dispute',order.id);
      if (next==='payment_review') this.alert('payment_review',order.id,'Payment requires manual review; admission is blocked.');
      if (providerGap) this.alert('provider_refund_mismatch',order.id,'Stripe Charge and refund list disagree. Admission is blocked until investigated.');
      else this.resolveAlert('provider_refund_mismatch',order.id);
      if (full) this.resolveAlert('refund_pending',order.id);
    });
  }
  expire(now = Date.now()) {
    // A provider-backed hold is released only after Stripe confirms expiration.
    this.run("UPDATE orders SET status='expired' WHERE status='pending' AND expires<=? AND stripe_session IS NULL AND NOT EXISTS(SELECT 1 FROM checkout_attempts a WHERE a.order_id=orders.id)", now);
  }
  used(tierId, exclude = '') {
    return this.get(`SELECT COALESCE(SUM(i.quantity),0) n FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE i.tier_id=? AND o.id<>? AND (o.status IN ('pending','paid','refunding','disputed') OR
        (o.status='payment_review' AND EXISTS(SELECT 1 FROM tickets t WHERE t.order_id=o.id)))`, tierId, exclude).n;
  }
  event(id) {
    const row = this.get('SELECT * FROM events WHERE id=?', id);
    if (!row) return null;
    return { ...JSON.parse(row.data), id: row.id, title: row.title, city: row.city, status: row.status, startAt: row.start_at,
      tiers: this.all('SELECT * FROM tiers WHERE event_id=? ORDER BY price', id).map(t => ({ ...t, available: Math.max(0, t.capacity - this.used(t.id)) })) };
  }
  events(admin = false, includeDemo = true) {
    this.expire();
    return this.all(`SELECT id FROM events ${admin ? '' : "WHERE status IN ('announced','published','postponed','cancelled')"} ORDER BY start_at`)
      .map(r => this.event(r.id)).filter(e => admin || includeDemo || !e.demo);
  }
  saveEvent(input, actor = 'admin') {
    const text = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
    const id = input.id || randomUUID();
    if (!text(input.title) || !text(input.city) || !Number.isFinite(Date.parse(input.startAt))) fail('Title, city and a valid event date are required.');
    if (!['draft', 'announced', 'published', 'postponed', 'cancelled'].includes(input.status)) fail('Invalid event status.');
    if (!Array.isArray(input.tiers) || (input.status === 'published' && !input.tiers.length)) fail('Add at least one ticket tier before publishing.');
    if (!Number.isFinite(Number(input.lat)) || !Number.isFinite(Number(input.lng)) || Number(input.lat) < 49 || Number(input.lat) > 61 || Number(input.lng) < -9 || Number(input.lng) > 3) fail('Use a valid UK location.');
    const data = {
      description: text(input.description), venue: text(input.venue, 200), address: text(input.address, 500),
      category: text(input.category || 'Live music', 100), image: text(input.image || '/assets/hero.webp', 500),
      lat: Number(input.lat), lng: Number(input.lng), doorsAt: text(input.doorsAt, 40),
      age: text(input.age, 200), accessibility: text(input.accessibility), lineup: text(input.lineup),
      policy: text(input.policy), notice: text(input.notice), demo: Boolean(input.demo),
      imageFit: input.imageFit === 'contain' ? 'contain' : 'cover'
    };
    if (!/^\/assets\/[\w./-]+\.(webp|png|jpg|jpeg)$/i.test(data.image) || data.image.includes('..')) fail('Choose an uploaded local image.');
    return this.tx(() => {
      const old = this.event(id);
      if (old?.demo && !data.demo) fail('Create a new event instead of converting a demonstration event.', 409);
      this.run(`INSERT INTO events VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,city=excluded.city,status=excluded.status,start_at=excluded.start_at,data=excluded.data`,
        id, text(input.title, 150), text(input.city, 100), input.status, new Date(input.startAt).toISOString(), JSON.stringify(data));
      const keep = [];
      for (const tier of input.tiers) {
        const tierId = tier.id || randomUUID();
        const existing = this.get('SELECT * FROM tiers WHERE id=?', tierId);
        if (existing && existing.event_id !== id) fail('Ticket tier belongs to another event.');
        const price = Number(tier.price), capacity = Number(tier.capacity);
        if (!Number.isInteger(price) || price < 100 || price > 1000000 || !Number.isInteger(capacity) || capacity < this.used(tierId) || capacity > 100000) fail('Tier price must be at least £1. Capacity must cover existing bookings and holds.');
        if (!text(tier.name)) fail('Ticket tier needs a name.');
        for (const date of [tier.opens, tier.closes]) if (date && !Number.isFinite(Date.parse(date))) fail('Invalid sales window.');
        if (tier.opens && tier.closes && Date.parse(tier.opens) >= Date.parse(tier.closes)) fail('Sales close must be after sales open.');
        this.run(`INSERT INTO tiers VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,price=excluded.price,capacity=excluded.capacity,opens=excluded.opens,closes=excluded.closes`,
          tierId, id, text(tier.name, 100), price, capacity, tier.opens || null, tier.closes || null);
        keep.push(tierId);
      }
      for (const tier of this.all('SELECT id FROM tiers WHERE event_id=?', id)) if (!keep.includes(tier.id)) {
        if (this.get('SELECT 1 FROM order_items WHERE tier_id=?', tier.id)) fail('Keep tiers with order history; close their sales window instead.');
        this.run('DELETE FROM tiers WHERE id=?', tier.id);
      }
      this.audit(actor, old ? 'event.updated' : 'event.created', id, `${input.status}; ${input.startAt}`);
      if (old && (old.status !== input.status || old.startAt !== new Date(input.startAt).toISOString()))
        for (const o of this.all("SELECT id,email FROM orders WHERE event_id=? AND status='paid'", id))
          this.queueMail(o.email, `Update: ${text(input.title,150)}`, `There is an update to your Mirari event.\nStatus: ${input.status}\nStart: ${new Date(input.startAt).toLocaleString('en-GB', { timeZone: 'Europe/London' })} (UK time)\n${data.notice}\nOpen My Tickets for the latest information.`, o.id);
      return this.event(id);
    });
  }
  reserve(input, now = Date.now()) {
    return this.tx(() => {
      this.expire(now);
      const event = this.event(input.eventId);
      if (!event || event.status !== 'published' || (this.mode !== 'demo' && event.demo) || Date.parse(event.startAt) <= now) fail('This event is not currently on sale.', 409);
      const name = String(input.name || '').trim().slice(0, 120), email = String(input.email || '').trim().toLowerCase().slice(0, 254);
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter your name and a valid email address.');
      const items = Array.isArray(input.items) ? input.items : [];
      if (!items.length || items.length > 10 || new Set(items.map(i => i.tierId)).size !== items.length) fail('Choose tickets.');
      let total = 0, count = 0;
      const lines = items.map(item => {
        const tier = event.tiers.find(t => t.id === item.tierId), quantity = Number(item.quantity);
        if (!tier || !Number.isInteger(quantity) || quantity < 1 || quantity > 8) fail('Choose between 1 and 8 tickets.');
        if ((tier.opens && Date.parse(tier.opens) > now) || (tier.closes && Date.parse(tier.closes) <= now)) fail('This ticket tier is not on sale.', 409);
        if (tier.available < quantity) fail('Not enough tickets remain. Please choose a smaller quantity.', 409);
        total += tier.price * quantity; count += quantity;
        return { tier, quantity };
      });
      if (count > 8) fail('Maximum 8 tickets per order.');
      const id = randomUUID(), access = token(), expires = now + 31 * 60 * 1000;
      this.run('INSERT INTO orders(id,event_id,name,email,status,total,expires,created,access_hash,access_token,marketing,booking_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        id, event.id, name, email, 'pending', total, expires, now, hash(access), access, input.marketing === true ? 1 : 0, this.mode);
      for (const { tier, quantity } of lines) this.run('INSERT INTO order_items VALUES(?,?,?,?,?)', id, tier.id, tier.name, tier.price, quantity);
      this.audit('guest', 'reservation.created', id, `${count} tickets`);
      return this.order(id);
    });
  }
  order(id) {
    const o = this.get('SELECT * FROM orders WHERE id=?', id);
    return o ? { ...o, event: this.event(o.event_id), items: this.all('SELECT * FROM order_items WHERE order_id=?', id), tickets: this.all('SELECT * FROM tickets WHERE order_id=?', id) } : null;
  }
  fulfil(id, details = {}) { return this.tx(() => this._fulfil(id, details)); }
  _fulfil(id, { amount, currency = 'gbp', paymentId = 'demo', webhookId = token(), sessionId = null, clientReferenceId = null, provider = false } = {}) {
      const o = this.order(id);
      if (!o) fail('Order not found.', 404);
      if (this.mode !== 'demo' && (!provider || paymentId === 'demo')) fail('Provider payment verification is required before issuing tickets.', 409);
      if (this.get('SELECT 1 FROM webhook_events WHERE id=?', webhookId)) return o;
      this.run('INSERT INTO webhook_events VALUES(?,?)', webhookId, Date.now());
      if (['paid','refunding','refunded','payment_review'].includes(o.status)) return o;
      if (provider && (!sessionId || sessionId !== o.stripe_session || clientReferenceId !== id || !paymentId || paymentId === 'demo')) {
        this.alert('payment_mismatch', id, 'Checkout Session, order reference or payment intent did not match the reservation.');
        return o;
      }
      if (paymentId !== 'demo' && this.get('SELECT id FROM orders WHERE payment_id=? AND id<>?', paymentId, id)) {
        this.alert('payment_reused', id, 'A provider payment ID was already bound to another order.');
        return o;
      }
      const providerState = paymentId === 'demo' ? null : this.get('SELECT * FROM provider_state WHERE payment_id=?', paymentId);
      const pendingRefund = paymentId !== 'demo' && this.get("SELECT 1 FROM refund_attempts WHERE payment_id=? AND status IN ('claimed','sending','pending','unknown') LIMIT 1",paymentId);
      if (providerState?.fully_refunded || providerState?.disputed || providerState?.amount_refunded || ['pending','unknown'].includes(providerState?.refund_status) || pendingRefund) {
        if (providerState?.amount_refunded && !providerState.fully_refunded && !providerState.disputed) {
          this.run("UPDATE orders SET status='payment_review',payment_id=? WHERE id=?", paymentId, id);
          this.alert('partial_refund', id, 'Payment was partially refunded before ticket fulfilment. Review with Stripe.');
          return this.order(id);
        }
        this.run('UPDATE orders SET status=?,payment_id=? WHERE id=?', providerState?.fully_refunded ? 'refunded' : providerState?.disputed ? 'disputed' : 'refunding', paymentId, id);
        this.audit('payment', providerState?.fully_refunded ? 'payment.refunded-before-fulfilment' : providerState?.disputed ? 'payment.disputed-before-fulfilment' : 'payment.refund-pending-before-fulfilment', id);
        if (providerState?.disputed) this.alert('dispute', id, 'Payment is disputed. Admission is blocked until an organiser reviews it.');
        return this.order(id);
      }
      const invalid = amount !== o.total || currency !== 'gbp' || o.event.status !== 'published' || o.items.some(i => {
        const t = this.get('SELECT capacity FROM tiers WHERE id=?', i.tier_id);
        return !t || t.capacity - this.used(i.tier_id, id) < i.quantity;
      });
      if (invalid) {
        this.run("UPDATE orders SET status='payment_review',payment_id=? WHERE id=?", paymentId, id);
        this.audit('payment', 'payment.requires-refund', id, 'No tickets issued: amount, event status or inventory changed.');
        this.alert('payment_review', id, 'Payment received without tickets. Verify the provider payment and arrange a refund promptly.');
        return this.order(id);
      }
      this.run("UPDATE orders SET status='paid',payment_id=? WHERE id=?", paymentId, id);
      for (const item of o.items) for (let i = 0; i < item.quantity; i++)
        this.run('INSERT INTO tickets(id,order_id,tier_name,token) VALUES(?,?,?,?)', randomUUID(), id, item.name, token());
      this.audit('payment', 'order.paid', id, paymentId);
      // Created in the same transaction as fulfilment: retrying a webhook cannot lose or duplicate the email.
      this.queueMail(o.email, `Your Mirari tickets · ${o.event.title}`, `Thank you, ${o.name}.\nYour tickets are ready.\n{{ORDER_LINK:${id}}}\nKeep this private link safe; it grants access to your tickets.`, id);
      return this.order(id);
  }
  ingestProviderEvent(event) {
    return this.tx(() => {
      const { id, type, paymentId, sessionId = null, orderId = null } = event;
      if (!id || !type) fail('Provider event is incomplete.', 400);
      const staged = this.get('SELECT result FROM provider_events WHERE id=?', id);
      if (staged?.result === 'processed') return 'duplicate';
      if (!staged) this.run('INSERT INTO provider_events VALUES(?,?,?,?,?,?,?,?)', id, type, paymentId || null, sessionId, orderId, Date.now(), 'received', '{}');
      else this.run('UPDATE provider_events SET payment_id=?,session_id=?,order_id=? WHERE id=?', paymentId || null, sessionId, orderId, id);
      if (paymentId && (event.fullyRefunded !== undefined || event.disputed !== undefined || event.refundStatus || event.amountRefunded !== undefined)) {
        const old = this.get('SELECT * FROM provider_state WHERE payment_id=?', paymentId);
        const full = Boolean(old?.fully_refunded || event.fullyRefunded);
        const disputed = event.disputed === undefined ? Boolean(old?.disputed) : Boolean(event.disputed);
        const amountRefunded = Math.max(Number(old?.amount_refunded||0),Number(event.amountRefunded||0));
        this.run(`INSERT INTO provider_state(payment_id,fully_refunded,disputed,refund_status,updated_at,amount_refunded) VALUES(?,?,?,?,?,?) ON CONFLICT(payment_id) DO UPDATE SET
          fully_refunded=excluded.fully_refunded,disputed=excluded.disputed,refund_status=excluded.refund_status,updated_at=excluded.updated_at,amount_refunded=excluded.amount_refunded`,
          paymentId, Number(full), Number(disputed), event.refundStatus || old?.refund_status || null, Date.now(), amountRefunded);
        const existing = this.get('SELECT id,status FROM orders WHERE payment_id=?', paymentId);
        if (existing) {
          if (event.refundId) this.run('UPDATE orders SET refund_id=? WHERE id=? AND (refund_id IS NULL OR refund_id=?)', event.refundId, existing.id, event.refundId);
          if (full) {
            this.run("UPDATE orders SET status='refunded',refund_status='succeeded' WHERE id=? AND status<>'refunded'", existing.id);
            if (existing.status !== 'refunded') {
              this.audit('stripe', 'order.refunded', existing.id);
              const o = this.order(existing.id);
              this.queueMail(o.email, `Refund confirmed · ${o.event.title}`, `Your order has been refunded. These tickets are no longer valid.\n{{ORDER_LINK:${o.id}}}`, o.id);
            }
            this.resolveAlert('refund_failed', existing.id);
            this.resolveAlert('refund_pending', existing.id);
          }
          else if (disputed) {
            this.run("UPDATE orders SET status='disputed' WHERE id=? AND status IN ('paid','refunding','payment_review')", existing.id);
            this.alert('dispute', existing.id, 'Payment is disputed. Admission is blocked pending organiser review.');
          } else if (amountRefunded > 0 && existing.status === 'paid') {
            this.run("UPDATE orders SET status='payment_review' WHERE id=?", existing.id);
            this.alert('partial_refund', existing.id, 'Payment is partly refunded. Review which tickets remain valid.');
          } else if (event.refundStatus === 'failed' && existing.status === 'refunding') {
            const tickets = this.get('SELECT 1 FROM tickets WHERE order_id=?', existing.id);
            this.run('UPDATE orders SET status=?,refund_status=? WHERE id=?', tickets ? 'paid' : 'payment_review', 'failed', existing.id);
            this.alert('refund_failed', existing.id, 'The provider refund failed. Review the payment and retry using a new refund request.');
          } else if (event.refundStatus === 'pending' && existing.status === 'paid' && event.refundAmount === this.get('SELECT total FROM orders WHERE id=?',existing.id).total) {
            this.run("UPDATE orders SET status='refunding',refund_status='pending' WHERE id=?", existing.id);
          } else if (event.refundStatus === 'succeeded' && event.refundAmount && event.refundAmount < this.get('SELECT total FROM orders WHERE id=?',existing.id).total) {
            this.run("UPDATE orders SET status='payment_review' WHERE id=? AND status='paid'", existing.id);
            this.alert('partial_refund', existing.id, 'A partial refund was made outside Mirari. Review which tickets remain valid.');
          } else if (event.disputed === false && existing.status === 'disputed') {
            this.run("UPDATE orders SET status='paid' WHERE id=? AND EXISTS(SELECT 1 FROM tickets WHERE order_id=?)", existing.id, existing.id);
            this.resolveAlert('dispute', existing.id);
          }
        }
      }
      if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
        if (event.paymentStatus === 'paid' && orderId && this.get('SELECT 1 FROM orders WHERE id=?', orderId)) this._fulfil(orderId, {
          amount: event.amount, currency: event.currency, paymentId, webhookId: id,
          sessionId, clientReferenceId: event.clientReferenceId, provider: event.strict !== false
        });
        else if (event.paymentStatus === 'paid') this.alert('unmatched_payment', id, 'A paid provider session did not identify an existing order. Investigate and refund if needed.');
      } else if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
        this.run("UPDATE orders SET status='expired' WHERE stripe_session=? AND status='pending'", sessionId);
      }
      this.run("UPDATE provider_events SET result='processed' WHERE id=?", id);
      return 'processed';
    });
  }
  applyRefundResult(id, refund) {
    return this.tx(() => {
      const o = this.order(id);
      if (!o) fail('Order not found.', 404);
      if (o.status === 'refunded') return o;
      const status = refund.status === 'succeeded' ? 'refunded' : refund.status === 'failed' ? (o.tickets.length ? 'paid' : 'payment_review') : 'refunding';
      this.run('UPDATE orders SET status=?,refund_status=?,refund_id=? WHERE id=?', status, refund.status, refund.id, id);
      if (refund.status === 'failed') this.alert('refund_failed', id, 'The provider refund failed. Review the payment and retry using a new refund request.');
      if (status === 'refunded') {
        this.queueMail(o.email, `Refund confirmed · ${o.event.title}`, `Your order has been refunded. These tickets are no longer valid.\n{{ORDER_LINK:${id}}}`, id);
        this.resolveAlert('refund_failed', id);this.resolveAlert('refund_pending', id);
      }
      return this.order(id);
    });
  }
  checkIn(ticketToken, actor, eventId) {
    return this.tx(() => {
      const t = this.get('SELECT * FROM tickets WHERE token=?', ticketToken);
      if (!t) fail('Invalid ticket.', 404);
      const o = this.order(t.order_id);
      if (eventId && o.event_id !== eventId) fail('This ticket is for a different event.', 409);
      if (o.status !== 'paid' || o.event.status !== 'published') fail('Ticket is not valid for admission.', 409);
      if (o.booking_mode !== this.mode || (this.mode === 'demo') !== (o.payment_id === 'demo') || (this.mode !== 'demo' && o.event.demo)) fail('This ticket belongs to a different booking environment and is not valid for admission.', 409);
      if (t.checked_at) fail(`Already checked in at ${new Date(t.checked_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })} UK time.`, 409);
      this.run('UPDATE tickets SET checked_at=?,checked_by=? WHERE id=? AND checked_at IS NULL', Date.now(), actor, t.id);
      this.audit(actor, 'ticket.checked-in', t.id, o.event.title);
      return { valid: true, testOnly: this.mode !== 'stripe-live', mode: this.mode, name: o.name, tier: t.tier_name, event: o.event.title };
    });
  }
  queueMail(recipient, subject, body, orderId = null) {
    const id = randomUUID();
    const origin = orderId ? this.get('SELECT booking_mode FROM orders WHERE id=?', orderId)?.booking_mode || this.mode : this.mode;
    this.run('INSERT INTO mail(id,recipient,subject,body,status,created,order_id,origin_mode) VALUES(?,?,?,?,?,?,?,?)', id, recipient, subject, body, 'pending', Date.now(), orderId, origin);
    return id;
  }
  supersedeStaleMail() {
    this.run(`UPDATE mail SET status='superseded',error=NULL
      WHERE origin_mode=? AND status IN ('pending','failed') AND order_id IS NOT NULL AND (
        (subject LIKE 'Your Mirari tickets · %' AND EXISTS(
          SELECT 1 FROM orders o WHERE o.id=mail.order_id AND o.status IN ('refunded','expired','cancelled')))
        OR (subject LIKE 'Refund confirmed · %' AND EXISTS(
          SELECT 1 FROM orders o WHERE o.id=mail.order_id AND o.status<>'refunded'))
        OR (subject LIKE 'Important update about your Mirari refund · %' AND EXISTS(
          SELECT 1 FROM orders o WHERE o.id=mail.order_id AND COALESCE(o.refund_status,'')<>'failed'))
      )`, this.mode);
  }
  pendingDeliverableMail(limit = 10) {
    return this.all(`SELECT m.* FROM mail m LEFT JOIN orders o ON o.id=m.order_id LEFT JOIN events e ON e.id=o.event_id
      WHERE m.status='pending' AND m.origin_mode=? AND (m.order_id IS NULL OR o.booking_mode=?)
        AND (m.subject NOT LIKE 'Your Mirari tickets · %' OR (o.status='paid' AND e.status='published'))
        AND (m.subject NOT LIKE 'Refund confirmed · %' OR o.status='refunded')
        AND (m.subject NOT LIKE 'Important update about your Mirari refund · %' OR o.refund_status='failed')
      ORDER BY m.created LIMIT ?`, this.mode, this.mode, limit);
  }
  setting(key, fallback = '') { return this.get('SELECT value FROM settings WHERE key=?', key)?.value ?? fallback; }
  setSetting(key, value) { this.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)); }
}
