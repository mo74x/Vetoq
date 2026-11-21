import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';

export interface ActionNonceClaims {
  token_id: string;
  payload_version: number;
  jti: string;
  exp: number;
}

@Injectable()
export class CryptoService {
  private readonly encryptionKey: Buffer;
  private readonly actionNonceSecret: Buffer;

  constructor() {
    const encHex =
      process.env.APP_ENCRYPTION_KEY ??
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    this.encryptionKey = Buffer.from(encHex, 'hex');
    if (this.encryptionKey.length !== 32) {
      throw new Error('APP_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
    }

    const nonceHex =
      process.env.ACTION_NONCE_SECRET ??
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    this.actionNonceSecret = Buffer.from(nonceHex, 'hex');
    if (this.actionNonceSecret.length !== 32) {
      throw new Error('ACTION_NONCE_SECRET must be a 64-character hex string (32 bytes)');
    }
  }

  sha256Hex(input: string): string {
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
  }

  randomToken(bytes = 32): string {
    return crypto.randomBytes(bytes).toString('base64url');
  }

  encryptSecret(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decryptSecret(encoded: string): string {
    const parts = encoded.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Unsupported encrypted secret format');
    }
    const [, ivHex, tagHex, cipherHex] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(cipherHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  signWebhookPayload(secret: string, timestamp: number, rawBody: string): string {
    const digest = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');
    return `sha256=${digest}`;
  }

  mintActionNonce(tokenId: string, payloadVersion: number, ttlSeconds = 900): string {
    const claims: ActionNonceClaims = {
      token_id: tokenId,
      payload_version: payloadVersion,
      jti: crypto.randomUUID(),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    };
    const payloadB64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const sig = crypto
      .createHmac('sha256', this.actionNonceSecret)
      .update(payloadB64, 'utf8')
      .digest('base64url');
    return `${payloadB64}.${sig}`;
  }

  verifyActionNonce(nonce: string): ActionNonceClaims | null {
    const parts = nonce.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;
    const expectedSig = crypto
      .createHmac('sha256', this.actionNonceSecret)
      .update(payloadB64, 'utf8')
      .digest('base64url');

    const sigBuf = Buffer.from(sigB64, 'utf8');
    const expBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    try {
      const claims = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf8'),
      ) as ActionNonceClaims;
      if (
        typeof claims.token_id !== 'string' ||
        typeof claims.payload_version !== 'number' ||
        typeof claims.jti !== 'string' ||
        typeof claims.exp !== 'number'
      ) {
        return null;
      }
      if (claims.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }
      return claims;
    } catch {
      return null;
    }
  }
}
