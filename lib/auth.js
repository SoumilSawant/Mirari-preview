import { createHmac, scrypt, timingSafeEqual, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

export const derivePassword = promisify(scrypt);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret() {
  const bytes = randomBytes(20);
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return result;
}

function decodeBase32(secret) {
  const cleaned = String(secret || '').replace(/\s|=/g, '').toUpperCase();
  if (!/^[A-Z2-7]{32,}$/.test(cleaned)) throw new Error('ADMIN_TOTP_SECRET must be a Base32 authenticator secret.');
  let bits = 0, value = 0; const bytes = [];
  for (const char of cleaned) {
    value = (value << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

export function verifyTotp(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const key = decodeBase32(secret), candidate = Buffer.from(String(code));
  const current = Math.floor(now / 30000);
  for (let counter = current - 1; counter <= current + 1; counter++) {
    const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha1', key).update(message).digest();
    const offset = digest[digest.length - 1] & 15;
    const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    if (timingSafeEqual(candidate, Buffer.from(String(value).padStart(6, '0')))) return counter;
  }
  return null;
}
