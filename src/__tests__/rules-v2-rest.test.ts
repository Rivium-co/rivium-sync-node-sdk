import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryNotAllowedError, RiviumSyncAdmin, RiviumSyncError, RiviumSyncErrorCode } from '../index';
import { BASE, routeFetch } from './fake-realtime';

const admin = () => new RiviumSyncAdmin({ apiKey: 'rv_live_test1234567890', serverSecret: 'rv_srv_secret1234567890' });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('queries are sent in POST …/documents/sdk/query', () => {
  it('a query sends its filters, order and paging in the body, with their JSON types', async () => {
    const { calls } = routeFetch(() => ({ status: 200, body: { data: [], total: 0 } }));

    await admin()
      .database('app')
      .collection('tasks')
      .where('teamId', '==', 'T1')
      .where('count', '>=', 3)
      .where('done', '==', false)
      .where('tag', 'in', ['a', 'b'])
      .orderBy('createdAt', 'desc')
      .limit(50)
      .offset(10)
      .get();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/databases/app/collections/tasks/documents/sdk/query');
    expect(calls[0].body).toEqual({
      filters: [
        { field: 'teamId', operator: '==', value: 'T1' },
        { field: 'count', operator: '>=', value: 3 },
        { field: 'done', operator: '==', value: false },
        { field: 'tag', operator: 'in', value: ['a', 'b'] },
      ],
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 50,
      offset: 10,
    });
  });

  it('getAll() without options sends an empty body', async () => {
    const { calls } = routeFetch(() => ({ status: 200, body: { data: [], total: 0 } }));
    await admin().database('app').collection('tasks').getAll();
    expect(calls[0].body).toEqual({});
  });

  it('reads the documents from the { data, total } answer', async () => {
    const docs = [{ id: 'a', data: { x: 1 }, version: 1 }];
    routeFetch(() => ({ status: 200, body: { data: docs, total: 1 } }));
    expect(await admin().database('app').collection('tasks').where('x', '==', 1).get()).toEqual(docs);
  });

  it('getFirst() asks for one document and leaves the query as it was', async () => {
    const { calls } = routeFetch(() => ({ status: 200, body: { data: [], total: 0 } }));
    const q = admin().database('app').collection('tasks').query().limit(20);
    await q.getFirst();
    await q.get();
    expect(calls.map((c) => c.body.limit)).toEqual([1, 20]);
  });
});

describe('query_not_allowed', () => {
  it('a 403 query_not_allowed is a QueryNotAllowedError with the fields and the server message', async () => {
    routeFetch(() => ({
      status: 403,
      body: {
        statusCode: 403,
        error: 'Forbidden',
        code: 'query_not_allowed',
        message: 'This query is not allowed by the security rules. Filter on teamId.',
        fields: ['teamId'],
      },
    }));

    const error = await admin().database('app').collection('tasks').where('done', '==', false).get().catch((e) => e);

    expect(error).toBeInstanceOf(QueryNotAllowedError);
    expect(error).toBeInstanceOf(RiviumSyncError);
    expect(error.code).toBe(RiviumSyncErrorCode.QUERY_NOT_ALLOWED);
    expect(error.serverCode).toBe('query_not_allowed');
    expect(error.status).toBe(403);
    expect(error.fields).toEqual(['teamId']);
    expect(error.details).toBe('This query is not allowed by the security rules. Filter on teamId.');
    expect(error.toJSON()).toMatchObject({ code: RiviumSyncErrorCode.QUERY_NOT_ALLOWED, fields: ['teamId'] });
  });

  it('fields are empty when the server names none', async () => {
    routeFetch(() => ({ status: 403, body: { code: 'query_not_allowed', message: 'Not allowed' } }));
    const error = await admin().database('app').collection('tasks').getAll().catch((e) => e);
    expect(error).toBeInstanceOf(QueryNotAllowedError);
    expect(error.fields).toEqual([]);
  });

  it('other errors stay RiviumSyncError with their status and server code', async () => {
    routeFetch(() => ({ status: 403, body: { statusCode: 403, message: 'Read permission denied by security rules' } }));
    const denied = await admin().database('app').collection('tasks').getAll().catch((e) => e);
    expect(denied).not.toBeInstanceOf(QueryNotAllowedError);
    expect(denied.code).toBe(RiviumSyncErrorCode.DATA_FETCH_FAILED);
    expect(denied.status).toBe(403);
    expect(denied.details).toContain('HTTP 403');

    routeFetch(() => ({ status: 400, body: { code: 'bad_filter', message: "Unknown operator 'x'" } }));
    const bad = await admin().database('app').collection('tasks').getAll().catch((e) => e);
    expect(bad.serverCode).toBe('bad_filter');

    routeFetch(() => ({ status: 500, body: 'oops' }));
    const plain = await admin().database('app').collection('tasks').getAll().catch((e) => e);
    expect(plain.status).toBe(500);
    expect(plain.serverCode).toBeUndefined();
  });
});

