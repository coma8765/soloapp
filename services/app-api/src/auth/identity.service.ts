import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

@Injectable()
export class IdentityService {
  async readKey(): Promise<Buffer> {
    const path = process.env.HMAC_KEY_FILE;
    if (!path) throw new Error('Signing key unavailable');
    // Read on every request so the secret sidecar can rotate the key atomically.
    const encoded = (await readFile(path, 'utf8')).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(encoded)) {
      throw new Error('Invalid signing key');
    }
    return Buffer.from(encoded, 'hex');
  }

  async verify(
    userId: string | undefined,
    timestamp: string | undefined,
    signature: string | undefined,
  ): Promise<boolean> {
    if (
      !userId ||
      !/^[0-9a-f]{32}$/.test(userId) ||
      !timestamp ||
      !/^[0-9]{10}$/.test(timestamp) ||
      !signature ||
      !/^[0-9a-f]{64}$/.test(signature)
    )
      return false;

    const delta = Math.floor(Date.now() / 1000) - Number(timestamp);
    if (delta < -2 || delta > 10) return false;

    let key: Buffer | undefined;
    try {
      key = await this.readKey();
      const expected = createHmac('sha256', key)
        .update(`soloapp-user-id:${userId}:${timestamp}`)
        .digest();
      return timingSafeEqual(Buffer.from(signature, 'hex'), expected);
    } catch {
      return false;
    } finally {
      key?.fill(0);
    }
  }
}
