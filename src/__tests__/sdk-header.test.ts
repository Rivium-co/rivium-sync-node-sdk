import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RiviumSyncAdmin, SDK_NAME, SDK_VERSION, SDK_HEADER_VALUE } from '../index';

const { version } = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

/** Every request to the Sync API carries `X-Rivium-SDK: node/<version>`. */
describe('X-Rivium-SDK', () => {
  const CONFIG = { apiKey: 'rv_live_test1234567890', serverSecret: 'rv_srv_secret1234567890' };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ token: 't', userId: 'user-1', expiresIn: 3600, data: [] })),
      json: () => Promise.resolve({ data: [] }),
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('the version is the package version', () => {
    expect(SDK_NAME).toBe('node');
    expect(SDK_VERSION).toBe(version);
    expect(SDK_HEADER_VALUE).toBe(`node/${version}`);
  });

  it('is sent next to the key and the server secret', async () => {
    const admin = new RiviumSyncAdmin(CONFIG);

    await admin.createUserToken('user-1');
    await admin.database('app').collection('todos').getAll().catch(() => {});

    const calls = (globalThis.fetch as any).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of calls) {
      expect(init.headers['X-Rivium-SDK']).toBe(`node/${version}`);
      expect(init.headers['x-api-key']).toBe(CONFIG.apiKey);
      expect(init.headers['x-server-secret']).toBe(CONFIG.serverSecret);
    }
  });
});
