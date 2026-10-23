export function resolveAppMode(env = process.env) {
  const legacy = env.DEMO_MODE === undefined ? null : env.DEMO_MODE === 'true' ? 'demo' : env.DEMO_MODE === 'false' ? 'stripe-test' : null;
  const mode = env.APP_MODE || legacy || 'demo';
  if (!['demo', 'stripe-test'].includes(mode) || env.DEMO_MODE !== undefined && legacy === null || env.APP_MODE && legacy && env.APP_MODE !== legacy) {
    throw new Error('Set APP_MODE to demo or stripe-test; do not set conflicting DEMO_MODE values.');
  }
  return mode;
}
