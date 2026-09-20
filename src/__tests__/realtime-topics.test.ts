import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RiviumSyncAdmin } from '../index';

/**
 * These topics must match what the backend publishes:
 *   rivium_sync/{projectId}/{dbName}/{collectionName}/changes      (collections)
 *   rivium_sync/{projectId}/{dbName}/{collectionName}/{documentId} (documents)
 *
 * Names, because that is what an app writes, under the project id so the same
 * database name in two projects cannot collide. They used to be
 * `rivium_sync/{apiKey16}/db/...`, which the backend never publishes, so
 * realtime silently delivered nothing; and the broker grants only
 * `rivium_sync/{projectId}/#`, so a wrong prefix is refused outright.
 */
describe('realtime topics match what the backend publishes', () => {
  const CONFIG = {
    apiKey: 'rv_live_test1234567890',
    serverSecret: 'rv_srv_secret1234567890',
    enableRealtime: true,
  };
  const DB = 'slumbercrib_monitors'; // a NAME, as an app would write it
  const PROJECT = 'a947d9ec-d829-4bf4-b609-25fe9bdf855d';
  const originalFetch = globalThis.fetch;

  let subscribed: string[];
  let admin: RiviumSyncAdmin;

  beforeEach(() => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') }) as any;

    subscribed = [];
    admin = new RiviumSyncAdmin(CONFIG);
    // Normally learned from POST /connections/token.
    (admin as any).projectId = PROJECT;
    // Stand in for a connected broker so we can see what is subscribed.
    (admin as any).mqttClient = {
      connected: true,
      subscribe: (topic: string) => subscribed.push(topic),
      unsubscribe: () => {},
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('subscribes a collection listener under the database id', () => {
    admin.listenCollection(DB, 'notes', () => {});

    expect(subscribed).toEqual([`rivium_sync/${PROJECT}/${DB}/notes/changes`]);
  });

  it('subscribes a document listener under the database id', () => {
    admin.listenDocument(DB, 'notes', 'doc-1', () => {});

    expect(subscribed).toEqual([`rivium_sync/${PROJECT}/${DB}/notes/doc-1`]);
  });

  it('never uses the old apiKey-prefixed scheme the backend does not publish', () => {
    admin.listenCollection(DB, 'notes', () => {});
    admin.listenDocument(DB, 'notes', 'doc-1', () => {});

    for (const topic of subscribed) {
      expect(topic.startsWith(`rivium_sync/${PROJECT}/${DB}/`)).toBe(true);
      expect(topic).not.toContain('/db/');
      expect(topic).not.toContain(CONFIG.apiKey.substring(0, 16));
    }
  });

  it('stays inside the subtree the broker grants for that project', () => {
    admin.listenCollection(DB, 'notes', () => {});

    // The acl claim allows rivium_sync/{projectId}/# and denies the rest.
    expect(subscribed.every((t) => t.startsWith(`rivium_sync/${PROJECT}/`))).toBe(true);
  });
});
