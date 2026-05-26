import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM at-rest encryption for small secrets (2FA TOTP seeds).
//
// Stored format:  enc:v1:<base64( iv | authTag | ciphertext )>
//   - iv      = 12 bytes (96 bits, GCM-recommended)
//   - authTag = 16 bytes (GCM standard)
//   - prefix lets us tell encrypted blobs from legacy plaintext secrets
//     during the migration window — `decryptSecret` returns plaintext
//     stored values unchanged so existing 2FA users keep working until
//     they next disable / re-enable.
//
// Key handling:
//   - ENCRYPTION_KEY env var, 32 raw bytes base64-encoded (44 chars).
//   - Generate with:  openssl rand -base64 32

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

const getEncryptionKey = (): Buffer => {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY is not set — required for at-rest encryption of 2FA secrets.',
    );
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). ` +
        'Generate with: openssl rand -base64 32',
    );
  }
  cachedKey = buf;
  return cachedKey;
};

export const encryptSecret = (plaintext: string): string => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return (
    ENCRYPTED_PREFIX +
    Buffer.concat([iv, authTag, encrypted]).toString('base64')
  );
};

export const decryptSecret = (stored: string): string => {
  // Legacy plaintext secrets (pre-encryption) pass through unchanged so
  // existing 2FA-enabled users keep working until their next disable /
  // re-enable cycle.
  if (!stored.startsWith(ENCRYPTED_PREFIX)) {
    return stored;
  }
  const combined = Buffer.from(stored.slice(ENCRYPTED_PREFIX.length), 'base64');
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
};

export const isEncryptedSecret = (stored: string | null | undefined): boolean =>
  typeof stored === 'string' && stored.startsWith(ENCRYPTED_PREFIX);