describe('set() replaces, set(data, { merge: true }) merges', () => {
  it('set(data) sends merge: false', async () => {
    const { calls } = routeFetch(() => ({ status: 200, body: { data: {} } }));
    await admin().database('app').collection('users').doc('u1').set({ name: 'Ann' });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].path).toBe('/databases/app/collections/users/documents/sdk/u1');
    expect(calls[0].body).toEqual({ data: { name: 'Ann' }, merge: false });
  });

  it('set(data, { merge: true }) sends merge: true', async () => {
    const { calls } = routeFetch(() => ({ status: 200, body: { data: {} } }));
    await admin().database('app').collection<{ name: string; age: number }>('users').doc('u1').set({ age: 31 }, { merge: true });
    expect(calls[0].body).toEqual({ data: { age: 31 }, merge: true });
  });

  it('set(data, { merge: false }) sends merge: false', async () => {
    const { calls } = routeFetch(() => ({ status: 200, body: { data: {} } }));
    await admin().database('app').collection('users').doc('u1').set({ a: 1 }, { merge: false });
    expect(calls[0].body.merge).toBe(false);
  });

  it('a batch set carries the merge flag the same way', async () => {
    const { calls } = routeFetch(() => ({ status: 200, body: { data: {} } }));
    const sync = admin();
    const users = sync.database('app').collection('users');
    await sync
      .batch()
      .set(users.doc('u1'), { name: 'Ann' })
      .set(users.doc('u2'), { age: 3 }, { merge: true })
      .update(users.doc('u3'), { age: 4 })
      .commit();

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/batch/sdk');
    expect(calls[0].body.operations.map((o: any) => [o.type, o.documentId, o.merge])).toEqual([
      ['set', 'u1', false],
      ['set', 'u2', true],
      ['update', 'u3', undefined],
    ]);
  });
});

describe('answers wrapped in { data }', () => {
  it('get() of a document returns the document, not the wrapper', async () => {
    const doc = { id: 'u1', data: { name: 'Ann' }, version: 3 };
    routeFetch(() => ({ status: 200, body: { data: doc } }));
    expect(await admin().database('app').collection('users').get('u1')).toEqual(doc);
  });

  it('add() returns the created document', async () => {
    const doc = { id: 'new-id', data: { name: 'Ann' }, version: 1 };
    const { calls } = routeFetch(() => ({ status: 201, body: { data: doc } }));
    expect(await admin().database('app').collection('users').add({ name: 'Ann' })).toEqual(doc);
    expect(calls[0].path).toBe('/databases/app/collections/users/documents/sdk');
  });

  it('a missing document is null', async () => {
    routeFetch(() => ({ status: 404, body: { statusCode: 404, message: 'Document not found' } }));
    expect(await admin().database('app').collection('users').get('nope')).toBeNull();
  });
});

describe('request URL', () => {
  it('uses the Sync API base', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"data":[]}' });
    vi.stubGlobal('fetch', fetchSpy);
    await admin().database('app').collection('t').getAll();
    expect(fetchSpy.mock.calls[0][0]).toBe(`${BASE}/databases/app/collections/t/documents/sdk/query`);
  });
});
