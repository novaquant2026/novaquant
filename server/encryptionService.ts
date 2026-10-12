import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Location for persisted master encryption key fallback if not in env
const DATA_DIR = path.join(process.cwd(), 'data');
const MASTER_KEY_FILE = path.join(DATA_DIR, 'master.key');

/**
 * Derives or retrieves a 32-byte (256-bit) encryption key securely.
 * Priority:
 * 1. process.env.ENCRYPTION_KEY
 * 2. Persisted ./data/master.key (generated cryptographically on first run)
 */
function getMasterEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY?.trim();
  if (envKey && envKey.length > 0) {
    // Derive a fixed 32-byte key using scrypt to normalize key length
    return crypto.scryptSync(envKey, 'novaquant-crypto-salt-2026', 32);
  }

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch {
      // ignore
    }
  }

  if (fs.existsSync(MASTER_KEY_FILE)) {
    try {
      const stored = fs.readFileSync(MASTER_KEY_FILE, 'utf-8').trim();
      if (stored.length === 64) {
        return Buffer.from(stored, 'hex');
      }
    } catch {
      // fallback to generation
    }
  }

  // Generate a random 32-byte key and persist it locally for server continuity
  const generatedKey = crypto.randomBytes(32);
  try {
    fs.writeFileSync(MASTER_KEY_FILE, generatedKey.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    console.log('[SECURITY] Generated and secured local AES-256 master key in ./data/master.key');
  } catch (err) {
    console.warn('[SECURITY] Notice: Failed writing master.key to disk, keeping in memory:', err);
  }

  return generatedKey;
}

const AAD_IDENTIFIER = Buffer.from('NovaQuant-v1-EncryptedExchangeSecret');

/**
 * Encrypts sensitive exchange credentials using AES-256-GCM (Authenticated Encryption).
 * Output format: <iv_hex>:<auth_tag_hex>:<ciphertext_hex>
 */
export function encryptCredential(plaintext: string): string {
  if (!plaintext || typeof plaintext !== 'string') {
    return '';
  }

  const key = getMasterEncryptionKey();
  const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD_IDENTIFIER);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts sensitive exchange credentials using AES-256-GCM.
 * Never logs decrypted credentials or throws verbose secret-containing errors.
 */
export function decryptCredential(encryptedPayload: string): string {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    return '';
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format.');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;

  try {
    const key = getMasterEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD_IDENTIFIER);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err: any) {
    // Crucial security requirement: Never leak secret contents or cryptographic materials
    throw new Error('Decryption failed: integrity verification rejected or invalid key.');
  }
}

/**
 * Masks an API Key for safe frontend display.
 * e.g., "vmP3d...4K9a" or "••••••••"
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) {
    return '••••••••';
  }
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}
