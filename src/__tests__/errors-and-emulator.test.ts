import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('mqtt', async () => {
  const f = await import('./fake-mqtt');
  return { default: { connect: f.connect }, connect: f.connect };
});

import { ListenerRevokedError, QueryNotAllowedError, RiviumSyncAdmin, RiviumSyncError, RiviumSyncErrorCode } from '../index';
import { isTransientError } from '../sync-errors';
import { clients, connect } from './fake-mqtt';
import { flush, listenCalls, realtimeAdmin, routeFetch } from './fake-realtime';

const admin = (extra: Record<string, unknown> = {}) =>
  new RiviumSyncAdmin({ apiKey: 'rv_live_test1234567890', serverSecret: 'rv_srv_secret1234567890', ...extra });

const answered = (status: number, serverCode?: string) =>
  new RiviumSyncError(RiviumSyncErrorCode.DATA_FETCH_FAILED, `HTTP ${status}`, { status, ...(serverCode ? { serverCode } : {}) });

beforeEach(() => {
  clients.length = 0;
  connect.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('transient vs final errors', () => {
  it('no answer, 401, 408, 429 and 5xx are transient', () => {
    for (const status of [401, 408, 429, 500, 502, 503, 504]) expect(isTransientError(answered(status)), String(status)).toBe(true);
    expect(isTransientError(new RiviumSyncError(RiviumSyncErrorCode.CONNECTION_TIMEOUT))).toBe(true);
    expect(isTransientError(new RiviumSyncError(RiviumSyncErrorCode.CONNECTION_FAILED))).toBe(true);
    // request(): fetch itself failed, no status.
    expect(isTransientError(new RiviumSyncError(RiviumSyncErrorCode.DATA_FETCH_FAILED, 'fetch failed'))).toBe(true);
    expect(isTransientError(new TypeError('fetch failed'))).toBe(true);
  });

  it('any other 4xx and query_not_allowed are final', () => {
    for (const status of [400, 403, 404, 409, 413, 422]) expect(isTransientError(answered(status)), String(status)).toBe(false);
    expect(isTransientError(new QueryNotAllowedError('no'))).toBe(false);
    expect(isTransientError(new ListenerRevokedError())).toBe(false);
    expect(isTransientError(new RiviumSyncError(RiviumSyncErrorCode.SUBSCRIPTION_FAILED, 'Unexpected listen answer'))).toBe(false);
  });

  it('a listener refused with 409 / 413 / 422 is stopped and reported, never retried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    for (const status of [401, 409, 413, 422]) {
      const ctx = await realtimeAdmin((method, path) =>
        method === 'POST' && path.endsWith('/listen') ? { status, body: { statusCode: status, message: 'no' } } : undefined,
      );
      const errors: RiviumSyncError[] = [];
      ctx.admin.database('app').collection('notes').doc('d').onSnapshot(() => {}, (e) => errors.push(e));
      await flush();
      vi.advanceTimersByTime(120_000);
      await flush();
      expect(errors.map((e) => e.statusCode), String(status)).toEqual([status]);
      expect(listenCalls(ctx.calls), String(status)).toHaveLength(1);
    }
  });

  it('a listener that got 429 is retried later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let n = 0;
    const ctx = await realtimeAdmin((method, path) =>
      method === 'POST' && path.endsWith('/listen')
        ? n++ === 0
          ? { status: 429, body: 'slow down' }
          : { status: 200, body: { subscriptionId: 's1', topic: 't1', expiresAt: '', document: null } }
        : undefined,
    );
    const errors: unknown[] = [];
    ctx.admin.database('app').collection('notes').doc('d').onSnapshot(() => {}, (e) => errors.push(e));
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(listenCalls(ctx.calls)).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});

describe('statusCode', () => {
  it('is the HTTP status of the server answer', async () => {
    routeFetch(() => ({ status: 403, body: { statusCode: 403, message: 'Permission denied' } }));
    const error = await admin().database('app').collection('t').doc('a').set({ a: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(RiviumSyncError);
    expect(error.statusCode).toBe(403);
    expect(error.status).toBe(403);
    expect(error.code).toBe(RiviumSyncErrorCode.DATA_FETCH_FAILED);
  });

  it('is 403 on a QueryNotAllowedError', () => {
    expect(new QueryNotAllowedError('no').statusCode).toBe(403);
  });

  it('is undefined when the server could not be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const error = await admin().database('app').collection('t').doc('a').get().catch((e) => e);
    expect(error).toBeInstanceOf(RiviumSyncError);
    expect(error.statusCode).toBeUndefined();
    expect(isTransientError(error)).toBe(true);
  });

  it('is undefined on a timeout', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    const error = await admin().database('app').collection('t').doc('a').get().catch((e) => e);
    expect(error.code).toBe(RiviumSyncErrorCode.CONNECTION_TIMEOUT);
    expect(error.statusCode).toBeUndefined();
  });
});

describe('final errors reach the caller', () => {
  it('get(): a refusal whose message mentions 404 is thrown, not read as a missing document', async () => {
    routeFetch(() => ({ status: 403, body: { statusCode: 403, message: 'Permission denied on order-404' } }));
    const error = await admin().database('app').collection('orders').get('order-404').catch((e) => e);
    expect(error).toBeInstanceOf(RiviumSyncError);
    expect(error.statusCode).toBe(403);
  });
});

describe('delete', () => {
  it('a document that is already gone (404) is deleted, as in Firestore', async () => {
    const { calls } = routeFetch(() => ({ status: 404, body: { statusCode: 404, message: 'Document with ID d1 not found' } }));
    await expect(admin().database('app').collection('t').doc('d1').delete()).resolves.toBeUndefined();
    expect(calls.map((c) => c.method)).toEqual(['DELETE']);
  });

  it('a refused delete is thrown', async () => {
    routeFetch(() => ({ status: 403, body: { statusCode: 403, message: 'Permission denied' } }));
    const error = await admin().database('app').collection('t').doc('d1').delete().catch((e) => e);
    expect(error.statusCode).toBe(403);
  });

  it('a batch whose delete is refused with 404 still fails as a whole', async () => {
    routeFetch(() => ({ status: 404, body: { statusCode: 404, message: 'Document with ID d1 not found' } }));
    const sync = admin();
    const t = sync.database('app').collection('t');
    const error = await sync.batch().set(t.doc('d0'), { a: 1 }).delete(t.doc('d1')).commit().catch((e) => e);
    expect(error).toBeInstanceOf(RiviumSyncError);
    expect(error.statusCode).toBe(404);
  });
});

describe('useEmulator', () => {
  it('sends the API to http://host:port (default port 3006)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"data":[]}' });
    vi.stubGlobal('fetch', fetchSpy);
    const sync = admin();
    sync.useEmulator('localhost');
    await sync.database('app').collection('t').getAll();
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:3006/databases/app/collections/t/documents/sdk/query');

    const other = admin();
    other.useEmulator('10.0.2.2', 4000);
    await other.database('app').collection('t').getAll();
    expect(fetchSpy.mock.calls[1][0]).toBe('http://10.0.2.2:4000/databases/app/collections/t/documents/sdk/query');
  });

  async function realtimeUrl(mqttAnswer: unknown): Promise<string> {
    connect.mockClear();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: 'jwt', projectId: 'p1', ...(mqttAnswer === undefined ? {} : { mqtt: mqttAnswer }) }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const sync = admin({ enableRealtime: true });
    sync.useEmulator('localhost');
    await flush();
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:3006/connections/token');
    return connect.mock.calls.at(-1)![0] as string;
  }

  it('realtime goes to the same host without TLS, on the port the server reports', async () => {
    expect(await realtimeUrl({ host: 'mqtt-sync.rivium.co', port: 1884, useTls: false })).toBe('mqtt://localhost:1884');
    expect(await realtimeUrl({ host: 'localhost', port: 1999, useTls: false })).toBe('mqtt://localhost:1999');
  });

  it('realtime never uses TLS, and uses port 1884 when the answer has no valid port', async () => {
    expect(await realtimeUrl(undefined)).toBe('mqtt://localhost:1884');
    expect(await realtimeUrl({ host: 'x', port: 70000 })).toBe('mqtt://localhost:1884');
    expect(await realtimeUrl({ host: 'x', port: '1884' })).toBe('mqtt://localhost:1884');
    expect(await realtimeUrl({ host: 'mqtt-sync.rivium.co', port: 1885, useTls: true })).toBe('mqtt://localhost:1885');
  });

  it('without it, realtime stays encrypted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ token: 'jwt', projectId: 'p1' }) }),
    );
    admin({ enableRealtime: true });
    await flush();
    expect(connect.mock.calls.at(-1)![0]).toBe('mqtts://mqtt-sync.rivium.co:8885');
  });

  it('rejects a host with a scheme, port or path, and a port outside 1-65535', () => {
    for (const host of ['', '  ', 'http://localhost', 'localhost:3006', 'localhost/api', 'local host']) {
      expect(() => admin().useEmulator(host), JSON.stringify(host)).toThrow(RiviumSyncError);
    }
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(() => admin().useEmulator('localhost', port), String(port)).toThrow(RiviumSyncError);
    }
    expect(() => admin().useEmulator(' localhost ', 65535)).not.toThrow();
  });

  it('must come before any other call', async () => {
    routeFetch(() => ({ status: 200, body: { data: [] } }));
    const sync = admin();
    await sync.database('app').collection('t').getAll();
    const error = (() => {
      try {
        sync.useEmulator('localhost');
      } catch (e) {
        return e as RiviumSyncError;
      }
    })();
    expect(error?.code).toBe(RiviumSyncErrorCode.INVALID_CONFIG);
    expect(error?.details).toMatch(/before any other call/);
  });
});

