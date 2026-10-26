import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('mqtt', async () => {
  const f = await import('./fake-mqtt');
  return { default: { connect: f.connect }, connect: f.connect };
});

import { ListenerRevokedError, QueryNotAllowedError, RiviumSyncError, RiviumSyncErrorCode } from '../index';
import { PROJECT, clients, flush, listenCalls, realtimeAdmin } from './fake-realtime';

/**
 * Server-routed listeners: POST …/listen answers a private topic and the current result (the first callback),
 * events on that topic are applied with version checks, the server may end a listener, it is started again before
 * it expires, and stopped with DELETE …/listen/{id}.
 */

const SUB1 = '11111111-1111-4111-8111-111111111111';
const SUB2 = '22222222-2222-4222-8222-222222222222';
const topicOf = (sub: string) => `rivium_sync/${PROJECT}/s/${sub}`;
const inADay = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  clients.length = 0;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('document listener', () => {
  async function start(document: unknown = { id: 'doc-1', data: { title: 'A' }, version: 1, updatedAt: '2026-10-26T10:00:00Z' }) {
    const ctx = await realtimeAdmin((method, path) => {
      if (method === 'POST' && path === '/databases/app/collections/notes/listen') {
        return { status: 200, body: { subscriptionId: SUB1, topic: topicOf(SUB1), expiresAt: inADay(), document } };
      }
      return undefined;
    });
    const seen: unknown[] = [];
    const errors: RiviumSyncError[] = [];
    const unsubscribe = ctx.admin
      .database('app')
      .collection('notes')
      .doc('doc-1')
      .onSnapshot((doc) => seen.push(doc), (e) => errors.push(e));
    await flush();
    return { ...ctx, seen, errors, unsubscribe };
  }

  it('asks the server with the MQTT client id and the document id, and subscribes the private topic', async () => {
    const { calls, client } = await start();

    const [listen] = listenCalls(calls);
    expect(listen.body).toEqual({ clientId: client.options.clientId, documentId: 'doc-1' });
    expect(String(client.options.clientId)).toMatch(/^rivium_sync_node_/);
    expect(listen.headers['X-Rivium-SDK']).toMatch(/^node\//);
    expect(client.subscribed).toEqual([topicOf(SUB1)]);
  });

  it('delivers the snapshot from the answer as the first callback', async () => {
    const { seen } = await start();
    expect(seen).toEqual([{ id: 'doc-1', data: { title: 'A' }, version: 1, updatedAt: '2026-10-26T10:00:00Z' }]);
  });

  it('delivers null first when the document does not exist', async () => {
    const { seen } = await start(null);
    expect(seen).toEqual([null]);
  });

  it('applies modified events, drops stale versions and reports removal as null', async () => {
    const { client, seen } = await start();

    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'modified', documentId: 'doc-1', data: { title: 'B' }, version: 2 });
    // Already known (the snapshot or an earlier event had it): dropped.
    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'modified', documentId: 'doc-1', data: { title: 'old' }, version: 1 });
    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'modified', documentId: 'doc-1', data: { title: 'B again' }, version: 2 });
    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'removed', documentId: 'doc-1', version: null });

    expect(seen.map((d: any) => (d ? d.data.title : null))).toEqual(['A', 'B', null]);
    expect((seen[1] as any).version).toBe(2);
  });

  it('stops with DELETE …/listen/{id} and unsubscribes the topic', async () => {
    const { calls, client, unsubscribe, seen } = await start();

    unsubscribe();
    await flush();

    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/databases/app/listen/${SUB1}`)).toBe(true);
    expect(client.unsubscribed).toEqual([topicOf(SUB1)]);
    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'modified', documentId: 'doc-1', data: { title: 'C' }, version: 3 });
    expect(seen).toHaveLength(1);
  });
});

describe('query listener', () => {
  const docs = [
    { id: 'a', data: { teamId: 'T1', rank: 1 }, version: 1 },
    { id: 'b', data: { teamId: 'T1', rank: 2 }, version: 1 },
  ];

  async function start(limit = 2) {
    const ctx = await realtimeAdmin((method, path) => {
      if (method === 'POST' && path === '/databases/app/collections/tasks/listen') {
        return { status: 200, body: { subscriptionId: SUB1, topic: topicOf(SUB1), expiresAt: inADay(), documents: docs } };
      }
      return undefined;
    });
    const seen: Array<Array<{ id: string; data: any; version?: number }>> = [];
    ctx.admin
      .database('app')
      .collection('tasks')
      .where('teamId', '==', 'T1')
      .orderBy('rank', 'asc')
      .limit(limit)
      .onSnapshot((list) => seen.push(list as any));
    await flush();
    return { ...ctx, seen };
  }

  it('sends filters, orderBy and limit in the listen body', async () => {
    const { calls, client } = await start();
    expect(listenCalls(calls)[0].body).toEqual({
      clientId: client.options.clientId,
      filters: [{ field: 'teamId', operator: '==', value: 'T1' }],
      orderBy: { field: 'rank', direction: 'asc' },
      limit: 2,
    });
  });

  it('delivers the answer documents first', async () => {
    const { seen } = await start();
    expect(seen[0].map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('applies added events with its own order and limit', async () => {
    const { client, seen } = await start();

    // rank 0 sorts first; the limit of 2 drops 'b'.
    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'added', documentId: 'c', data: { teamId: 'T1', rank: 0 }, version: 1 });
    expect(seen.at(-1)!.map((d) => d.id)).toEqual(['c', 'a']);

    // 'c' moves to the end: 'a', 'b' are the first two again.
    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'modified', documentId: 'c', data: { teamId: 'T1', rank: 9 }, version: 2 });
    expect(seen.at(-1)!.map((d) => d.id)).toEqual(['a', 'b']);

    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'removed', documentId: 'a', version: null });
    expect(seen.at(-1)!.map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('drops events older than what it has', async () => {
    const { client, seen } = await start();

    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'modified', documentId: 'a', data: { teamId: 'T1', rank: 5 }, version: 1 });
    expect(seen).toHaveLength(1);

    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'modified', documentId: 'a', data: { teamId: 'T1', rank: 5 }, version: 3 });
    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'modified', documentId: 'a', data: { teamId: 'T1', rank: 1 }, version: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[1].find((d) => d.id === 'a')).toMatchObject({ data: { rank: 5 }, version: 3 });
  });

  it('a removed event for a document it does not have changes nothing', async () => {
    const { client, seen } = await start();
    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'removed', documentId: 'zzz', version: null });
    expect(seen).toHaveLength(1);
  });

  it('with offset asks for offset + limit and skips the first ones itself', async () => {
    const ctx = await realtimeAdmin((method, path) =>
      method === 'POST' && path.endsWith('/listen')
        ? { status: 200, body: { subscriptionId: SUB1, topic: topicOf(SUB1), expiresAt: inADay(), documents: docs } }
        : undefined,
    );
    const seen: any[] = [];
    ctx.admin.database('app').collection('tasks').query().orderBy('rank').offset(1).limit(1).onSnapshot((l) => seen.push(l));
    await flush();
    expect(listenCalls(ctx.calls)[0].body.limit).toBe(2);
    expect(seen[0].map((d: any) => d.id)).toEqual(['b']);
  });
});

describe('revoked', () => {
  async function start() {
    let n = 0;
    const answers = [SUB1, SUB2];
    const ctx = await realtimeAdmin((method, path) => {
      if (method === 'POST' && path.endsWith('/listen')) {
        const sub = answers[Math.min(n++, answers.length - 1)];
        return {
          status: 200,
          body: { subscriptionId: sub, topic: topicOf(sub), expiresAt: inADay(), documents: [{ id: 'a', data: { x: 1 }, version: 1 }] },
        };
      }
      return undefined;
    });
    const seen: any[] = [];
    const errors: RiviumSyncError[] = [];
    ctx.admin.database('app').collection('tasks').onSnapshot((l) => seen.push(l), undefined, (e) => errors.push(e));
    await flush();
    return { ...ctx, seen, errors };
  }

  it('reason "permission" stops the listener and reports a ListenerRevokedError (never restarted)', async () => {
    const { client, calls, seen, errors } = await start();

    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'revoked', reason: 'permission' });
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ListenerRevokedError);
    expect(errors[0].code).toBe(RiviumSyncErrorCode.LISTENER_REVOKED);
    expect(errors[0].serverCode).toBe('listener_revoked');
    expect((errors[0] as ListenerRevokedError).reason).toBe('permission');
    expect(listenCalls(calls)).toHaveLength(1);
    expect(client.unsubscribed).toContain(topicOf(SUB1));

    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'added', documentId: 'b', data: { x: 2 }, version: 1 });
    expect(seen).toHaveLength(1);
  });

  it('reason "expired" starts it again on a new topic without a duplicate snapshot', async () => {
    const { client, calls, seen, errors } = await start();

    client.publish(topicOf(SUB1), { subscriptionId: SUB1, type: 'revoked', reason: 'expired' });
    await flush();

    expect(errors).toEqual([]);
    expect(listenCalls(calls)).toHaveLength(2);
    expect(client.subscribed).toEqual([topicOf(SUB1), topicOf(SUB2)]);
    expect(client.unsubscribed).toEqual([topicOf(SUB1)]);
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/databases/app/listen/${SUB1}`)).toBe(true);
    // Same documents in the new answer: nothing new for the app.
    expect(seen).toHaveLength(1);

    client.publish(topicOf(SUB2), { subscriptionId: SUB2, type: 'added', documentId: 'b', data: { x: 2 }, version: 1 });
    expect(seen.at(-1).map((d: any) => d.id)).toEqual(['a', 'b']);
  });
});

