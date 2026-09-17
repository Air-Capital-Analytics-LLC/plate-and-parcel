/**
 * crypto.js — passphrase-derived AES-GCM envelope.
 *
 * The passphrase never leaves the device and is never written to the database.
 * Only the per-item VALUE blob is encrypted; item ids stay plaintext because
 * they are already public in the page source, so encrypting them would protect
 * nothing while breaking the merge key.
 *
 * Envelope format:  v1.<iv-b64url>.<ciphertext-b64url>
 *
 * Every seal is bound to the slot it belongs in via AES-GCM additional
 * authenticated data. Without that binding the ciphertext is portable: anyone
 * with write access — which the threat model grants to anyone who learns the
 * URL — could copy a valid envelope from one item onto twenty others and every
 * device would authenticate it, decrypt it and merge it as a legitimate record
 * complete with someone's real name on it. That is a forgery the encryption
 * appears to prevent and did not.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** OWASP 2023 floor for PBKDF2-HMAC-SHA256. Never lowered for latency: it runs
 *  off the main thread in every engine, and it is the only thing standing
 *  between a world-writable public node and anyone holding the URL. */
const ITERATIONS = 210000;
const VERSION = 'v1';

export function isSupported() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && !!crypto.getRandomValues;
}

/* ---------- base64url (unicode-safe, no atob/btoa charset traps) ---------- */

function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64ToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomSalt() {
  return bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * A salt arriving from the database is untrusted input. `deriveKey` on a
 * non-string throws deep inside `b64ToBytes`, and that exception used to
 * escape all the way out of boot and kill the app silently.
 */
export function isValidSalt(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);
}

/* ---------- key derivation ---------- */

/**
 * @param {string} passphrase
 * @param {string} saltB64  stable per-list salt — the list's identity
 * @returns {Promise<CryptoKey>} non-extractable AES-GCM key
 */
export async function deriveKey(passphrase, saltB64) {
  if (!isValidSalt(saltB64)) throw new Error('bad salt');
  const base = await crypto.subtle.importKey(
    'raw', ENC.encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/* ---------- envelope ---------- */

/**
 * @param {CryptoKey} key
 * @param {any} value
 * @param {string} aad  the slot this seal is valid in, e.g. "household/items/produce--potatoes"
 */
export async function encryptJSON(key, value, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: ENC.encode(String(aad)) },
    key,
    ENC.encode(JSON.stringify(value))
  );
  return `${VERSION}.${bytesToB64(iv)}.${bytesToB64(new Uint8Array(ct))}`;
}

/**
 * Returns the decoded value, or `undefined` when the envelope is not readable
 * with this key IN THIS SLOT. Callers treat `undefined` as "not mine to render"
 * rather than an error: a list can legitimately contain records written under
 * an older passphrase, and one bad record must never take down the whole
 * render. A record moved to a different slot now also lands here.
 */
export async function decryptJSON(key, envelope, aad) {
  if (typeof envelope !== 'string') return undefined;
  const parts = envelope.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return undefined;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(parts[1]), additionalData: ENC.encode(String(aad)) },
      key,
      b64ToBytes(parts[2])
    );
    return JSON.parse(DEC.decode(pt));
  } catch {
    return undefined;
  }
}

/**
 * Verifier token proving a passphrase matches the one the list was created
 * with, without storing the passphrase or anything derived from it reversibly.
 * It is a known plaintext sealed under the key, in its own dedicated slot so a
 * canary can never be swapped in as an item or an item as a canary.
 */
const CANARY = 'shopping-list-passphrase-check';
const CANARY_AAD = 'meta/check';

export async function makeCheck(key) {
  return encryptJSON(key, CANARY, CANARY_AAD);
}

export async function verifyCheck(key, check) {
  if (typeof check !== 'string') return false;
  return (await decryptJSON(key, check, CANARY_AAD)) === CANARY;
}
