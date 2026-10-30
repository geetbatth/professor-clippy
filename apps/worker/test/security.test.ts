import { describe, expect, it } from 'vitest';
import { isAuthorizedPc, secretEquals, verifyMetaSignature } from '../src/security';
import { signBody } from './helpers';

const secret = 'app-secret';
const body = new TextEncoder().encode('{"object":"whatsapp_business_account","entry":[]}');

describe('verifyMetaSignature', () => {
  it('accepts the HMAC-SHA256 of the raw body (either hex case)', async () => {
    const header = await signBody(secret, body);
    expect(await verifyMetaSignature(secret, body, header)).toBe(true);
    expect(await verifyMetaSignature(secret, body, 'sha256=' + header.slice(7).toUpperCase())).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const header = await signBody(secret, body);
    const tampered = new TextEncoder().encode('{"object":"whatsapp_business_account","entry":[1]}');
    expect(await verifyMetaSignature(secret, tampered, header)).toBe(false);
  });

  it('rejects a tampered signature or the wrong secret', async () => {
    const header = await signBody(secret, body);
    const flipped = header.slice(0, -1) + (header.endsWith('0') ? '1' : '0');
    expect(await verifyMetaSignature(secret, body, flipped)).toBe(false);
    expect(await verifyMetaSignature('other-secret', body, header)).toBe(false);
  });

  it('rejects missing, malformed or truncated headers and an unset secret', async () => {
    const header = await signBody(secret, body);
    const bad = [null, '', header.slice(7), 'sha1=' + header.slice(7), 'sha256=zz', header.slice(0, -2), 'sha256='];
    for (const h of bad) expect(await verifyMetaSignature(secret, body, h)).toBe(false);
    expect(await verifyMetaSignature('', body, header)).toBe(false);
    expect(await verifyMetaSignature(undefined, body, header)).toBe(false);
  });
});

describe('secretEquals / isAuthorizedPc', () => {
  it('matches only the exact secret', async () => {
    expect(await secretEquals('s3cret', 's3cret')).toBe(true);
    expect(await secretEquals('s3cret', 's3cret ')).toBe(false);
    expect(await secretEquals('s3cret', 's3cre')).toBe(false);
    expect(await secretEquals('s3cret', null)).toBe(false);
  });
  it('never matches when the expected secret is unset', async () => {
    expect(await secretEquals('', '')).toBe(false);
    expect(await secretEquals(undefined, 'x')).toBe(false);
  });
  it('requires "Bearer <secret>"', async () => {
    expect(await isAuthorizedPc('pc', 'Bearer pc')).toBe(true);
    expect(await isAuthorizedPc('pc', 'bearer pc')).toBe(false);
    expect(await isAuthorizedPc('pc', 'pc')).toBe(false);
    expect(await isAuthorizedPc('pc', null)).toBe(false);
    expect(await isAuthorizedPc('pc', 'Bearer nope')).toBe(false);
  });
});
