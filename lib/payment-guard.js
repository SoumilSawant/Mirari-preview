import { fail } from './store.js';

export async function verifyAdmissionPayment(store, order, fetchState, maxAgeMs = 3000, now = Date.now()) {
  if (!order?.payment_id || order.payment_id === 'demo' || order.status !== 'paid') return;
  const state = store.get('SELECT verified_at FROM provider_state WHERE payment_id=?', order.payment_id);
  if (maxAgeMs > 0 && state?.verified_at && now - state.verified_at <= maxAgeMs) return;
  try {
    store.applyProviderSnapshot(order.payment_id, await fetchState(order.payment_id));
  } catch (error) {
    store.alert('admission_provider_unavailable', order.id, 'Stripe payment status could not be checked at admission. Do not admit until verified.');
    console.error('Admission verification failed', order.id, error.name);
    fail('Payment verification is unavailable. Do not admit this ticket yet.', 503);
  }
  if (store.order(order.id).status !== 'paid') fail('This ticket is not valid for admission.', 409);
}
