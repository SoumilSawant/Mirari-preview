import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const eventTypes = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'charge.refunded',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.closed'
];

export function validateLocalConfig(env) {
  if (env.APP_MODE !== 'stripe-test') throw new Error('Set APP_MODE=stripe-test before using the local Stripe runner.');
  if (!env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new Error('A Stripe sk_test_ key is required. Live keys are refused.');
  if (!env.DATABASE_PATH || path.resolve(root, env.DATABASE_PATH) === path.join(root, 'data/mirari.sqlite')) {
    throw new Error('Set DATABASE_PATH to a separate Stripe test database.');
  }
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid local port.');
  const url = new URL(env.APP_URL || `http://127.0.0.1:${port}`);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port || 80) !== port || (env.HOST && !['127.0.0.1', 'localhost'].includes(env.HOST))) {
    throw new Error('The local Stripe runner requires APP_URL and HOST on loopback with the same PORT.');
  }
  return `${url.origin}/api/stripe/webhook`;
}

export function stripeCliCommand(env = process.env) {
  if (env.MIRARI_STRIPE_CLI_SHIM) return { command: process.execPath, prefix: [env.MIRARI_STRIPE_CLI_SHIM] };
  if (process.platform !== 'win32') return { command: 'stripe', prefix: [] };
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const shim = path.join(directory, 'node_modules/@stripe/cli/bin/shim.js');
    if (existsSync(shim)) return { command: process.execPath, prefix: [shim] };
  }
  throw new Error('Stripe CLI is not installed. Install it and run stripe login for the Mirari sandbox.');
}

export function parseSigningSecret(output) {
  const secrets = [...output.matchAll(/whsec_[A-Za-z0-9]+/g)].map(match => match[0]);
  if (secrets.length !== 1) throw new Error('Could not read one Stripe CLI webhook signing secret.');
  return secrets[0];
}

async function run() {
  const forwardTo = validateLocalConfig(process.env);
  const cli = stripeCliCommand();
  const cliArgs = args => [...cli.prefix, ...args];
  const runCli = async args => {
    const result = await execFileAsync(cli.command, cliArgs(args), { cwd: root, timeout: 45000, maxBuffer: 1024 * 1024 });
    return result.stdout;
  };
  const identity = JSON.parse(await runCli(['whoami', '--format', 'json']));
  if (identity.mode !== 'test') throw new Error('The active Stripe CLI account is not in test mode. Switch to the Mirari sandbox.');
  const account = await new Stripe(process.env.STRIPE_SECRET_KEY).accounts.retrieve();
  if (identity.account_id !== account.id) throw new Error('The Stripe CLI account differs from STRIPE_SECRET_KEY. Switch to the matching sandbox.');
  const listenArgs = ['listen', '--events', eventTypes.join(','), '--events-from', '@self', '--forward-to', forwardTo, '--color', 'off', '--skip-update'];
  const signingSecret = parseSigningSecret(await runCli([...listenArgs, '--print-secret']));
  if (process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_WEBHOOK_SECRET !== signingSecret) {
    console.log('The saved webhook secret differs from the CLI secret. Using the current CLI secret for this local session.');
  }

  let server;
  let ready = false;
  let stopping = false;
  let timer;
  let listenerOutput = '';
  const listener = spawn(cli.command, cliArgs(listenArgs), { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    if (server && !server.killed) server.kill();
    if (!listener.killed) listener.kill();
    process.exitCode = code;
  };
  const startServer = () => {
    if (ready || stopping) return;
    ready = true;
    clearTimeout(timer);
    console.log('Stripe sandbox listener ready. Starting Mirari. Keep this window open during payment tests.');
    server = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: { ...process.env, STRIPE_WEBHOOK_SECRET: signingSecret },
      stdio: 'inherit'
    });
    server.on('error', error => { console.error('Mirari could not start:', error.message); stop(1); });
    server.on('exit', code => { if (!stopping) { console.error('Mirari stopped; closing the Stripe listener.'); stop(code || 1); } });
  };
  const onCliOutput = chunk => {
    const output = chunk.toString().replaceAll(/whsec_[A-Za-z0-9]+/g, '[redacted]');
    listenerOutput = (listenerOutput + output).slice(-1000);
    if (/Ready!/i.test(listenerOutput)) startServer();
    // Keep HTTP delivery status visible while omitting provider IDs and signing secrets.
    for (const line of output.split(/\r?\n/)) {
      const status = line.match(/<--\s*\[(\d{3})\]/);
      if (status) console.log(`Stripe webhook delivery: HTTP ${status[1]}`);
      else if (/error|fail|denied/i.test(line)) console.error(line.replaceAll(/\b(?:evt|pi|ch|re|cs_test)_[A-Za-z0-9_]+\b/g, '[Stripe ID]'));
    }
  };
  listener.stdout.on('data', onCliOutput);
  listener.stderr.on('data', onCliOutput);
  listener.on('error', error => { console.error('Stripe listener could not start:', error.message); stop(1); });
  listener.on('exit', code => { if (!stopping) { console.error(`Stripe listener stopped (${code ?? 'unknown'}); stopping Mirari so webhooks cannot be silently missed.`); stop(1); } });
  timer = setTimeout(() => { console.error('Stripe listener did not become ready within 45 seconds.'); stop(1); }, 45000);
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error('Local Stripe test startup failed:', error.message); process.exitCode = 1; });
}
