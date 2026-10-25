# Mirari

A full-stack UK event booking application with the supplied logo, burgundy/ivory/gold design, cinematic artwork, interactive UK Night Atlas and responsive animations.

## Run locally

Requires **Node.js 24+**, including its built-in SQLite module.

```powershell
npm ci
npm run dev
```

Open **http://127.0.0.1:4173**. Use the server URL, not `index.html` through `file://`.

Default **demo mode** seeds six clearly labelled fictional events. Demo checkout issues test QR tickets but takes no money and sends no email. Set `APP_MODE=demo` explicitly in `.env`; `NODE_ENV` does not choose the payment mode.

Open `/admin` or Organiser sign-in in the footer. A random local account is generated on first startup in **`.local-admin.txt`**. Read that private file for its email/password. It is ignored by Git and never served publicly.

Copy `.env.example` to `.env` to configure settings. Restart after environment changes. Ctrl+C stops the server.

## Customer and organiser flow

1. Choose a city in the atlas or search/filter Events.
2. Open an event, choose quantities, enter name/email, review the full GBP price and accept the demo terms. Promotional consent is separate and unchecked.
3. Reserve, then choose **Complete demo payment**.
4. Confirmation displays one unique QR per ticket. Print or save as PDF using the browser print dialog.
5. My Tickets remembers orders for this browser session. For another browser, request a recovery email. In demo mode, find the private link in **Admin → Email outbox**. Recovery links expire in 15 minutes and are single-use.
6. Under **Admin → Check-in**, select the event and paste a ticket token or use a phone camera. Repeat, invalid, wrong-event and refunded scans are rejected.

Admin also supports event creation/editing, publication, postponement, cancellation, artwork uploads, ticket tiers, capacities, sales windows, orders, attendees, full refunds, email retries, editable policies and an audit trail.

### Mirari content and Diwali Pahat announcement

The homepage uses Mirari's supplied London cultural-experiences copy. Its current hero and About photographs remain illustrative assets; they are not photographs of an actual Mirari event. The five experience categories and the community section provide information but do **not** collect newsletter addresses. Do not claim customers can subscribe until an approved mailing flow exists.

The supplied `diwali 1.png` is preserved as `assets/originals/diwali-pahat-2026.png` and optimised to `assets/diwali-pahat-2026.webp`. `content/diwali-pahat-london-2026.json` records the confirmed 8 November 2026, 11:00 GMT, Pembroke Lodge announcement and the supplied event wording. The map coordinates are approximate and need organiser verification against the venue before ticket sales. Planned highlights remain labelled as such, including the food vendor caveat. The event has **no ticket tiers or prices** and uses `announced` status: it appears publicly as “Tickets coming soon”, with checkout hidden and server-side reservations rejected. A `draft` remains hidden; only a `published` event with at least one valid tier can accept bookings.

To add the announcement to an existing **Stripe test** database, first take a backup, then run `npm run import:event-announcement` with explicit `APP_MODE=stripe-test` and `DATABASE_PATH` in the private `.env`. The importer refuses to create a database, overwrite an organiser-edited event, or add any price. The local staging database received this announcement after a verified backup. The JSON manifest makes it reproducible in a later clean environment; do not copy staging orders into a live database. After the organiser supplies final ticket tiers, capacities, sales windows, doors time, age/ID rules, access information, support contact and approved policies, edit the event in Admin and publish only after testing. A live environment is not implemented in this version.

Cancelling an event blocks admission and queues customer updates; it does **not** automatically refund all orders. Refund affected orders in Orders. Capacity is allocated per tier, so the sum of tier capacities must match your venue allocation.

Do not publicly share order links or QR tokens.

## Architecture and safeguards

Express serves browser JavaScript and a same-origin API. SQLite persists events, tiers, reservations, orders, tickets, admission, sessions, policies and an email outbox. This keeps the existing project runnable without a build service or external database account.

Write transactions protect inventory and admission against concurrent requests. Reservations normally last 31 minutes. Stripe-backed holds remain reserved until the provider confirms expiry, cancellation or payment. A late payment that cannot fulfil safely enters `payment_review` for an organiser refund.

Stripe Checkout collects payment details externally. Success redirects cannot issue tickets. Signed webhooks are recorded before processing; fulfilment checks the current Checkout Session and PaymentIntent, order reference, session ID, amount, GBP currency, refund and dispute state. Provider payment IDs are unique across orders. A fully refunded or disputed payment cannot admit a ticket. QR tokens are random and opaque. Admin uses asynchronous scrypt verification, optional local or required production authenticator MFA, expiring HTTP-only sessions and same-origin mutation checks. Rate limits are stored in SQLite so they survive a process restart. There is no public registration.

