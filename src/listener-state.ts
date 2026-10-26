/**
 * The documents a listener keeps, and how listener events change them.
 *
 * Pure functions (no network, no timers) so every rule is easy to test:
 * - an event older than what the listener already has (same or lower version) is dropped;
 * - `removed` deletes the document;
 * - a query listener's result is sorted by its `orderBy` and trimmed to its `limit` here, in the SDK.
 */

import type { QueryFilter } from './index';

/** One document as a listener keeps it. */
export interface KeptDocument {
  id: string;
  data: unknown;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** An event on a listener's private topic. */
export interface ListenerEvent {
  subscriptionId?: string;
  type?: string;
  documentId?: string;
  data?: unknown;
  version?: number | null;
  updatedAt?: string | null;
  reason?: string;
}

const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A document from a listen answer (`document` / `documents[]`), or null when it is not one. */
export function toKeptDocument(raw: unknown): KeptDocument | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  return {
    id: r.id,
    data: r.data ?? {},
    ...(isVersion(r.version) ? { version: r.version } : {}),
    ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt } : {}),
    ...(r.updatedAt != null ? { updatedAt: String(r.updatedAt) } : {}),
  };
}

/**
 * Applies an `added` / `modified` / `removed` event. Returns true when the kept documents changed.
 * An event whose version is not newer than the one already kept is stale and dropped.
 */
export function applyEvent(docs: Map<string, KeptDocument>, event: ListenerEvent): boolean {
  const id = event.documentId;
  if (typeof id !== 'string' || !id) return false;

  if (event.type === 'removed') {
    return docs.delete(id);
  }

  if ((event.type === 'added' || event.type === 'modified') && event.data !== undefined) {
    const known = docs.get(id);
    if (known && isVersion(known.version) && isVersion(event.version) && known.version >= event.version) {
      return false; // stale: the listener already has this version or a newer one
    }
    docs.set(id, {
      id,
      data: event.data,
      ...(isVersion(event.version) ? { version: event.version } : {}),
      ...(known?.createdAt ? { createdAt: known.createdAt } : {}),
      ...(event.updatedAt != null ? { updatedAt: String(event.updatedAt) } : known?.updatedAt ? { updatedAt: known.updatedAt } : {}),
    });
    return true;
  }

  return false;
}

/**
 * The kept documents after a new snapshot (a listener started again): the snapshot decides which documents exist;
 * for a document in both, the newer version wins.
 */
export function replaceWithSnapshot(docs: Map<string, KeptDocument>, snapshot: KeptDocument[]): Map<string, KeptDocument> {
  const next = new Map<string, KeptDocument>();
  for (const doc of snapshot) {
    const known = docs.get(doc.id);
    if (known && isVersion(known.version) && isVersion(doc.version) && known.version > doc.version) {
      next.set(doc.id, known);
    } else {
      next.set(doc.id, doc);
    }
  }
  return next;
}

/**
 * Applies a change from the per-collection / per-document topics older backends publish:
 * `{ type: 'create' | 'update' | 'delete', documentId, data }`. Returns true when something changed.
 */
export function applyLegacyChange(docs: Map<string, KeptDocument>, payload: unknown, fallbackDocumentId?: string): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const id = typeof p.documentId === 'string' && p.documentId ? p.documentId : fallbackDocumentId;
  if (!id) return false;
  if (p.type === 'delete' || p.deleted === true) {
    return docs.delete(id);
  }
  if (p.data === undefined || p.data === null) return false;
  const known = docs.get(id);
  docs.set(id, {
    id,
    data: p.data,
    ...(isVersion(p.version) ? { version: p.version } : {}),
    ...(known?.createdAt ? { createdAt: known.createdAt } : {}),
    ...(typeof p.timestamp === 'string' ? { updatedAt: p.timestamp } : known?.updatedAt ? { updatedAt: known.updatedAt } : {}),
  });
  return true;
}

function fieldOf(data: unknown, field: string): unknown {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (field in record) return record[field];
  // Dotted paths (`address.city`) reach into nested objects.
  let value: unknown = record;
  for (const part of field.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** Sorts documents by a field (missing values first when ascending). */
export function sortDocuments<D extends { data: unknown }>(docs: D[], field: string, direction: 'asc' | 'desc' = 'asc'): D[] {
  return [...docs].sort((a, b) => {
    const av = fieldOf(a.data, field) as string | number | boolean | null | undefined;
    const bv = fieldOf(b.data, field) as string | number | boolean | null | undefined;
    let c = 0;
    if (av == null && bv != null) c = -1;
    else if (av != null && bv == null) c = 1;
    else if (av != null && bv != null) {
      if (av < bv) c = -1;
      else if (av > bv) c = 1;
    }
    return direction === 'desc' ? -c : c;
  });
}

/** Client-side filter, for the per-collection topic of older backends (it carries every change of the collection). */
export function matchesFilters(data: unknown, filters: QueryFilter[]): boolean {
  return filters.every((f) => {
    const value = fieldOf(data, f.field);
    switch (f.operator) {
      case '==':
        return value === f.value;
      case '!=':
        return value !== f.value;
      case '<':
        return (value as number) < (f.value as number);
      case '<=':
        return (value as number) <= (f.value as number);
      case '>':
        return (value as number) > (f.value as number);
      case '>=':
        return (value as number) >= (f.value as number);
      case 'in':
        return Array.isArray(f.value) && f.value.includes(value);
      case 'not-in':
        return Array.isArray(f.value) && !f.value.includes(value);
      case 'array-contains':
        return Array.isArray(value) && value.includes(f.value);
      default:
        return true;
    }
  });
}

/** A query listener's result: the kept documents, sorted by `orderBy`, from `offset`, at most `limit`. */
export function queryResult(
  docs: Map<string, KeptDocument>,
  options: { orderBy?: string; orderDirection?: 'asc' | 'desc'; limit?: number; offset?: number; filters?: QueryFilter[] } = {},
): KeptDocument[] {
  let list = [...docs.values()];
  if (options.filters?.length) list = list.filter((d) => matchesFilters(d.data, options.filters!));
  if (options.orderBy) list = sortDocuments(list, options.orderBy, options.orderDirection);
  const start = options.offset && options.offset > 0 ? options.offset : 0;
  if (start || (options.limit && options.limit > 0)) {
    list = list.slice(start, options.limit && options.limit > 0 ? start + options.limit : undefined);
  }
  return list;
}

/** What the app was last shown, to deliver nothing when nothing changed. */
export function signatureOf(docs: KeptDocument[] | KeptDocument | null): string {
  const list = docs === null ? [] : Array.isArray(docs) ? docs : [docs];
  return JSON.stringify([docs === null, list.map((d) => [d.id, d.version ?? null, d.data])]);
}
