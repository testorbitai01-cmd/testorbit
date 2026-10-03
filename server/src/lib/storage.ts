/**
 * Identity-photo storage abstraction.
 *
 * Drivers
 *  • local    — files under PHOTO_STORAGE_DIR. In production this directory MUST be a
 *               persistent mount (a Railway Volume), because container disks are ephemeral.
 *  • disabled — photos are never stored; the capture step only verifies the camera works.
 *
 * Photos are never publicly served. They are streamed only through the admin-only,
 * audit-logged endpoint GET /api/admin/students/:id/photo.
 * Only the storage key + metadata are saved in PostgreSQL (IdentityPhoto).
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

export interface PhotoStorage {
  readonly driver: string;
  readonly enabled: boolean;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9]+\/[a-f0-9-]+\.(jpg|png|webp)$/i;

class LocalPhotoStorage implements PhotoStorage {
  readonly driver = 'local';
  readonly enabled = true;
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!SAFE_KEY.test(key)) throw new Error('Invalid storage key');
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write atomically so a crash never leaves a half-written photo.
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

class DisabledPhotoStorage implements PhotoStorage {
  readonly driver = 'disabled';
  readonly enabled = false;
  async put(): Promise<void> {
    throw new Error('Photo storage is disabled');
  }
  async get(): Promise<Buffer | null> {
    return null;
  }
  async delete(): Promise<void> {}
}

export const photoStorage: PhotoStorage =
  env.PHOTO_STORAGE_DRIVER === 'local' ? new LocalPhotoStorage(env.photoStorageDir) : new DisabledPhotoStorage();

export function photoKey(studentId: string, ext: 'jpg' | 'png' | 'webp'): string {
  return `${studentId}/${crypto.randomUUID()}.${ext}`;
}

/** Detect the image type from magic bytes (never trust the Content-Type header alone). */
export function sniffImage(buf: Buffer): { mime: string; ext: 'jpg' | 'png' | 'webp' } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}