The atlas uses local SVG geography, so it needs no map account or WebGL. Non-map lists remain available. Motion uses opacity/transforms and IntersectionObserver. Mobile reduces camera movement; reduced-motion preferences disable parallax, camera flight and reveal delays.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` / `HOST` | Default `4173` / `127.0.0.1` |
| `APP_URL` | Exact public origin without trailing slash; used for private links and origin validation |
| `APP_MODE` | `demo` or `stripe-test`; defaults to `demo` locally. There is no live mode |
| `DEMO_MODE` | Deprecated compatibility setting; use `APP_MODE` instead. Conflicting values fail startup |
| `DATABASE_PATH` | Default `data/mirari.sqlite`; use persistent storage |
| `UPLOADS_PATH` | Default `assets/uploads`; set to a dedicated persistent uploads directory when deployed |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Explicit organiser account; password at least 12 characters |
| `ADMIN_TOTP_SECRET` | Base32 authenticator secret; required in production |
| `TRUSTED_PROXY_CIDRS` | Exact reverse proxy IP/CIDR list; required in production. Do not trust arbitrary forwarded headers |
| `NODE_ENV` | `production` for HTTPS deployment |
| `STRIPE_SECRET_KEY` | Required in Stripe test mode; must begin `sk_test_` |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this webhook endpoint |
| `STRIPE_PAYMENT_METHODS` | `card`, optionally `card,paypal` if account eligible |
| `PAYMENT_CHECKIN_MAX_AGE_MS` | Provider verification freshness at admission; default 0 checks Stripe every scan, maximum 5000 ms |
| `RESEND_API_KEY` / `EMAIL_FROM` | Transactional email API key and verified-domain sender |

Secrets, database files and uploads are ignored by Git. Protect private database/backup access because it contains customer data and ticket links. Run one Node process against the persistent SQLite file behind one known HTTPS reverse proxy. Configure that proxy to **replace** client-forwarding headers, and set `TRUSTED_PROXY_CIDRS` to its exact address. Never use a wildcard trust setting. If the proxy topology changes, verify `req.ip` and rate-limit behavior before opening bookings. `NODE_ENV=production` requires HTTPS, explicit admin credentials, MFA and a trusted proxy; Stripe test mode additionally requires a verified email sender. It does not enable real payments.

### Separate demo and Stripe test environments

Keep the existing `data/mirari.sqlite` file for demo history. Before switching the application mode, make a backup. Use a **different** persistent file such as `data/mirari-staging.sqlite` for Stripe test staging. Do not copy demo orders into staging or relabel a fictional event as real. Create new organiser events with confirmed business details. A separate `APP_URL`, email sender and webhook endpoint should point to staging. Keep the staging site access controlled while testing.

For local demo, use `APP_MODE=demo`, `DATABASE_PATH=data/mirari.sqlite`, `NODE_ENV=development` and leave Stripe/Resend keys empty. For Stripe test staging, use `APP_MODE=stripe-test`, `DATABASE_PATH=data/mirari-staging.sqlite`, an `sk_test_` key, the signing secret for that staging endpoint, and the staging `APP_URL`. Configure Resend to test delivery; readiness stays false without it. This app refuses `sk_live_` keys. Test Checkout does not move real money. The customer site and printable tickets remain visibly marked as tests, and test check-ins are simulations only.

For a **local** Stripe test session, set `APP_URL=http://127.0.0.1:4173`, `HOST=127.0.0.1`, `PORT=4173`, the separate staging database, and the matching sandbox `sk_test_` key in `.env`. Run `stripe login` once and select only the Mirari sandbox. Then start both Mirari and its webhook listener in one terminal with `npm run dev:stripe`; wait for “Stripe sandbox listener ready” before testing. The command checks that the CLI account and key match, forwards all required payment/refund/dispute events, and gives Mirari the current CLI signing secret without printing it. It stops Mirari if the listener exits, so a closed listener cannot silently leave the local app accepting payments. Keep that terminal open throughout each test. Use `Ctrl+C` to stop both. Do not start a separate `npm run dev` or `stripe listen` on the same port. This runner is for loopback testing; a deployed staging site needs its own configured HTTPS Stripe webhook endpoint and signing secret.

If a refund event is missed, Stripe still records it. Mirari's periodic reconciliation and admission checks must converge to Stripe's current state; inspect `/api/admin/alerts` and the email outbox for any correction. The local runner reports HTTP delivery status from the Stripe CLI. HTTP 200 means Mirari accepted the webhook; HTTP 400 indicates a signing-secret mismatch and HTTP 503 indicates processing failed and needs investigation. Refund status transitions can be asynchronous, so confirm final Stripe and Mirari states after the later update arrives.

