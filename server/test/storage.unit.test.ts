import { describe, expect, it, vi } from 'vitest';
import { SupabasePhotoStorage } from '../src/lib/storage.js';

const KEY = 'cmabc123/0b6f3c1e-1234-4abc-9def-0123456789ab.jpg';
const SERVICE_KEY = 'service-role-key-service-role-key';

function storage(respond: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => respond(String(url), init ?? {}));
  return { s: new SupabasePhotoStorage('https://proj.supabase.co/', SERVICE_KEY, 'identity-photos', fetchMock as unknown as typeof fetch), fetchMock };
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

describe('SupabasePhotoStorage', () => {
  it('uploads with the service-role key, the image type and upsert', async () => {
    const { s, fetchMock } = storage(() => new Response('{}', { status: 200 }));
    await s.put(KEY, Buffer.from([0xff, 0xd8, 0xff]));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://proj.supabase.co/storage/v1/object/identity-photos/${KEY}`);
    expect(init!.method).toBe('POST');
    expect(headersOf(init!)).toMatchObject({ Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' });
  });

  it('downloads through the authenticated (private bucket) endpoint', async () => {
    const { s, fetchMock } = storage(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    expect(await s.get(KEY)).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchMock.mock.calls[0]![0]).toBe(`https://proj.supabase.co/storage/v1/object/authenticated/identity-photos/${KEY}`);
  });

  it('treats a missing object as null / already deleted (404, or 400 with statusCode 404)', async () => {
    const notFound400 = () => new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), { status: 400 });
    expect(await storage(() => new Response('', { status: 404 })).s.get(KEY)).toBeNull();
    expect(await storage(notFound400).s.get(KEY)).toBeNull();
    await expect(storage(notFound400).s.delete(KEY)).resolves.toBeUndefined();
  });

  it('fails loudly on other errors without leaking the key or response body', async () => {
    const { s } = storage(() => new Response('secret details', { status: 500 }));
    await expect(s.put(KEY, Buffer.from([1]))).rejects.toThrow('Supabase Storage upload failed (HTTP 500)');
    const err = await s.get(KEY).catch((e: Error) => e);
    expect(String(err)).not.toContain(SERVICE_KEY);
    expect(String(err)).not.toContain('secret details');
  });

  it('rejects unsafe keys before any request is made', async () => {
    const { s, fetchMock } = storage(() => new Response('{}'));
    await expect(s.put('../other-bucket/x.jpg', Buffer.from([1]))).rejects.toThrow('Invalid storage key');
    await expect(s.get('student/../../x.png')).rejects.toThrow('Invalid storage key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
