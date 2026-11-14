# Hosted Stripe test deployment (Render)

This guide puts the Mirari staging app on a real URL in **Stripe test mode**. No real money moves. It is
the rehearsal before anything live. The blueprint is [`render.yaml`](../render.yaml); it holds no secrets.

## What the owner must supply

| Item | Where it comes from |
| --- | --- |
| Render account on a **paid** plan | Needed for the persistent disk. Free plans lose data on restart. |
| `STRIPE_SECRET_KEY` (`sk_test_…`) | Stripe Dashboard, sandbox, API keys |
| `STRIPE_WEBHOOK_SECRET` (`whsec_…`) | Created in step 4 below. **Not** the CLI listener secret. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Chosen by the owner. Long and unique. |
| `ADMIN_TOTP_SECRET` | Run `npm run mfa-secret`, scan it into an authenticator app, store it safely. |
| `RESEND_API_KEY`, `EMAIL_FROM` | A Resend sender on a domain whose DNS is **verified**. Production start-up refuses to run without them. |
| `APP_URL` | `https://<service>.onrender.com` first; `https://mirari.events` only after DNS is verified. |

Never paste these into chat, a commit, or the YAML file.

## Steps

1. **Create the service.** Render dashboard, New, Blueprint, pick this repository and branch
   `codex/full-platform-staging`. Render reads `render.yaml`: Node 24, one instance, a 1 GB disk at
   `/var/data`, build `npm ci && npm run check && npm test`, start `npm start`.
2. **Fill the `sync: false` variables** in the dashboard (table above). Leave `APP_MODE=stripe-test`.
3. **First deploy.** The app creates an empty database at `/var/data/mirari-staging.sqlite`. Open
   `/api/health`; it should answer `{"status":"ok","mode":"stripe-test"}`.
4. **Register the hosted webhook.** Stripe Dashboard (sandbox), Developers, Webhooks, add an endpoint
   `https://<your-url>/api/stripe/webhook` for exactly these events: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `checkout.session.expired`, `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`,
   `charge.dispute.created`, `charge.dispute.closed`. Copy that endpoint's signing secret into
   `STRIPE_WEBHOOK_SECRET` and redeploy.
5. **Switch the health check** in the service settings from `/api/health` to `/api/ready` once Resend is set
   (`/api/ready` answers 503 until Stripe, the webhook secret and the email sender are all configured).
6. **Sign in to Admin** with the email, password and authenticator code. Add the approved policies and the
   event in Admin. Do not copy anything from a local database.
7. **Check the network setting.** Open `/api/admin/network` from two different networks (for example Wi-Fi and
   mobile data). `clientIp` must differ; if it does not, rate limits are not seeing real customer IPs.
8. **Run the test checklist** below on the hosted URL, with Stripe test cards only.
9. **Custom domain (later).** Add `mirari.events` in Render Custom Domains, copy the exact records into the
   active DNS zone **without removing the existing email records**, wait for HTTPS, then change `APP_URL`.

## Test checklist (hosted, test cards only)

- Checkout with `4242 4242 4242 4242` returns to Mirari, the order becomes **paid**, tickets and QR appear.
- Webhook deliveries show HTTP 200 in the Stripe Dashboard. Resend a failed one and confirm it is handled once.
- A declined card (`4000 0000 0000 0002`) leaves the order unpaid and the reservation recoverable.
- A 3-D Secure card (`4000 0025 0000 3155`) completes after the authentication step.
- Admin refund moves the order to **refunded** and the ticket is rejected at the door.
- A real phone scans a ticket QR at `/admin` check-in; a second scan of the same ticket is refused.
- The ticket email arrives from the verified sender; the "retrieve my tickets" link works.
- Stop the Stripe webhook (disable the endpoint) and confirm orders stay unpaid, not wrongly paid.
- `/api/admin/health` shows no open alerts. Check Render and Stripe logs for errors.

## Safety rules

- One instance, one disk. Never scale out, and never use free or ephemeral storage for orders.
- Keep separate database files for test and live (`mirari-staging.sqlite` now, a new `mirari-live.sqlite` later).
  Never copy test orders or tickets into live.
- Back up the database and `/var/data/uploads` (see `npm run backup`) and rehearse a restore.
- **This guide stops at test mode.** Going live needs the business Stripe account, a live webhook secret,
  `STRIPE_ACCOUNT_ID`, owner-approved policies (`LIVE_POLICIES_APPROVED=true`) and `ENABLE_LIVE_PAYMENTS=true`.
  Those are the owner's decisions; see the README's go-live section.
