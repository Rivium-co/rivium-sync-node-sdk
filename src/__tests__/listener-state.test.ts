import { describe, it, expect } from 'vitest';
import {
  KeptDocument,
  applyEvent,
  applyLegacyChange,
  queryResult,
  replaceWithSnapshot,
  signatureOf,
  toKeptDocument,
} from '../listener-state';

const kept = (...docs: KeptDocument[]) => new Map(docs.map((d) => [d.id, d]));

describe('applyEvent', () => {
  it('adds and modifies documents with a newer version', () => {
    const docs = kept({ id: 'a', data: { x: 1 }, version: 1 });
    expect(applyEvent(docs, { type: 'added', documentId: 'b', data: { x: 2 }, version: 1 })).toBe(true);
    expect(applyEvent(docs, { type: 'modified', documentId: 'a', data: { x: 3 }, version: 2 })).toBe(true);
    expect(docs.get('a')).toMatchObject({ data: { x: 3 }, version: 2 });
    expect([...docs.keys()]).toEqual(['a', 'b']);
  });

  it('drops an event whose version is not newer than the one kept', () => {
    const docs = kept({ id: 'a', data: { x: 5 }, version: 5 });
    expect(applyEvent(docs, { type: 'modified', documentId: 'a', data: { x: 4 }, version: 4 })).toBe(false);
    expect(applyEvent(docs, { type: 'modified', documentId: 'a', data: { x: 5 }, version: 5 })).toBe(false);
    expect(applyEvent(docs, { type: 'added', documentId: 'a', data: { x: 1 }, version: 1 })).toBe(false);
    expect(docs.get('a')!.data).toEqual({ x: 5 });
  });

  it('applies an event without a version', () => {
    const docs = kept({ id: 'a', data: { x: 5 }, version: 5 });
    expect(applyEvent(docs, { type: 'modified', documentId: 'a', data: { x: 6 }, version: null })).toBe(true);
  });

  it('removed deletes the document (version null)', () => {
    const docs = kept({ id: 'a', data: {}, version: 1 });
    expect(applyEvent(docs, { type: 'removed', documentId: 'a', version: null })).toBe(true);
    expect(docs.size).toBe(0);
    expect(applyEvent(docs, { type: 'removed', documentId: 'a', version: null })).toBe(false);
  });

  it('ignores events without a document or data, and unknown types', () => {
    const docs = kept();
    expect(applyEvent(docs, { type: 'added', data: {} })).toBe(false);
    expect(applyEvent(docs, { type: 'modified', documentId: 'a' })).toBe(false);
    expect(applyEvent(docs, { type: 'something', documentId: 'a', data: {} })).toBe(false);
    expect(docs.size).toBe(0);
  });
});

describe('queryResult', () => {
  const docs = kept(
    { id: 'a', data: { rank: 3 } },
    { id: 'b', data: { rank: 1 } },
    { id: 'c', data: { rank: 2 } },
    { id: 'd', data: {} },
  );

  it('sorts by orderBy and trims to limit', () => {
    expect(queryResult(docs, { orderBy: 'rank', limit: 2 }).map((d) => d.id)).toEqual(['d', 'b']);
    expect(queryResult(docs, { orderBy: 'rank', orderDirection: 'desc', limit: 2 }).map((d) => d.id)).toEqual(['a', 'c']);
  });

  it('keeps arrival order without orderBy', () => {
    expect(queryResult(docs).map((d) => d.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('skips offset documents', () => {
    expect(queryResult(docs, { orderBy: 'rank', offset: 1, limit: 2 }).map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('filters when asked (older backends)', () => {
    expect(queryResult(docs, { filters: [{ field: 'rank', operator: '>=', value: 2 }] }).map((d) => d.id)).toEqual(['a', 'c']);
  });
});

describe('replaceWithSnapshot', () => {
  it('takes the snapshot, keeping a newer kept version', () => {
    const before = kept({ id: 'a', data: { v: 3 }, version: 3 }, { id: 'gone', data: {}, version: 1 });
    const after = replaceWithSnapshot(before, [
      { id: 'a', data: { v: 2 }, version: 2 },
      { id: 'b', data: {}, version: 1 },
    ]);
    expect([...after.keys()]).toEqual(['a', 'b']);
    expect(after.get('a')!.version).toBe(3);
  });
});

describe('applyLegacyChange', () => {
  it('create / update / delete, and the old deleted flag', () => {
    const docs = kept();
    expect(applyLegacyChange(docs, { type: 'create', documentId: 'a', data: { x: 1 } })).toBe(true);
    expect(applyLegacyChange(docs, { type: 'update', documentId: 'a', data: { x: 2 } })).toBe(true);
    expect(docs.get('a')!.data).toEqual({ x: 2 });
    expect(applyLegacyChange(docs, { type: 'delete', documentId: 'a' })).toBe(true);
    expect(docs.size).toBe(0);
    applyLegacyChange(docs, { type: 'create', documentId: 'b', data: {} });
    expect(applyLegacyChange(docs, { deleted: true, documentId: 'b' })).toBe(true);
  });

  it('uses the listener document id when the payload has none', () => {
    const docs = kept();
    expect(applyLegacyChange(docs, { type: 'update', data: { x: 1 } }, 'doc-1')).toBe(true);
    expect(docs.has('doc-1')).toBe(true);
  });
});

describe('toKeptDocument and signatureOf', () => {
  it('reads a listen answer document', () => {
    expect(toKeptDocument({ id: 'a', data: { x: 1 }, version: 2, updatedAt: '2026-10-26' })).toEqual({
      id: 'a',
      data: { x: 1 },
      version: 2,
      updatedAt: '2026-10-26',
    });
    expect(toKeptDocument(null)).toBeNull();
    expect(toKeptDocument({ data: {} })).toBeNull();
  });

  it('tells "no document" from "no documents" and notices data changes', () => {
    expect(signatureOf(null)).not.toBe(signatureOf([]));
    expect(signatureOf([{ id: 'a', data: { x: 1 } }])).not.toBe(signatureOf([{ id: 'a', data: { x: 2 } }]));
    expect(signatureOf([{ id: 'a', data: { x: 1 }, version: 1 }])).toBe(signatureOf([{ id: 'a', data: { x: 1 }, version: 1 }]));
  });
});
