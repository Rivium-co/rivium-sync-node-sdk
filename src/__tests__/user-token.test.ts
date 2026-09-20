import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RiviumSyncAdmin, RiviumSyncError } from '../index';

/**
 * Security Rules read `auth.uid`, and a client cannot set that itself - the API
 * key it ships with is public. The backend, which holds the server secret,
 * mints a token here and hands it to the app.
 */
describe('createUserToken', () => {
  const CONFIG = { apiKey: 'rv_live_test1234567890', serverSecret: 'rv_srv_secret1234567890' };
  const originalFetch = globalThis.fetch;

  const fetchOk = (data: unknown) =>
    vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(data)) });

  beforeEach(() => {
    globalThis.fetch = fetchOk({ token: 'signed.jwt.here', userId: 'user-1', expiresIn: 3600 }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts the userId to /users/token', async () => {
    const admin = new RiviumSyncAdmin(CONFIG);

    const result = await admin.createUserToken('user-1');

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(String(url)).toContain('/users/token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ userId: 'user-1' });
    expect(result.token).toBe('signed.jwt.here');
  });

  it('sends the server secret, which is what proves this is a backend', async () => {
    const admin = new RiviumSyncAdmin(CONFIG);

    await admin.createUserToken('user-1');

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers['x-server-secret']).toBe(CONFIG.serverSecret);
    expect(init.headers['x-api-key']).toBe(CONFIG.apiKey);
  });

  it('passes a custom lifetime through', async () => {
    const admin = new RiviumSyncAdmin(CONFIG);

    await admin.createUserToken('user-1', 900);

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ userId: 'user-1', expiresIn: 900 });
  });

  it('omits expiresIn when not given, so the server default applies', async () => {
    const admin = new RiviumSyncAdmin(CONFIG);

    await admin.createUserToken('user-1');

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(Object.keys(JSON.parse(init.body))).toEqual(['userId']);
  });

  it('refuses an empty userId instead of minting a token for nobody', async () => {
    const admin = new RiviumSyncAdmin(CONFIG);

    await expect(admin.createUserToken('')).rejects.toThrow(RiviumSyncError);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });
});
