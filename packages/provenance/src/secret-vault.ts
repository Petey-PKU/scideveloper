import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface EncryptedBlob {
  v: 1;
  alg: 'aes-256-gcm';
  protection: 'dpapi-safe-storage' | 'aes-256-gcm-vault';
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * Local encrypted secret vault for API keys and SSH passphrases.
 * - When launched inside Electron, accepts a DPAPI/Keychain-wrapped master key via `SCIDEV_VAULT_KEY`.
 * - Otherwise derives/persists a per-user random 256-bit key file with 0600 permissions outside SQLite,
 *   ensuring plaintext API keys are NEVER written into `scideveloper.sqlite`.
 */
export class SecretVault {
  private readonly key: Buffer;
  public readonly protection: 'dpapi-safe-storage' | 'aes-256-gcm-vault';

  constructor(dataDir: string, explicitMasterKeyHex?: string) {
    const envKey = explicitMasterKeyHex ?? process.env.SCIDEV_VAULT_KEY;
    if (envKey && envKey.trim().length >= 32) {
      this.key = crypto.createHash('sha256').update(envKey.trim(), 'utf8').digest();
      this.protection = 'dpapi-safe-storage';
      return;
    }

    this.protection = 'aes-256-gcm-vault';
    if (dataDir === ':memory:') {
      this.key = crypto.randomBytes(32);
      return;
    }

    fs.mkdirSync(dataDir, { recursive: true });
    const keyFile = path.join(dataDir, '.vault.key');
    let rawKey: Buffer;
    if (fs.existsSync(keyFile)) {
      const hex = fs.readFileSync(keyFile, 'utf8').trim();
      rawKey = /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : crypto.createHash('sha256').update(hex).digest();
    } else {
      rawKey = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, rawKey.toString('hex'), { encoding: 'utf8', mode: 0o600 });
    }
    // Bind key derivation with host/user salt so copying sqlite alone cannot decrypt
    const hostSalt = `${os.hostname()}:${os.userInfo().username}:scideveloper-vault-v1`;
    this.key = crypto.createHmac('sha256', rawKey).update(hostSalt).digest();
  }

  encrypt(plaintext: string): EncryptedBlob {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      alg: 'aes-256-gcm',
      protection: this.protection,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: encrypted.toString('base64'),
    };
  }

  decrypt(blob: EncryptedBlob): string | null {
    if (!blob || blob.v !== 1 || blob.alg !== 'aes-256-gcm') return null;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(blob.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
      const out = Buffer.concat([
        decipher.update(Buffer.from(blob.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return out.toString('utf8');
    } catch {
      return null;
    }
  }

  static isEncryptedBlob(value: unknown): value is EncryptedBlob {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    return obj.v === 1 && obj.alg === 'aes-256-gcm' && typeof obj.ciphertext === 'string' && typeof obj.iv === 'string' && typeof obj.tag === 'string';
  }
}
