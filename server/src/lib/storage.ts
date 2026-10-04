/**
 * Identity-photo storage abstraction.
 *
 * Drivers
 *  • local    — files under PHOTO_STORAGE_DIR. In production this directory MUST be a
 *               persistent mount (a Railway Volume), because container disks are ephemeral.
 *               A volume attaches to one instance, so this driver limits the API to one replica.
 *  • supabase — a private Supabase Storage bucket (shared by all replicas).
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

const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const STORAGE_TIMEOUT_MS = 15_000;

/**
 * Supabase Storage (S3-backed object storage) via its REST API, authenticated with the service-role key.
 * Shared by every replica, so — unlike a Railway volume — it allows running the API with several replicas.
 * The bucket must be PRIVATE: photos are only ever streamed through the admin-only endpoint.
 */
export class SupabasePhotoStorage implements PhotoStorage {
  readonly driver = 'supabase';
  readonly enabled = true;
  private readonly base: string;

  constructor(
    url: string,
    private readonly serviceKey: string,
    private readonly bucket: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${url.replace(/\/+$/, '')}/storage/v1/object`;
  }

  private objectUrl(key: string, prefix = ''): string {
    if (!SAFE_KEY.test(key)) throw new Error('Invalid storage key');
    return `${this.base}/${prefix}${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...init.headers },
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    });
  }

  /** Storage reports a missing object as 404, or as 400 with statusCode "404" in the JSON body. */
  private static async isNotFound(res: Response): Promise<boolean> {
    if (res.status === 404) return true;
    if (res.status !== 400) return false;
    const body = (await res.json().catch(() => null)) as { statusCode?: string | number; error?: string } | null;
    return String(body?.statusCode) === '404' || /not.?found/i.test(String(body?.error ?? ''));
  }

  private static async fail(op: string, res: Response): Promise<never> {
    // Status only: the body can echo request details and the key must never be logged.
    throw new Error(`Supabase Storage ${op} failed (HTTP ${res.status})`);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const res = await this.call(this.objectUrl(key), {
      method: 'POST',
      headers: { 'Content-Type': MIME_BY_EXT[key.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream', 'x-upsert': 'true', 'Cache-Control': 'no-store' },
      body: new Uint8Array(data),
    });
    if (!res.ok) await SupabasePhotoStorage.fail('upload', res);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.call(this.objectUrl(key, 'authenticated/'), { method: 'GET' });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (await SupabasePhotoStorage.isNotFound(res)) return null;
    return SupabasePhotoStorage.fail('download', res);
  }

  async delete(key: string): Promise<void> {
    const res = await this.call(this.objectUrl(key), { method: 'DELETE' });
    if (res.ok || (await SupabasePhotoStorage.isNotFound(res))) return;
    await SupabasePhotoStorage.fail('delete', res);
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

function createPhotoStorage(): PhotoStorage {
  switch (env.PHOTO_STORAGE_DRIVER) {
    case 'local':
      return new LocalPhotoStorage(env.photoStorageDir);
    case 'supabase':
      // Presence is guaranteed by the env schema.
      return new SupabasePhotoStorage(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, env.SUPABASE_STORAGE_BUCKET);
    default:
      return new DisabledPhotoStorage();
  }
}

export const photoStorage: PhotoStorage = createPhotoStorage();

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
