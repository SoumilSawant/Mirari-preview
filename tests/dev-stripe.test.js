import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSigningSecret, validateLocalConfig } from '../scripts/dev-stripe.mjs';

const config = {
  APP_MODE: 'stripe-test',
  STRIPE_SECRET_KEY: 'sk_test_fixture',
  DATABASE_PATH: 'data/mirari-staging.sqlite',
  APP_URL: 'http://127.0.0.1:4173',
  HOST: '127.0.0.1',
  PORT: '4173'
};

test('local Stripe runner only accepts isolated loopback test configuration', () => {
  assert.equal(validateLocalConfig(config), 'http://127.0.0.1:4173/api/stripe/webhook');
  for (const changed of [
    { APP_MODE: 'demo' },
    { STRIPE_SECRET_KEY: 'sk_live_fixture' },
    { DATABASE_PATH: 'data/mirari.sqlite' },
    { DATABASE_PATH: '' },
    { APP_URL: 'https://mirari.example' },
    { APP_URL: 'http://127.0.0.1:5000' },
    { HOST: '0.0.0.0' }
  ]) assert.throws(() => validateLocalConfig({ ...config, ...changed }));
});

test('local Stripe runner requires exactly one CLI signing secret', () => {
  assert.equal(parseSigningSecret('Ready! Your webhook signing secret is whsec_fixture123'), 'whsec_fixture123');
  assert.throws(() => parseSigningSecret('No secret'));
  assert.throws(() => parseSigningSecret('whsec_one whsec_two'));
});