Email is a separate integration. Until both `RESEND_API_KEY` and `EMAIL_FROM` are configured, Stripe test messages remain pending and customer email recovery reports that delivery is unavailable. Before enabling email, review **Admin → Email outbox**: eligible pending Stripe test messages will send automatically on the next worker run. Old demo messages remain held. Pending ticket confirmations for refunded, expired or cancelled orders are superseded; ticket confirmations for uncertain payments are held until the order is paid and the event is published. Refund confirmations are sent only while the order is refunded, and failed-refund corrections only while the failure remains current. Do not treat a queued message or a provider API acceptance as proof that a customer received it.

If the app is deliberately pointed at an old demo database in Stripe test mode, sample events disappear from public listings but remain labelled in admin and direct event previews. Old demo order pages stay labelled, their tickets cannot pass a test-mode check-in, and their queued emails remain held. This is a safety fallback, **not** a recommendation to share one database between environments. Version 3 migrations classify historical provider-backed orders as Stripe test orders; ambiguous historical orders and orderless emails are conservatively classified as demo. Version 4 keeps old recovery links demo-only. All existing records are preserved.

## Database migration and recovery

Schema migrations are versioned with SQLite `PRAGMA user_version`. Startup upgrades legacy schema through version 4 in transactions and retains all orders, tickets and events. Version 2 adds durable Checkout attempts, individual refund attempts and dispute records; version 3 records each order's booking mode and each queued email's origin; version 4 records the origin of recovery links. Older provider records remain for audit. Old refund rows are imported as unverified history and must be reconciled with Stripe before reliance. A unique provider payment index makes duplicate payment IDs impossible; if old data violates it, startup fails rather than silently changing data. Take a backup before any upgrade. Do not reset the database.

To create a consistent snapshot while the app is running:

```powershell
npm run backup -- data/backups/mirari-YYYYMMDD.sqlite
```

The backup command refuses to overwrite an existing file and checks SQLite integrity. Also back up the `UPLOADS_PATH` directory (default `assets/uploads/`) separately. Keep backups encrypted with restricted access and rehearse restoration regularly. To restore: stop the Node service, retain the damaged database and its `-wal`/`-shm` files for investigation, copy a verified snapshot to a **new** database path, copy the corresponding uploads, set `DATABASE_PATH` and `UPLOADS_PATH` to the restored paths and start the service. Check `/api/health`, `/api/admin/health`, a known order and an event before directing traffic to it. The automated restore test in `tests/migration.test.js` exercises a snapshot on a separate temporary database.

## Organiser MFA and monitoring

Generate a secret with `npm run mfa-secret`. Add it manually to an authenticator app as a time-based six-digit code, then put the secret in `ADMIN_TOTP_SECRET` in the private deployment environment. Verify login and recovery access before enforcing it. Production startup requires the secret. Codes are valid within a small clock-skew window and cannot be replayed. Keep a secure recovery procedure for loss of the authenticator; there is no self-service bypass.

`/api/health` checks DB connectivity; `/api/ready` also verifies that checkout and email configuration exists outside demo mode. After sign-in, `/api/admin/health` reports open alerts, failed email, unprocessed webhooks and unresolved payment states; `/api/admin/alerts` gives actionable details. Monitor those counts and service logs, especially `payment_review`, `refund_pending`, `refund_uncertain`, `checkout_attempt`, `dispute`, `email_failed`, `webhook_processing` and `stuck_checkout`. A payment review means money may have been taken without tickets and needs prompt human action. Webhook events are durably retried; email outbox failures require organiser retry. The reconciliation worker checks bound pending Checkout Sessions promptly after startup and every minute, including before their reservation expiry, along with unbound attempts, unresolved payments and a bounded rotation of paid orders. It fairly rotates older pending orders and limits repeat provider checks to once per minute per order. This recovers a payment if a webhook is missed, but the webhook listener must still be fixed and tested. Provider-backed holds and uncertain Checkout attempts are never released merely by local time expiry.

For provider-backed tickets, admission checks Stripe if the last verified state is older than `PAYMENT_CHECKIN_MAX_AGE_MS`. The default is `0`, so every scan checks Stripe; a refund, dispute, invalid PaymentIntent or provider outage blocks admission. Raising the limit can reduce repeated API calls but creates a brief stale-state window. Refunds are recorded by attempt and Stripe refund ID. An unknown response is retried with the same idempotency key. The organiser must review an attempt older than Stripe's idempotency retention before another attempt. A later failed refund raises an alert and queues a correction to the customer; unsent or failed earlier refund-confirmation emails are superseded. Refunded orders remain in the bounded, fair reconciliation rotation because a previously successful refund can later fail even if its webhook is missed. External partial refunds block admission pending review. Keep the Stripe listener running and verify refund-event delivery; periodic reconciliation is a recovery path, not a replacement for working webhooks.