describe('realtime that cannot start', () => {
  const tokenCalls = (calls: { method: string; path: string }[]) => calls.filter((c) => c.path === '/connections/token');

  it('a refused POST /connections/token reaches every listener, before and after, and is not retried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { calls } = routeFetch((_m, path) =>
      path === '/connections/token'
        ? { status: 401, body: { statusCode: 401, code: 'token_required', message: 'This project requires a signed user token' } }
        : undefined,
    );
    const sync = admin({ enableRealtime: true });
    const errors: RiviumSyncError[] = [];
    sync.database('app').collection('t').doc('a').onSnapshot(() => {}, (e) => errors.push(e));
    await flush();
    sync.database('app').collection('t').where('userId', '==', 'u').onSnapshot(() => {}, (e) => errors.push(e));
    await flush();
    vi.advanceTimersByTime(120_000);
    await flush();

    expect(errors.map((e) => [e.statusCode, e.serverCode])).toEqual([
      [401, 'token_required'],
      [401, 'token_required'],
    ]);
    expect(tokenCalls(calls)).toHaveLength(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it('a network error or 5xx is retried, then the listener starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let n = 0;
    const { calls } = routeFetch((method, path) => {
      if (path === '/connections/token' && n++ === 0) return { status: 503, body: 'unavailable' };
      if (method === 'POST' && path.endsWith('/listen')) {
        return { status: 200, body: { subscriptionId: 's1', topic: 't1', expiresAt: '', document: null } };
      }
      return undefined;
    });
    const sync = admin({ enableRealtime: true });
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    sync.database('app').collection('t').doc('a').onSnapshot((d) => seen.push(d), (e) => errors.push(e));
    await flush();
    expect(connect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    await flush();
    expect(tokenCalls(calls)).toHaveLength(2);
    clients[clients.length - 1].connectNow();
    await flush();
    expect(seen).toEqual([null]);
    expect(errors).toEqual([]);
  });

  it('disconnect() stops trying again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { calls } = routeFetch((_m, path) => (path === '/connections/token' ? { status: 503, body: 'unavailable' } : undefined));
    const sync = admin({ enableRealtime: true });
    await flush();
    sync.disconnect();
    vi.advanceTimersByTime(120_000);
    await flush();
    expect(tokenCalls(calls)).toHaveLength(1);
  });
});

