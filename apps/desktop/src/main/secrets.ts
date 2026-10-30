/**
 * The app's {@link SecretBox}: Electron `safeStorage` (DPAPI on Windows, so only this Windows
 * user on this PC can decrypt), stored as base64. Use only after `app.whenReady()`.
 */
import { safeStorage } from 'electron';
import type { SecretBox } from './settings';

export const electronSecretBox: SecretBox = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
};
