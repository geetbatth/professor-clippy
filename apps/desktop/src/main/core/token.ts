/**
 * Local API bearer token: 32 random bytes as hex, created on first run and
 * reused afterwards.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeAtomic } from './files';

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Read the token at `file`, or create it (and its directory) if missing or malformed. */
export async function loadOrCreateToken(file: string): Promise<string> {
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (TOKEN_RE.test(existing)) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const token = randomBytes(32).toString('hex');
  await mkdir(dirname(file), { recursive: true });
  await writeAtomic(file, token, 0o600);
  return token;
}
