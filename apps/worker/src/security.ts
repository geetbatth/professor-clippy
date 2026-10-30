/** Constant-time secret checks: Meta's webhook signature and the PC bearer secret. */

const encoder = new TextEncoder();

/** Decode lower/upper-case hex; undefined if malformed. */
function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Check Meta's `X-Hub-Signature-256: sha256=<hex>` header: HMAC-SHA256 of the raw
 * request body keyed with the app secret. `crypto.subtle.verify` compares the MAC in
 * constant time (it never exposes the expected value to a JS `===`).
 */
export async function verifyMetaSignature(
  appSecret: string | undefined,
  rawBody: BufferSource,
  header: string | null,
): Promise<boolean> {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const sig = hexToBytes(header.slice('sha256='.length));
  if (!sig || sig.length !== 32) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, sig, rawBody);
}

/**
 * Constant-time string equality. Both sides are hashed first so the comparison is
 * over equal-length digests and leaks neither content nor length. An empty or
 * missing `expected` never matches (an unset secret must not open the door).
 */
export async function secretEquals(expected: string | undefined, actual: string | null | undefined): Promise<boolean> {
  if (!expected || actual == null) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** `Authorization: Bearer <secret>` check against `PC_SECRET`. */
export async function isAuthorizedPc(pcSecret: string | undefined, authorization: string | null): Promise<boolean> {
  const m = /^Bearer (.+)$/.exec(authorization ?? '');
  return secretEquals(pcSecret, m?.[1]);
}
