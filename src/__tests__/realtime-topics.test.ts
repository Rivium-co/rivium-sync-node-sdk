import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('mqtt', async () => {
  const f = await import('./fake-mqtt');
  return { default: { connect: f.connect }, connect: f.connect };
});

import { PROJECT, clients, flush, listenCalls, realtimeAdmin } from './fake-realtime';

/**
 * Older backends (no POST …/listen: 404) publish every change on
 *   rivium_sync/{projectId}/{dbName}/{collectionName}/changes      (collections)
 *   rivium_sync/{projectId}/{dbName}/{collectionName}/{documentId} (documents)
 * as { type: 'create' | 'update' | 'delete', documentId, data }. The SDK falls back to them, unchanged.
 *
 * These topics have five levels. The message handler used to require six, so listeners never fired.
 */
describe('fallback to collection topics on an older backend (listen answers 404)', () => {
  const DB = 'my_app'; // a NAME, as an app would write it
  const COLLECTION_TOPIC = `rivium_sync/${PROJECT}/${DB}/notes/changes`;
  const DOCUMENT_TOPIC = `rivium_sync/${PROJECT}/${DB}/notes/doc-1`;

  const route = (method: string, path: string) => {
    if (method === 'POST' && path.endsWith('/listen')) return { status: 404, body: { statusCode: 404, message: `Cannot POST ${path}` } };
    if (method === 'POST' && path === `/databases/${DB}/collections/notes/documents/sdk/query`) {
      return { status: 200, body: { data: [{ id: 'n1', data: { done: false, rank: 2 } }], total: 1 } };
    }
    if (method === 'GET' && path === `/databases/${DB}/collections/notes/documents/sdk/doc-1`) {
      return { status: 200, body: { data: { id: 'doc-1', data: { title: 'A' }, version: 1 } } };
    }
    return undefined;
  };

  beforeEach(() => {
    clients.length = 0;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribes a collection listener to …/changes under the project id', async () => {
    const { admin, client, calls } = await realtimeAdmin(route);
    admin.listenCollection(DB, 'notes', () => {});
    await flush();

    expect(listenCalls(calls)).toHaveLength(1);
    expect(client.subscribed).toEqual([COLLECTION_TOPIC]);
  });

  it('subscribes a document listener to its document topic', async () => {
    const { admin, client } = await realtimeAdmin(route);
    admin.listenDocument(DB, 'notes', 'doc-1', () => {});
    await flush();

    expect(client.subscribed).toEqual([DOCUMENT_TOPIC]);
  });

  it('stays inside the subtree the broker grants for that project, never the old apiKey scheme', async () => {
    const { admin, client } = await realtimeAdmin(route);
    admin.listenCollection(DB, 'notes', () => {});
    admin.listenDocument(DB, 'notes', 'doc-1', () => {});
    await flush();

    for (const topic of client.subscribed) {
      expect(topic.startsWith(`rivium_sync/${PROJECT}/${DB}/`)).toBe(true);
      expect(topic).not.toContain('/db/');
    }
  });

  it('a collection listener fires: first the query result, then create / update / delete', async () => {
    const { admin, client } = await realtimeAdmin(route);
    const seen: any[] = [];
    admin.listenCollection(DB, 'notes', (docs) => seen.push(docs));
    await flush();
    expect(seen[0].map((d: any) => d.id)).toEqual(['n1']);

    client.publish(COLLECTION_TOPIC, { type: 'create', documentId: 'n2', collectionName: 'notes', data: { done: true, rank: 1 } });
    expect(seen.at(-1).map((d: any) => d.id)).toEqual(['n1', 'n2']);

    client.publish(COLLECTION_TOPIC, { type: 'update', documentId: 'n1', collectionName: 'notes', data: { done: true, rank: 2 } });
    expect(seen.at(-1).find((d: any) => d.id === 'n1').data).toEqual({ done: true, rank: 2 });

    client.publish(COLLECTION_TOPIC, { type: 'delete', documentId: 'n2', collectionName: 'notes' });
    expect(seen.at(-1).map((d: any) => d.id)).toEqual(['n1']);
  });

  it('a filtered collection listener keeps its filters and order on the collection topic', async () => {
    const { admin, client } = await realtimeAdmin(route);
    const seen: any[] = [];
    admin
      .database(DB)
      .collection('notes')
      .where('done', '==', false)
      .orderBy('rank')
      .onSnapshot((docs) => seen.push(docs));
    await flush();

    client.publish(COLLECTION_TOPIC, { type: 'create', documentId: 'n3', data: { done: true, rank: 0 } });
    // n3 does not match: nothing new for the app.
    expect(seen).toHaveLength(1);

    client.publish(COLLECTION_TOPIC, { type: 'create', documentId: 'n4', data: { done: false, rank: 1 } });
    expect(seen.at(-1).map((d: any) => d.id)).toEqual(['n4', 'n1']);
  });

  it('a document listener fires: first the document, then its changes, null when deleted', async () => {
    const { admin, client } = await realtimeAdmin(route);
    const seen: any[] = [];
    admin.listenDocument(DB, 'notes', 'doc-1', (doc) => seen.push(doc));
    await flush();

    client.publish(DOCUMENT_TOPIC, { type: 'update', documentId: 'doc-1', data: { title: 'B' } });
    client.publish(DOCUMENT_TOPIC, { type: 'delete', documentId: 'doc-1' });

    expect(seen.map((d) => (d ? d.data.title : null))).toEqual(['A', 'B', null]);
  });

  it('a document change does not reach a collection listener twice', async () => {
    const { admin, client } = await realtimeAdmin(route);
    const collection: any[] = [];
    admin.listenCollection(DB, 'notes', (docs) => collection.push(docs));
    admin.listenDocument(DB, 'notes', 'doc-1', () => {});
    await flush();
    const before = collection.length;

    // The backend publishes the same change on both topics.
    const change = { type: 'create', documentId: 'doc-1', data: { title: 'A' } };
    client.publish(COLLECTION_TOPIC, change);
    client.publish(DOCUMENT_TOPIC, change);

    expect(collection.length).toBe(before + 1);
  });

  it('stopping unsubscribes the topic and sends no DELETE', async () => {
    const { admin, client, calls } = await realtimeAdmin(route);
    const stop = admin.listenCollection(DB, 'notes', () => {});
    await flush();
    stop();
    await flush();

    expect(client.unsubscribed).toEqual([COLLECTION_TOPIC]);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
