import { fail } from './store.js';

export async function ensureCheckoutSession(store, stripe, order, attempt, appUrl, methods = 'card', now = Date.now()) {
  if (!attempt.session_id && now - attempt.created_at > 23 * 3600000) fail('Checkout attempt needs manual reconciliation before retry.', 409);
  const session = attempt.session_id ? await stripe.checkout.sessions.retrieve(attempt.session_id) : await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: methods.split(',').map(s => s.trim()).filter(s => ['card', 'paypal'].includes(s)),
    customer_email: order.email,
    client_reference_id: order.id,
    metadata: { orderId: order.id },
    expires_at: Math.floor(order.expires / 1000),
    line_items: order.items.map(i => ({ price_data: { currency: 'gbp', unit_amount: i.price, product_data: { name: `${order.event.title} · ${i.name}` } }, quantity: i.quantity })),
    success_url: `${appUrl}/order/${order.id}#key=${order.access_token}`,
    cancel_url: `${appUrl}/order/${order.id}#key=${order.access_token}`
  }, { idempotencyKey: attempt.idempotency_key });
  store.bindCheckout(order.id, session);
  return session;
}