describe('the realtime token is renewed before it expires', () => {
  const jwt = (expSeconds: number, n: number) =>
    ['h', Buffer.from(JSON.stringify({ exp: expSeconds, n })).toString('base64url'), 's'].join('.');

  function tokenServer() {
    let issued = 0;
    const fetchSpy = vi.fn(async (url: string) => {
      if (!String(url).endsWith('/connections/token')) return { ok: true, status: 200, text: async () => '{}' };
      issued += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ token: jwt(Math.floor(Date.now() / 1000) + 600, issued), projectId: 'p1' }) };
    });
    vi.stubGlobal('fetch', fetchSpy);
    return { tokenCalls: () => fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/connections/token')).length };
  }

  it('a fresh token becomes the password of the next reconnect, 5 minutes before the old one expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = tokenServer();
    const sync = admin({ enableRealtime: true });
    await flush();
    const client = clients.at(-1)!;
    const first = client.options.password;
    expect(server.tokenCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(server.tokenCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(server.tokenCalls()).toBe(2);
    expect(client.options.password).not.toBe(first);
    expect(clients).toHaveLength(1); // the open connection is not touched
    sync.disconnect();
  });

  it('a refused login fetches a new token at once; disconnect() stops the renewals', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = tokenServer();
    const sync = admin({ enableRealtime: true });
    await flush();
    const client = clients.at(-1)!;

    client.emit('error', Object.assign(new Error('Connection refused: Not authorized'), { code: 5 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.tokenCalls()).toBe(2);

    sync.disconnect();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(server.tokenCalls()).toBe(2);
  });
});
