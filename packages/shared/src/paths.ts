/**
 * Locations of Professor Clippy's data files (Node only).
 *
 * The app data dir is `process.env.CLIPPY_HOME` when set (tests, dev), otherwise
 * `%APPDATA%/professor-clippy/`. Read lazily on every call so tests can change
 * `CLIPPY_HOME` at runtime.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** App data directory (not created by this function). */
export function appDataDir(): string {
  const override = process.env.CLIPPY_HOME;
  if (override) return resolve(override);
  const roaming = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(roaming, 'professor-clippy');
}

/** `token`: random 32-byte hex bearer token for the local API, created on first app run. */
export function tokenPath(): string {
  return join(appDataDir(), 'token');
}

/** `port`: the local API's current 127.0.0.1 port (decimal text). */
export function portPath(): string {
  return join(appDataDir(), 'port');
}

/** `clippy.db`: the SQLite database (messages, reminders, FTS history). */
export function dbPath(): string {
  return join(appDataDir(), 'clippy.db');
}

/** `settings.json`: persisted Settings. */
export function settingsPath(): string {
  return join(appDataDir(), 'settings.json');
}