describe('re-listen before expiresAt', () => {
  it('starts the listener again about an hour before it expires, then stops the old one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let n = 0;
    const ctx = await realtimeAdmin((method, path) => {
      if (method === 'POST' && path.endsWith('/listen')) {
        const sub = n++ === 0 ? SUB1 : SUB2;
        return {
          status: 200,
          body: {
            subscriptionId: sub,
            topic: topicOf(sub),
            expiresAt: inADay(),
            document: { id: 'doc-1', data: { v: n }, version: n },
          },
        };
      }
      return undefined;
    });
    const seen: any[] = [];
    ctx.admin.database('app').collection('notes').doc('doc-1').onSnapshot((d) => seen.push(d));
    await flush();
    expect(listenCalls(ctx.calls)).toHaveLength(1);

    vi.advanceTimersByTime(22 * 60 * 60 * 1000);
    await flush();
    expect(listenCalls(ctx.calls)).toHaveLength(1);

    vi.advanceTimersByTime(60 * 60 * 1000 + 1000);
    await flush();
    expect(listenCalls(ctx.calls)).toHaveLength(2);
    expect(ctx.client.subscribed).toEqual([topicOf(SUB1), topicOf(SUB2)]);
    expect(ctx.client.unsubscribed).toEqual([topicOf(SUB1)]);
    expect(ctx.calls.some((c) => c.method === 'DELETE' && c.path === `/databases/app/listen/${SUB1}`)).toBe(true);
    // The new answer has a newer version: delivered once.
    expect(seen.map((d) => d.version)).toEqual([1, 2]);
  });
});

