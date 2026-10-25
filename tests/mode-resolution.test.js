import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppMode } from '../lib/mode.js';

test('NODE_ENV alone never changes the payment mode', () => {
  assert.equal(resolveAppMode({ NODE_ENV: 'development' }), 'demo');
  assert.equal(resolveAppMode({ NODE_ENV: 'production' }), 'demo');
  assert.equal(resolveAppMode({ NODE_ENV: 'production', APP_MODE: 'stripe-test' }), 'stripe-test');
  assert.equal(resolveAppMode({ NODE_ENV: 'production', APP_MODE: 'stripe-live' }), 'stripe-live');
});

test('legacy DEMO_MODE is supported only when it does not conflict', () => {
  assert.equal(resolveAppMode({ DEMO_MODE: 'true' }), 'demo');
  assert.equal(resolveAppMode({ DEMO_MODE: 'false' }), 'stripe-test');
  assert.throws(() => resolveAppMode({ APP_MODE: 'demo', DEMO_MODE: 'false' }), /conflicting/);
  assert.throws(() => resolveAppMode({ APP_MODE: 'live' }), /APP_MODE/);
  assert.throws(() => resolveAppMode({ DEMO_MODE: 'maybe' }), /APP_MODE/);
});