## Before accepting real payments

1. Configure a Stripe account with **test keys only**. This version refuses `sk_live_` keys. Register `/api/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`, `charge.dispute.created` and `charge.dispute.closed`. Use that endpoint's signing secret. Stripe's official CLI can forward test events to localhost. Do not treat generated CLI events as a substitute for an actual Checkout, refund and dispute run.
2. Hosted card checkout can show Apple Pay/Google Pay on eligible accounts, browsers and devices. PayPal requires provider/account eligibility and configuration.
3. Verify a sender domain with Resend and supply its API key/sender. Pending outbox messages are attempted every 15 seconds; failed ones can be retried by admin. Demo mode deliberately holds emails locally.
4. Set explicit admin credentials, MFA, exact trusted proxy IPs, HTTPS `APP_URL`, `NODE_ENV=production`, `APP_MODE=stripe-test` and separate persistent staging storage. Use a separate future real-event database rather than treating demo or test orders as real sales.
5. Publish Mirari's actual terms, refunds/postponement, privacy, cookies, accessibility and contact information. Live checkout is blocked until terms, refunds, privacy and contact content exist. The app does not invent legal terms or calculate Mirari's tax liability. Enter prices inclusive of mandatory fees and applicable taxes.
6. Create real events and clear their demo flag. Verify venue capacity, times, policies and accessibility.
7. Test provider checkout, authentication challenges, cancellation, webhook retries, email delivery, refunds and a physical-phone QR scan before launch.

Production startup requires explicit admin credentials, MFA, a trusted proxy and HTTPS. In Stripe test mode it also requires Stripe test keys and Resend. **Real Stripe transactions and real email delivery have not been exercised with Mirari credentials. Live payments are disabled.**

## Operational limits

Run one Node service on persistent local storage behind HTTPS. SQLite-backed rate limits are shared by processes using the same database, but independent replicas, ephemeral serverless storage and cross-host SQLite are unsupported. Back up SQLite consistently and verify restoration before launch.

One organiser account is supported, without staff roles or self-service MFA recovery. There is no assigned seating, offline scanning, wallet passes, partial refund workflow or transfer workflow. A partial refund made externally blocks admission pending review. Email provides a private link to QR tickets, not PDF attachments. Camera scanning needs permission and HTTPS or localhost; the physical camera path still needs phone testing.

There are no analytics/advertising cookies. Legal wording, data-retention procedures and business policies remain to be supplied by Mirari.

## Verification

```powershell
npm run check
npm test
node tests/ui.mjs
node tests/mode-ui.mjs
node tests/content-ui.mjs
```

Tests cover expiry, provider-backed holds, concurrent last-ticket booking, capacity/sales limits, payment binding, out-of-order and duplicate events, refunds, disputes, restart durability, migration and backup restoration, cancellation, invalid/duplicate/refunded admission and an isolated HTTP customer/admin flow. Mode-switch tests cover historical demo events, orders, mail and admission after a restart. The two browser scripts check desktop and mobile customer/admin pages in demo and Stripe test modes. HTTP tests include signed mock provider events, QR generation, one-use recovery, event creation and refunds; they make no real charges. Run a separate end-to-end test with real Stripe test-mode credentials and a configured webhook endpoint before any launch, including 3DS, async payment failure, refund success/failure and dispute events. Confirm the Resend verified sender delivers to a real test inbox. Demo mode never calls Stripe for a charge or sends email.

The HTTP test starts a loopback server. Restricted sandboxes must allow localhost connections. Screenshots are in `output/screenshots/`.

## Project files and asset credits

- `server.js`: API, authentication, Stripe and email.
- `lib/store.js`: persistence, transactions and ticket lifecycle.
- `lib/seed.js`: fictional sample events.
- `public/app.js`, `public/admin.js`, `styles.css`: responsive interface.
- `assets/mirari-logo-transparent.png`: supplied logo, preserved.
- `assets/*.webp`: generated illustrative concert, jazz, electronic and classical artwork; not confirmed Mirari event photography.
- `public/map-data.json`: local UK/Ireland outlines from public-domain [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/).
- `scripts/prepare-assets.mjs`: development helper referencing original local generated files. Prepared assets are included; running it is unnecessary.
- `.reference/original/`: retained original prototype.

Integration references: [Stripe fulfilment](https://docs.stripe.com/checkout/fulfillment), [Stripe webhooks](https://docs.stripe.com/webhooks), [Resend](https://resend.com/docs).