describe('connection', () => {
  it('a listener started while offline starts when the connection comes up', async () => {
    const ctx = await realtimeAdmin(
      (method, path) =>
        method === 'POST' && path.endsWith('/listen')
          ? { status: 200, body: { subscriptionId: SUB1, topic: topicOf(SUB1), expiresAt: inADay(), document: null } }
          : undefined,
      { connected: false },
    );
    const seen: any[] = [];
    ctx.admin.database('app').collection('notes').doc('doc-1').onSnapshot((d) => seen.push(d));
    await flush();
    expect(listenCalls(ctx.calls)).toHaveLength(0);

    ctx.client.connectNow();
    await flush();
    expect(listenCalls(ctx.calls)).toHaveLength(1);
    expect(seen).toEqual([null]);
  });

  it('subscribes the private topics again after a reconnect', async () => {
    const ctx = await realtimeAdmin((method, path) =>
      method === 'POST' && path.endsWith('/listen')
        ? { status: 200, body: { subscriptionId: SUB1, topic: topicOf(SUB1), expiresAt: inADay(), document: null } }
        : undefined,
    );
    ctx.admin.database('app').collection('notes').doc('doc-1').onSnapshot(() => {});
    await flush();

    ctx.client.drop();
    ctx.client.connectNow();
    await flush();

    expect(ctx.client.subscribed).toEqual([topicOf(SUB1), topicOf(SUB1)]);
    expect(listenCalls(ctx.calls)).toHaveLength(1);
  });

  it('a server error is retried later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let n = 0;
    const ctx = await realtimeAdmin((method, path) => {
      if (method === 'POST' && path.endsWith('/listen')) {
        return n++ === 0
          ? { status: 503, body: 'unavailable' }
          : { status: 200, body: { subscriptionId: SUB1, topic: topicOf(SUB1), expiresAt: inADay(), document: null } };
      }
      return undefined;
    });
    const seen: any[] = [];
    const errors: unknown[] = [];
    ctx.admin.database('app').collection('notes').doc('doc-1').onSnapshot((d) => seen.push(d), (e) => errors.push(e));
    await flush();
    expect(seen).toEqual([]);

    vi.advanceTimersByTime(1000);
    await flush();
    expect(listenCalls(ctx.calls)).toHaveLength(2);
    expect(seen).toEqual([null]);
    expect(errors).toEqual([]);
  });
});

describe('listen refused', () => {
  it('403 query_not_allowed reaches the error callback with its fields, and never falls back', async () => {
    const ctx = await realtimeAdmin((method, path) =>
      method === 'POST' && path.endsWith('/listen')
        ? { status: 403, body: { statusCode: 403, code: 'query_not_allowed', message: 'This listener is not allowed by the security rules.', fields: ['teamId'] } }
        : undefined,
    );
    const seen: any[] = [];
    const errors: RiviumSyncError[] = [];
    ctx.admin.database('app').collection('tasks').query().onSnapshot((l) => seen.push(l), (e) => errors.push(e));
    await flush();

    expect(seen).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(QueryNotAllowedError);
    expect((errors[0] as QueryNotAllowedError).fields).toEqual(['teamId']);
    expect(errors[0].details).toBe('This listener is not allowed by the security rules.');
    expect(ctx.client.subscribed).toEqual([]);
    expect(ctx.calls.filter((c) => c.path.endsWith('/documents/sdk/query'))).toHaveLength(0);
  });

  it('403 read denied reaches the error callback with its status', async () => {
    const ctx = await realtimeAdmin((method, path) =>
      method === 'POST' && path.endsWith('/listen')
        ? { status: 403, body: { statusCode: 403, message: 'Read permission denied by security rules' } }
        : undefined,
    );
    const errors: RiviumSyncError[] = [];
    ctx.admin.database('app').collection('notes').doc('doc-1').onSnapshot(() => {}, (e) => errors.push(e));
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RiviumSyncError);
    expect(errors[0].status).toBe(403);
    expect(errors[0].details).toContain('Read permission denied');
    expect(ctx.client.subscribed).toEqual([]);
  });

  it('403 too_many_listeners carries its server code', async () => {
    const ctx = await realtimeAdmin((method, path) =>
      method === 'POST' && path.endsWith('/listen')
        ? { status: 403, body: { statusCode: 403, code: 'too_many_listeners', message: 'At most 100 listeners per connection' } }
        : undefined,
    );
    const errors: RiviumSyncError[] = [];
    ctx.admin.database('app').collection('notes').onSnapshot(() => {}, undefined, (e) => errors.push(e));
    await flush();
    expect(errors[0].serverCode).toBe('too_many_listeners');
  });
});

describe('disconnect', () => {
  it('stops every listener on the server', async () => {
    const ctx = await realtimeAdmin((method, path) =>
      method === 'POST' && path.endsWith('/listen')
        ? { status: 200, body: { subscriptionId: SUB1, topic: topicOf(SUB1), expiresAt: inADay(), document: null } }
        : undefined,
    );
    ctx.admin.database('app').collection('notes').doc('doc-1').onSnapshot(() => {});
    await flush();

    ctx.admin.disconnect();
    await flush();
    expect(ctx.calls.some((c) => c.method === 'DELETE' && c.path === `/databases/app/listen/${SUB1}`)).toBe(true);
  });
});
