/**
 * RiviumSync Node.js SDK
 * Server-side SDK for RiviumSync Realtime Database
 *
 * Features:
 * - Admin-level access (bypasses security rules by default)
 * - Full CRUD operations on databases, collections, documents
 * - Query support with filters, sorting, pagination
 * - Batch operations for atomic writes
 * - Realtime subscriptions
 * - Ideal for backend services, serverless functions, data migrations
 *
 * @packageDocumentation
 */

import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import { randomUUID } from 'node:crypto';
import { SDK_NAME, SDK_VERSION } from './version';
import {
  KeptDocument,
  ListenerEvent,
  applyEvent,
  applyLegacyChange,
  queryResult,
  replaceWithSnapshot,
  signatureOf,
  toKeptDocument,
} from './listener-state';
import { isTransientError } from './sync-errors';

export { SDK_NAME, SDK_VERSION };

/** Sent as `X-Rivium-SDK` on every request: `node/<version>`. */
export const SDK_HEADER_VALUE = `${SDK_NAME}/${SDK_VERSION}`;

// ============================================================================
// Error Codes
// ============================================================================

export enum RiviumSyncErrorCode {
  // Connection errors (1000-1099)
  CONNECTION_FAILED = 1000,
  CONNECTION_TIMEOUT = 1001,
  CONNECTION_LOST = 1002,
  AUTHENTICATION_FAILED = 1004,

  // Subscription errors (1100-1199)
  SUBSCRIPTION_FAILED = 1100,
  /** The server ended a listener: the user may no longer read what it listens to. */
  LISTENER_REVOKED = 1101,

  // Data errors (1200-1299)
  DATA_FETCH_FAILED = 1200,
  DATA_PARSE_ERROR = 1201,
  DATA_WRITE_FAILED = 1202,
  DATA_DELETE_FAILED = 1203,
  DOCUMENT_NOT_FOUND = 1204,

  // Configuration errors (1300-1399)
  INVALID_CONFIG = 1300,
  MISSING_API_KEY = 1301,
  MISSING_SERVER_URL = 1302,
  MISSING_SERVER_SECRET = 1303,

  // State errors (1500-1599)
  NOT_INITIALIZED = 1500,
  NOT_CONNECTED = 1501,

  // Query errors (1700-1799)
  INVALID_QUERY = 1700,
  QUERY_EXECUTION_FAILED = 1701,
  /** The security rules do not allow this query (rules are not filters: add the filters they require). */
  QUERY_NOT_ALLOWED = 1702,

  // Batch errors (1800-1899)
  BATCH_WRITE_FAILED = 1800,

  // Unknown error
  UNKNOWN_ERROR = 9999,
}

const ERROR_MESSAGES: Record<RiviumSyncErrorCode, string> = {
  [RiviumSyncErrorCode.CONNECTION_FAILED]: 'Failed to connect to server',
  [RiviumSyncErrorCode.CONNECTION_TIMEOUT]: 'Connection timed out',
  [RiviumSyncErrorCode.CONNECTION_LOST]: 'Connection to server was lost',
  [RiviumSyncErrorCode.AUTHENTICATION_FAILED]: 'Authentication failed - invalid API key',
  [RiviumSyncErrorCode.SUBSCRIPTION_FAILED]: 'Failed to subscribe to path',
  [RiviumSyncErrorCode.LISTENER_REVOKED]: 'The listener was ended by the server',
  [RiviumSyncErrorCode.DATA_FETCH_FAILED]: 'Failed to fetch data',
  [RiviumSyncErrorCode.DATA_PARSE_ERROR]: 'Failed to parse data',
  [RiviumSyncErrorCode.DATA_WRITE_FAILED]: 'Failed to write data',
  [RiviumSyncErrorCode.DATA_DELETE_FAILED]: 'Failed to delete data',
  [RiviumSyncErrorCode.DOCUMENT_NOT_FOUND]: 'Document not found',
  [RiviumSyncErrorCode.INVALID_CONFIG]: 'Invalid configuration',
  [RiviumSyncErrorCode.MISSING_API_KEY]: 'API key is missing',
  [RiviumSyncErrorCode.MISSING_SERVER_URL]: 'Server URL is missing',
  [RiviumSyncErrorCode.MISSING_SERVER_SECRET]: 'Server secret is missing',
  [RiviumSyncErrorCode.NOT_INITIALIZED]: 'SDK is not initialized',
  [RiviumSyncErrorCode.NOT_CONNECTED]: 'Not connected to server',
  [RiviumSyncErrorCode.INVALID_QUERY]: 'Invalid query parameters',
  [RiviumSyncErrorCode.QUERY_EXECUTION_FAILED]: 'Query execution failed',
  [RiviumSyncErrorCode.QUERY_NOT_ALLOWED]: 'Query not allowed by security rules',
  [RiviumSyncErrorCode.BATCH_WRITE_FAILED]: 'Batch write operation failed',
  [RiviumSyncErrorCode.UNKNOWN_ERROR]: 'An unknown error occurred',
};

export interface RiviumSyncErrorInit {
  /** HTTP status of the answer, when the error came from the Sync API. */
  status?: number;
  /** The Sync API's error code, e.g. `query_not_allowed`, `too_many_listeners`. */
  serverCode?: string;
}

export class RiviumSyncError extends Error {
  readonly code: RiviumSyncErrorCode;
  readonly details?: string;
  /** HTTP status of the answer, when the error came from the Sync API. */
  readonly status?: number;
  /** The Sync API's error code, e.g. `query_not_allowed`, `listener_revoked`, `too_many_listeners`. */
  readonly serverCode?: string;

  constructor(code: RiviumSyncErrorCode, details?: string, init?: RiviumSyncErrorInit) {
    super(ERROR_MESSAGES[code] || 'Unknown error');
    this.name = 'RiviumSyncError';
    this.code = code;
    this.details = details;
    if (init?.status !== undefined) this.status = init.status;
    if (init?.serverCode !== undefined) this.serverCode = init.serverCode;
  }

  /** HTTP status the Sync API answered with; `undefined` when the server could not be reached. Same as `status`. */
  get statusCode(): number | undefined {
    return this.status;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.serverCode !== undefined ? { serverCode: this.serverCode } : {}),
    };
  }
}

/**
 * The security rules do not allow this query: rules are not filters, so a query must itself ask only for documents
 * the user may read (for example `where('teamId', '==', myTeam)`). `fields` names the filters the rules expect, when
 * the server can tell. Thrown by `get()` of a query and passed to a listener's error callback.
 */
export class QueryNotAllowedError extends RiviumSyncError {
  /** The fields the rules need the query to filter on (may be empty). */
  readonly fields: string[];

  constructor(details?: string, fields: string[] = []) {
    super(RiviumSyncErrorCode.QUERY_NOT_ALLOWED, details, { status: 403, serverCode: 'query_not_allowed' });
    this.name = 'QueryNotAllowedError';
    this.fields = fields;
  }

  toJSON() {
    return { ...super.toJSON(), fields: this.fields };
  }
}

/**
 * The server ended a listener because the user may no longer read what it listens to (the rules changed, or the
 * user lost access). The listener is stopped and is not started again.
 */
export class ListenerRevokedError extends RiviumSyncError {
  /** Why the server ended it, e.g. `permission`. */
  readonly reason: string;

  constructor(reason = 'permission') {
    super(RiviumSyncErrorCode.LISTENER_REVOKED, `The listener was revoked (${reason})`, { serverCode: 'listener_revoked' });
    this.name = 'ListenerRevokedError';
    this.reason = reason;
  }

  toJSON() {
    return { ...super.toJSON(), reason: this.reason };
  }
}

/**
 * The error a failed Sync API answer becomes: `QueryNotAllowedError` for a 403 `query_not_allowed`, a
 * `RiviumSyncError` with `status` and `serverCode` otherwise.
 */
function errorFromResponse(status: number, bodyText: string): RiviumSyncError {
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  const serverCode = typeof body?.code === 'string' ? body.code : undefined;
  const message = typeof body?.message === 'string' ? body.message : undefined;
  if (status === 403 && serverCode === 'query_not_allowed') {
    const fields = Array.isArray(body?.fields) ? (body!.fields as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    return new QueryNotAllowedError(message ?? 'This query is not allowed by the security rules.', fields);
  }
  return new RiviumSyncError(RiviumSyncErrorCode.DATA_FETCH_FAILED, `HTTP ${status}: ${bodyText}`, {
    status,
    ...(serverCode ? { serverCode } : {}),
  });
}

// ============================================================================
// Log Levels
// ============================================================================

export enum RiviumSyncLogLevel {
  NONE = 0,
  ERROR = 1,
  WARNING = 2,
  INFO = 3,
  DEBUG = 4,
  VERBOSE = 5,
}

// ============================================================================
// Types
// ============================================================================

export interface RiviumSyncAdminConfig {
  /** Your Project API Key (rv_live_xxx or rv_test_xxx) - REQUIRED */
  apiKey: string;
  /** Server secret for server-side authentication (rv_srv_xxx) - REQUIRED for all server operations */
  serverSecret: string;
  /** Optional user identifier for Security Rules (used as auth.uid when acting on behalf of a user) */
  userId?: string;
  /** Enable realtime subscriptions (default: false for server-side) */
  enableRealtime?: boolean;
  /** Log level (default: ERROR) */
  logLevel?: RiviumSyncLogLevel;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

/** Internal config with all defaults resolved */
interface RiviumSyncAdminConfigInternal {
  apiKey: string;
  serverSecret: string;
  userId?: string;
  baseUrl: string;
  /** For Rivium's own SDK tests; apps don't use this. */
  emulatorHost?: string;
  enableRealtime: boolean;
  logLevel: RiviumSyncLogLevel;
  timeout: number;
}

/** Built-in realtime endpoint: always encrypted (MQTT over TLS). */
const MQTT_HOST = 'mqtt-sync.rivium.co';
const MQTT_TLS_PORT = 8885;
const RIVIUM_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*rivium\.co$/;
/** A local Rivium Sync server's API port and realtime port (`useEmulator`). */
const DEFAULT_EMULATOR_PORT = 3006;
const DEFAULT_EMULATOR_MQTT_PORT = 1884;

/** A fresh realtime token is fetched this long before the current one expires (and at least this late). */
const TOKEN_REFRESH_EARLY_MS = 5 * 60_000;
const TOKEN_REFRESH_MIN_MS = 30_000;
const TOKEN_REFRESH_RETRY_MS = 60_000;

/** When a JWT expires (its `exp`), in ms; null when it has none or is not a JWT. */
function jwtExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Where realtime connects: the host and port POST /connections/token returns, when that answer is a valid,
 * encrypted rivium.co endpoint; anything else (missing, another domain, unencrypted) uses the built-in encrypted
 * endpoint. The connection is never plain, and the token never goes anywhere but Rivium.
 */
function resolveMqttEndpoint(answer?: { host?: unknown; port?: unknown; useTls?: unknown } | null): { host: string; port: number } {
  const host = typeof answer?.host === 'string' ? answer.host.trim().toLowerCase() : '';
  const port = answer?.port;
  if (
    answer?.useTls === true &&
    host.length > 0 && host.length <= 253 && RIVIUM_HOST.test(host) &&
    isPort(port)
  ) {
    return { host, port };
  }
  return { host: MQTT_HOST, port: MQTT_TLS_PORT };
}

interface MqttConfigInternal {
  host: string;
  wsHost?: string;
  port: number;
  wsPort: number;
  password: string;
}

export interface SyncDocument<T = Record<string, unknown>> {
  id: string;
  data: T;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
}

export type QueryOperator = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains';

export interface QueryFilter {
  field: string;
  operator: QueryOperator;
  value: unknown;
}

export interface QueryOptions {
  filters?: QueryFilter[];
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export type DocumentListener<T = Record<string, unknown>> = (doc: SyncDocument<T> | null) => void;
export type CollectionListener<T = Record<string, unknown>> = (docs: SyncDocument<T>[]) => void;
/**
 * Called when a listener cannot start or is ended by the server: a `QueryNotAllowedError`, a
 * `ListenerRevokedError`, or a `RiviumSyncError` (with `status` / `serverCode`). The listener is stopped.
 */
export type ListenerErrorCallback = (error: RiviumSyncError) => void;
export type Unsubscribe = () => void;

/** Options of `set()`: by default `set()` replaces the whole document; `{ merge: true }` merges into it. */
export interface SetOptions {
  merge?: boolean;
}

// ============================================================================
// Batch Operation Types
// ============================================================================

interface BatchOperation {
  type: 'set' | 'update' | 'delete';
  databaseId: string;
  collectionId: string;
  documentId: string;
  data?: unknown;
  /** set only: true merges into the document, false (default) replaces it. */
  merge?: boolean;
}

// ============================================================================
// SyncCollection Class
// ============================================================================

export class SyncCollection<T = Record<string, unknown>> {
  private admin: RiviumSyncAdmin;
  private databaseId: string;
  private collectionId: string;

  constructor(admin: RiviumSyncAdmin, databaseId: string, collectionId: string) {
    this.admin = admin;
    this.databaseId = databaseId;
    this.collectionId = collectionId;
  }

  /**
   * Get a document reference
   */
  doc(documentId: string): SyncDocumentRef<T> {
    return new SyncDocumentRef<T>(this.admin, this.databaseId, this.collectionId, documentId);
  }

  /**
   * Create a new document with auto-generated ID
   */
  async add(data: T): Promise<SyncDocument<T>> {
    return this.admin.addDocument<T>(this.databaseId, this.collectionId, data);
  }

  /**
   * Get a single document by ID
   */
  async get(documentId: string): Promise<SyncDocument<T> | null> {
    return this.admin.getDocument<T>(this.databaseId, this.collectionId, documentId);
  }

  /**
   * Get all documents in collection
   */
  async getAll(options?: QueryOptions): Promise<SyncDocument<T>[]> {
    return this.admin.getDocuments<T>(this.databaseId, this.collectionId, options);
  }

  /**
   * Listen to collection changes (requires enableRealtime: true).
   * The first callback is the current result; `onError` is called if the listener cannot start or is ended.
   */
  onSnapshot(callback: CollectionListener<T>, options?: QueryOptions, onError?: ListenerErrorCallback): Unsubscribe {
    return this.admin.listenCollection<T>(this.databaseId, this.collectionId, callback, options, onError);
  }

  /**
   * Start a query builder
   */
  query(): SyncQuery<T> {
    return new SyncQuery<T>(this.admin, this.databaseId, this.collectionId);
  }

  /**
   * Add a filter condition
   */
  where(field: string, operator: QueryOperator, value: unknown): SyncQuery<T> {
    return new SyncQuery<T>(this.admin, this.databaseId, this.collectionId).where(field, operator, value);
  }

  /**
   * Order results
   */
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): SyncQuery<T> {
    return new SyncQuery<T>(this.admin, this.databaseId, this.collectionId).orderBy(field, direction);
  }

  /**
   * Limit results
   */
  limit(count: number): SyncQuery<T> {
    return new SyncQuery<T>(this.admin, this.databaseId, this.collectionId).limit(count);
  }
}

// ============================================================================
// SyncDocumentRef Class
// ============================================================================

export class SyncDocumentRef<T = Record<string, unknown>> {
  private admin: RiviumSyncAdmin;
  private databaseId: string;
  private collectionId: string;
  private documentId: string;

  constructor(admin: RiviumSyncAdmin, databaseId: string, collectionId: string, documentId: string) {
    this.admin = admin;
    this.databaseId = databaseId;
    this.collectionId = collectionId;
    this.documentId = documentId;
  }

  get id(): string {
    return this.documentId;
  }

  get path(): string {
    return `/${this.databaseId}/${this.collectionId}/${this.documentId}`;
  }

  /**
   * Get document data
   */
  async get(): Promise<SyncDocument<T> | null> {
    return this.admin.getDocument<T>(this.databaseId, this.collectionId, this.documentId);
  }

  /**
   * Check if document exists
   */
  async exists(): Promise<boolean> {
    const doc = await this.get();
    return doc !== null;
  }

  /**
   * Set document data. Replaces the whole document (creates it when it does not exist);
   * with `{ merge: true }` the given fields are merged into the existing document.
   */
  async set(data: T): Promise<void>;
  async set(data: Partial<T>, options: SetOptions): Promise<void>;
  async set(data: T | Partial<T>, options?: SetOptions): Promise<void> {
    await this.admin.setDocument<T>(this.databaseId, this.collectionId, this.documentId, data as T, options);
  }

  /**
   * Update document data (merge)
   */
  async update(data: Partial<T>): Promise<void> {
    await this.admin.updateDocument<T>(this.databaseId, this.collectionId, this.documentId, data);
  }

  /**
   * Delete document
   */
  async delete(): Promise<void> {
    await this.admin.deleteDocument(this.databaseId, this.collectionId, this.documentId);
  }

  /**
   * Listen to document changes (requires enableRealtime: true).
   * The first callback is the current document (`null` when it does not exist); `onError` is called if the
   * listener cannot start or is ended.
   */
  onSnapshot(callback: DocumentListener<T>, onError?: ListenerErrorCallback): Unsubscribe {
    return this.admin.listenDocument<T>(this.databaseId, this.collectionId, this.documentId, callback, onError);
  }
}

// ============================================================================
// SyncQuery Class
// ============================================================================

export class SyncQuery<T = Record<string, unknown>> {
  private admin: RiviumSyncAdmin;
  private databaseId: string;
  private collectionId: string;
  private options: QueryOptions = {};

  constructor(admin: RiviumSyncAdmin, databaseId: string, collectionId: string) {
    this.admin = admin;
    this.databaseId = databaseId;
    this.collectionId = collectionId;
  }

  /**
   * Add a filter condition
   */
  where(field: string, operator: QueryOperator, value: unknown): SyncQuery<T> {
    if (!this.options.filters) {
      this.options.filters = [];
    }
    this.options.filters.push({ field, operator, value });
    return this;
  }

  /**
   * Order results
   */
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): SyncQuery<T> {
    this.options.orderBy = field;
    this.options.orderDirection = direction;
    return this;
  }

  /**
   * Limit results
   */
  limit(count: number): SyncQuery<T> {
    this.options.limit = count;
    return this;
  }

  /**
   * Skip results (for pagination)
   */
  offset(count: number): SyncQuery<T> {
    this.options.offset = count;
    return this;
  }

  /**
   * Alias for offset - skip first N results
   */
  startAfter(count: number): SyncQuery<T> {
    return this.offset(count);
  }

  /**
   * Execute query and get results
   */
  async get(): Promise<SyncDocument<T>[]> {
    return this.admin.getDocuments<T>(this.databaseId, this.collectionId, this.options);
  }

  /**
   * Get first result only
   */
  async getFirst(): Promise<SyncDocument<T> | null> {
    const originalLimit = this.options.limit;
    this.options.limit = 1;
    const results = await this.get();
    this.options.limit = originalLimit;
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Count matching documents
   */
  async count(): Promise<number> {
    const results = await this.get();
    return results.length;
  }

  /**
   * Listen to query results (requires enableRealtime: true).
   * The first callback is the current result; `onError` is called if the listener cannot start or is ended
   * (for example a `QueryNotAllowedError`).
   */
  onSnapshot(callback: CollectionListener<T>, onError?: ListenerErrorCallback): Unsubscribe {
    return this.admin.listenCollection<T>(this.databaseId, this.collectionId, callback, { ...this.options }, onError);
  }
}

// ============================================================================
// SyncDatabase Class
// ============================================================================

export class SyncDatabase {
  private admin: RiviumSyncAdmin;
  private databaseId: string;

  constructor(admin: RiviumSyncAdmin, databaseId: string) {
    this.admin = admin;
    this.databaseId = databaseId;
  }

  /**
   * The database name this reference was created with (as passed to
   * `riviumSync.database(name)`).
   */
  get id(): string {
    return this.databaseId;
  }

  /**
   * Get a collection reference.
   *
   * @param collectionName The collection NAME as shown in Rivium Console
   *   (e.g. `'todos'`), not its UUID. Realtime updates are published by name,
   *   so `onSnapshot` listeners only receive changes when you pass the name.
   */
  collection<T = Record<string, unknown>>(collectionName: string): SyncCollection<T> {
    return new SyncCollection<T>(this.admin, this.databaseId, collectionName);
  }
}

// ============================================================================
// WriteBatch Class
// ============================================================================

export class WriteBatch {
  private admin: RiviumSyncAdmin;
  private operations: BatchOperation[] = [];

  constructor(admin: RiviumSyncAdmin) {
    this.admin = admin;
  }

  /**
   * Add a set operation to the batch. Replaces the whole document; with `{ merge: true }` merges into it.
   */
  set<T>(docRef: SyncDocumentRef<T>, data: T): WriteBatch;
  set<T>(docRef: SyncDocumentRef<T>, data: Partial<T>, options: SetOptions): WriteBatch;
  set<T>(docRef: SyncDocumentRef<T>, data: T | Partial<T>, options?: SetOptions): WriteBatch {
    this.operations.push({
      type: 'set',
      databaseId: (docRef as unknown as { databaseId: string }).databaseId,
      collectionId: (docRef as unknown as { collectionId: string }).collectionId,
      documentId: docRef.id,
      data,
      merge: options?.merge === true,
    });
    return this;
  }

  /**
   * Add an update operation to the batch
   */
  update<T>(docRef: SyncDocumentRef<T>, data: Partial<T>): WriteBatch {
    this.operations.push({
      type: 'update',
      databaseId: (docRef as unknown as { databaseId: string }).databaseId,
      collectionId: (docRef as unknown as { collectionId: string }).collectionId,
      documentId: docRef.id,
      data,
    });
    return this;
  }

  /**
   * Add a delete operation to the batch
   */
  delete<T>(docRef: SyncDocumentRef<T>): WriteBatch {
    this.operations.push({
      type: 'delete',
      databaseId: (docRef as unknown as { databaseId: string }).databaseId,
      collectionId: (docRef as unknown as { collectionId: string }).collectionId,
      documentId: docRef.id,
    });
    return this;
  }

  /**
   * Commit all operations in the batch
   */
  async commit(): Promise<void> {
    await this.admin.executeBatch(this.operations);
    this.operations = [];
  }

  /**
   * Get the number of pending operations
   */
  get size(): number {
    return this.operations.length;
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Start a listener again about this long before it expires. */
const RELISTEN_BEFORE_EXPIRY_MS = 60 * 60 * 1000;
const LISTEN_RETRY_MIN_MS = 1000;
const LISTEN_RETRY_MAX_MS = 60 * 1000;
/** setTimeout's largest delay. */
const MAX_TIMER_MS = 2_147_483_647;

/** A listener: what it listens to, where it is in its life, and the documents it keeps. */
interface ListenerEntry {
  kind: 'document' | 'query';
  databaseId: string;
  collectionId: string;
  documentId?: string;
  options?: QueryOptions;
  onDoc?: DocumentListener<unknown>;
  onDocs?: CollectionListener<unknown>;
  onError?: ListenerErrorCallback;
  /** pending: waits for the connection; server: server-routed; legacy: older backend's topics; stopped. */
  mode: 'pending' | 'server' | 'legacy' | 'stopped';
  starting: boolean;
  subscriptionId?: string;
  topic?: string;
  docs: Map<string, KeptDocument>;
  /** What the app was last given (undefined: nothing yet, the first result is always delivered). */
  lastSignature?: string;
  relistenTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  retryDelay: number;
}

interface ListenAnswer {
  subscriptionId: string;
  topic: string;
  expiresAt: string;
  document: KeptDocument | null;
  documents: KeptDocument[];
}

function parseListenAnswer(raw: unknown): ListenAnswer {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof r.subscriptionId !== 'string' || !r.subscriptionId || typeof r.topic !== 'string' || !r.topic) {
    throw new RiviumSyncError(RiviumSyncErrorCode.SUBSCRIPTION_FAILED, 'Unexpected listen answer');
  }
  return {
    subscriptionId: r.subscriptionId,
    topic: r.topic,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : '',
    document: toKeptDocument(r.document),
    documents: Array.isArray(r.documents)
      ? r.documents.map((d) => toKeptDocument(d)).filter((d): d is KeptDocument => d !== null)
      : [],
  };
}

function toSyncDocument(doc: KeptDocument): SyncDocument<unknown> {
  return {
    id: doc.id,
    data: doc.data,
    ...(doc.createdAt !== undefined ? { createdAt: doc.createdAt } : {}),
    ...(doc.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}),
    ...(doc.version !== undefined ? { version: doc.version } : {}),
  };
}

function toSyncError(error: unknown): RiviumSyncError {
  if (error instanceof RiviumSyncError) return error;
  return new RiviumSyncError(RiviumSyncErrorCode.UNKNOWN_ERROR, (error as Error)?.message);
}

function unrefTimer<T>(timer: T): T {
  (timer as { unref?: () => void })?.unref?.();
  return timer;
}

/** The Sync API answers `{ data: document }`; a bare document is accepted too. */
function unwrapDocument<T>(response: unknown): SyncDocument<T> | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  if (!('id' in r) && r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    return r.data as SyncDocument<T>;
  }
  return r as unknown as SyncDocument<T>;
}

/** The Sync API answers `{ data: [...], total }`; `{ documents: [...] }` and a bare array are accepted too. */
function unwrapDocuments<T>(response: unknown): SyncDocument<T>[] {
  if (Array.isArray(response)) return response as SyncDocument<T>[];
  const r = (response && typeof response === 'object' ? response : {}) as Record<string, unknown>;
  if (Array.isArray(r.data)) return r.data as SyncDocument<T>[];
  if (Array.isArray(r.documents)) return r.documents as SyncDocument<T>[];
  return [];
}

/** POST …/documents/sdk/query body: `{ filters: [{ field, operator, value }], orderBy: { field, direction }, limit, offset }`. */
function queryBody(options?: QueryOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (options?.filters?.length) {
    // Values keep their JSON type (numbers and booleans are never turned into strings).
    body.filters = options.filters.map((f) => ({ field: f.field, operator: f.operator, value: f.value }));
  }
  if (options?.orderBy) {
    body.orderBy = { field: options.orderBy, direction: options.orderDirection === 'desc' ? 'desc' : 'asc' };
  }
  if (options?.limit && options.limit > 0) body.limit = options.limit;
  if (options?.offset && options.offset > 0) body.offset = options.offset;
  return body;
}

// ============================================================================
// RiviumSyncAdmin Main Class
// ============================================================================

/**
 * RiviumSync Admin SDK for Node.js
 *
 * @example
 * ```typescript
 * import { RiviumSyncAdmin } from '@rivium/sync-node';
 *
 * const riviumSync = new RiviumSyncAdmin({
 *   apiKey: process.env.RIVIUM_SYNC_API_KEY,
 *   serverSecret: process.env.RIVIUM_SYNC_SERVER_SECRET, // Required for server-side operations
 * });
 *
 * // Get a database reference by its NAME as shown in Rivium Console
 * const db = riviumSync.database('my-app');
 *
 * // CRUD operations
 * const users = db.collection('users');
 *
 * // Create
 * const newUser = await users.add({ name: 'John', email: 'john@example.com' });
 *
 * // Read
 * const user = await users.get('user-id');
 *
 * // Query
 * const adults = await users.where('age', '>=', 18).orderBy('name').get();
 *
 * // Update
 * await users.doc('user-id').update({ age: 31 });
 *
 * // Delete
 * await users.doc('user-id').delete();
 *
 * // Batch operations
 * const batch = riviumSync.batch();
 * batch.set(users.doc('user1'), { name: 'User 1' });
 * batch.update(users.doc('user2'), { status: 'active' });
 * batch.delete(users.doc('user3'));
 * await batch.commit();
 * ```
 */
export class RiviumSyncAdmin {
  private static readonly DEFAULT_BASE_URL = 'https://sync.rivium.co';

  private config: RiviumSyncAdminConfigInternal;
  private mqttClient: MqttClient | null = null;
  private mqttConfig: MqttConfigInternal | null = null;
  private logLevel: RiviumSyncLogLevel;
  private timeout: number;
  /** A request was made: `useEmulator` is too late from then on. */
  private requestsStarted = false;

  // Realtime listeners
  /** The MQTT client id of this instance: listeners are made for it (POST …/listen `clientId`). */
  private readonly mqttClientId = `rivium_sync_node_${randomUUID()}`;
  private listeners: Set<ListenerEntry> = new Set();
  /** Topic → the listeners that receive it (one per private topic; several may share an older per-collection topic). */
  private topicListeners: Map<string, Set<ListenerEntry>> = new Map();

  constructor(config: RiviumSyncAdminConfig) {
    if (!config.apiKey) {
      throw new RiviumSyncError(RiviumSyncErrorCode.MISSING_API_KEY);
    }
    if (!config.serverSecret) {
      throw new RiviumSyncError(RiviumSyncErrorCode.MISSING_SERVER_SECRET);
    }

    this.config = {
      ...config,
      baseUrl: RiviumSyncAdmin.DEFAULT_BASE_URL,
      enableRealtime: config.enableRealtime ?? false,
      logLevel: config.logLevel ?? RiviumSyncLogLevel.ERROR,
      timeout: config.timeout ?? 30000,
    };

    this.logLevel = this.config.logLevel;
    this.timeout = this.config.timeout;

    this.log(RiviumSyncLogLevel.INFO, 'RiviumSyncAdmin SDK initialized');

    // Initialize realtime if enabled (right after this call, so `useEmulator` can still change where it connects)
    if (this.config.enableRealtime) {
      queueMicrotask(() => void this.initRealtime());
    }
  }

  /** For Rivium's own SDK tests; apps don't use this. */
  useEmulator(host: string, port: number = DEFAULT_EMULATOR_PORT): void {
    const name = typeof host === 'string' ? host.trim() : '';
    if (!name || /[\s/:]/.test(name)) {
      throw new RiviumSyncError(RiviumSyncErrorCode.INVALID_CONFIG, 'host is a host name or IP address, without scheme or port');
    }
    if (!isPort(port)) {
      throw new RiviumSyncError(RiviumSyncErrorCode.INVALID_CONFIG, 'port must be 1-65535');
    }
    if (this.requestsStarted) {
      throw new RiviumSyncError(RiviumSyncErrorCode.INVALID_CONFIG, 'useEmulator must be called before any other call');
    }
    this.config.baseUrl = `http://${name}:${port}`;
    this.config.emulatorHost = name;
    this.log(RiviumSyncLogLevel.WARNING, `Using a local Rivium Sync server at ${this.config.baseUrl} (unencrypted)`);
  }

  // ==========================================================================
  // Logging
  // ==========================================================================

  private log(level: RiviumSyncLogLevel, message: string, ...args: unknown[]): void {
    if (level > this.logLevel) return;

    const prefix = '[RiviumSync]';
    switch (level) {
      case RiviumSyncLogLevel.ERROR:
        console.error(prefix, message, ...args);
        break;
      case RiviumSyncLogLevel.WARNING:
        console.warn(prefix, message, ...args);
        break;
      case RiviumSyncLogLevel.INFO:
        console.info(prefix, message, ...args);
        break;
      default:
        console.log(prefix, message, ...args);
    }
  }

  setLogLevel(level: RiviumSyncLogLevel): void {
    this.logLevel = level;
  }

  // ==========================================================================
  // HTTP Client
  // ==========================================================================

  /**
   * Mint a user token so your app can prove who the acting user is.
   *
   * Security Rules read `auth.uid`. A client cannot set that itself - the API
   * key it ships with is public, so the server would have no reason to believe
   * it. Your backend, which holds the server secret, calls this and hands the
   * token to the app; the client SDKs take it through their `tokenProvider`
   * option and send it on every request.
   *
   * Never ship the server secret (or this call) inside an app.
   *
   * @param userId  Your own id for the signed-in user - whatever your rules expect.
   * @param expiresIn Lifetime in seconds. Default 1 hour, maximum 24 hours.
   *
   * @example
   * // In your Express backend, behind your own session check:
   * app.post('/rivium-sync-token', async (req, res) => {
   *   const { token, expiresIn } = await sync.createUserToken(req.session.userId);
   *   res.json({ token, expiresIn });
   * });
   */
  async createUserToken(
    userId: string,
    expiresIn?: number,
  ): Promise<{ token: string; userId: string; expiresIn: number }> {
    if (!userId) {
      throw new RiviumSyncError(
        RiviumSyncErrorCode.INVALID_CONFIG,
        'createUserToken requires a userId',
      );
    }

    return this.request<{ token: string; userId: string; expiresIn: number }>(
      'POST',
      '/users/token',
      expiresIn === undefined ? { userId } : { userId, expiresIn },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    this.requestsStarted = true;
    const url = `${this.config.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'x-server-secret': this.config.serverSecret,
      'X-Rivium-SDK': SDK_HEADER_VALUE,
    };

    if (this.config.userId) {
      headers['X-User-Id'] = this.config.userId;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw errorFromResponse(response.status, errorText);
      }

      // Handle empty responses
      const text = await response.text();
      if (!text) {
        return {} as T;
      }

      return JSON.parse(text);
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof RiviumSyncError) {
        throw error;
      }

      if ((error as Error).name === 'AbortError') {
        throw new RiviumSyncError(RiviumSyncErrorCode.CONNECTION_TIMEOUT);
      }

      throw new RiviumSyncError(
        RiviumSyncErrorCode.DATA_FETCH_FAILED,
        (error as Error).message,
      );
    }
  }

  // ==========================================================================
  // Public API - Database Access
  // ==========================================================================

  /**
   * Get a database reference.
   *
   * @param databaseName The database NAME as shown in Rivium Console
   *   (e.g. `'my-app'`), not its UUID. Realtime updates are published by name,
   *   so `onSnapshot` listeners only receive changes when you pass the name.
   *
   * @example
   * ```typescript
   * const todos = riviumSync.database('my-app').collection('todos');
   * ```
   */
  database(databaseName: string): SyncDatabase {
    return new SyncDatabase(this, databaseName);
  }

  /**
   * Create a new write batch
   */
  batch(): WriteBatch {
    return new WriteBatch(this);
  }

  // ==========================================================================
  // Document Operations (Internal)
  // ==========================================================================

  async getDocument<T>(
    databaseId: string,
    collectionId: string,
    documentId: string,
  ): Promise<SyncDocument<T> | null> {
    try {
      const response = await this.request<unknown>(
        'GET',
        `/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`,
      );
      return unwrapDocument<T>(response);
    } catch (error) {
      // Only the server's 404 means "no such document" (a refusal whose text mentions 404 is still a refusal).
      if ((error as RiviumSyncError).status === 404) {
        return null;
      }
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to get document:', error);
      throw error;
    }
  }

  async getDocuments<T>(
    databaseId: string,
    collectionId: string,
    options?: QueryOptions,
  ): Promise<SyncDocument<T>[]> {
    try {
      // Filters, order and paging go in the body of POST …/documents/sdk/query, where the server applies them
      // (the security rules check the query as asked).
      const response = await this.request<unknown>(
        'POST',
        `/databases/${databaseId}/collections/${collectionId}/documents/sdk/query`,
        queryBody(options),
      );
      return unwrapDocuments<T>(response);
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to get documents:', error);
      throw error;
    }
  }

  async addDocument<T>(
    databaseId: string,
    collectionId: string,
    data: T,
  ): Promise<SyncDocument<T>> {
    try {
      const response = await this.request<unknown>(
        'POST',
        `/databases/${databaseId}/collections/${collectionId}/documents/sdk`,
        { data },
      );
      return unwrapDocument<T>(response) as SyncDocument<T>;
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to add document:', error);
      throw error;
    }
  }

  async setDocument<T>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    data: T,
    options?: SetOptions,
  ): Promise<void> {
    try {
      // merge: false replaces the document, true merges into it (always sent: the server's default differs).
      await this.request<void>(
        'PUT',
        `/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`,
        { data, merge: options?.merge === true },
      );
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to set document:', error);
      throw error;
    }
  }

  async updateDocument<T>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    data: Partial<T>,
  ): Promise<void> {
    try {
      await this.request<void>(
        'PATCH',
        `/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`,
        { data },
      );
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to update document:', error);
      throw error;
    }
  }

  async deleteDocument(
    databaseId: string,
    collectionId: string,
    documentId: string,
  ): Promise<void> {
    try {
      await this.request<void>(
        'DELETE',
        `/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`,
      );
    } catch (error) {
      // Already gone on the server: deleted, as in Firestore.
      if ((error as RiviumSyncError).status === 404) return;
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to delete document:', error);
      throw error;
    }
  }

  // ==========================================================================
  // Batch Operations
  // ==========================================================================

  /**
   * POST /batch/sdk: every operation in one transaction on the server. When one is refused (security rules,
   * invalid, not found) nothing is written and the error is thrown.
   */
  async executeBatch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;
    const body = operations.map((op) => ({
      type: op.type,
      databaseId: op.databaseId,
      collectionId: op.collectionId,
      documentId: op.documentId,
      ...(op.type === 'delete' ? {} : { data: op.data }),
      // set: false replaces the document, true merges into it (always sent).
      ...(op.type === 'set' ? { merge: op.merge === true } : {}),
    }));
    try {
      await this.request<void>('POST', '/batch/sdk', { operations: body });
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Batch write failed:', error);
      throw error;
    }
  }

  // ==========================================================================
  // Realtime (Optional)
  // ==========================================================================

  /** Project the API key belongs to, from POST /connections/token. */
  private projectId: string | null = null;
  /** POST /connections/token was refused for good: every listener gets this error. */
  private realtimeError: RiviumSyncError | null = null;
  private realtimeRetryTimer?: ReturnType<typeof setTimeout>;
  private realtimeRetryDelay = LISTEN_RETRY_MIN_MS;
  private disconnected = false;
  /** Fetches a fresh realtime token before this one expires, for the client's next reconnect. */
  private tokenRefreshTimer?: ReturnType<typeof setTimeout>;

  /**
   * Topic of older backends for a collection or a single document.
   * `rivium_sync/{projectId}/{databaseName}/{collectionName}[/{documentId}]`
   */
  private topicFor(databaseId: string, collectionId: string, documentId?: string): string {
    const base = `rivium_sync/${this.projectId ?? 'unknown'}/${databaseId}/${collectionId}`;
    return documentId === undefined ? base : `${base}/${documentId}`;
  }

  private async initRealtime(): Promise<void> {
    if (this.disconnected) return;
    try {
      this.log(RiviumSyncLogLevel.DEBUG, 'Fetching MQTT token...');

      const tokenData = await this.request<{
        token: string;
        projectId?: string;
        mqtt?: { host?: string; port?: number; useTls?: boolean };
      }>('POST', '/connections/token');

      // Topics are `rivium_sync/{projectId}/...` under the project id the server returns.
      this.projectId = tokenData.projectId ?? null;

      // A local server (useEmulator): its host, the realtime port it reports, no TLS.
      const endpoint = this.config.emulatorHost
        ? { host: this.config.emulatorHost, port: isPort(tokenData.mqtt?.port) ? tokenData.mqtt!.port! : DEFAULT_EMULATOR_MQTT_PORT }
        : resolveMqttEndpoint(tokenData.mqtt);
      this.mqttConfig = {
        host: endpoint.host,
        port: endpoint.port,
        wsHost: endpoint.host,
        wsPort: endpoint.port,
        password: tokenData.token,
      };
      this.scheduleTokenRefresh(tokenData.token);

      if (this.disconnected) return;
      this.connectMqtt();
    } catch (error) {
      this.onRealtimeTokenFailed(toSyncError(error));
    }
  }

  /**
   * POST /connections/token failed. Network trouble or a server error: try again later. Refused (wrong key or
   * secret, the project needs a signed user token, …): realtime cannot start, so every listener is stopped with the
   * error instead of waiting for a connection that never comes.
   */
  private onRealtimeTokenFailed(error: RiviumSyncError): void {
    if (this.disconnected) return;
    // As for listeners, 401 is final here: the server secret does not change by waiting.
    if (error.status !== 401 && isTransientError(error)) {
      this.log(RiviumSyncLogLevel.WARNING, 'Realtime could not start, retrying:', error.details ?? error.message);
      const delay = this.realtimeRetryDelay;
      this.realtimeRetryDelay = Math.min(this.realtimeRetryDelay * 2, LISTEN_RETRY_MAX_MS);
      this.realtimeRetryTimer = unrefTimer(
        setTimeout(() => {
          this.realtimeRetryTimer = undefined;
          void this.initRealtime();
        }, delay),
      );
      return;
    }
    this.log(RiviumSyncLogLevel.ERROR, 'Realtime refused by the server:', error);
    this.realtimeError = error;
    for (const entry of [...this.listeners]) {
      if (entry.mode === 'pending') this.failListener(entry, error);
    }
  }

  /**
   * The broker checks the realtime token only when the client logs in, and mqtt.js logs in again with the same
   * password after every drop: once the token expired (24 h by default) every reconnect was refused, for good. A
   * fresh token is fetched shortly before expiry (and at once when a login is refused) and becomes the password of
   * the next reconnect; the open connection is not touched.
   */
  private scheduleTokenRefresh(token: string): void {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    const expiresAt = jwtExpiryMs(token);
    if (expiresAt === null) return;
    const delay = Math.max(expiresAt - Date.now() - TOKEN_REFRESH_EARLY_MS, TOKEN_REFRESH_MIN_MS);
    this.tokenRefreshTimer = unrefTimer(setTimeout(() => void this.refreshRealtimeToken(), delay));
  }

  private async refreshRealtimeToken(): Promise<void> {
    if (this.disconnected) return;
    try {
      const { token } = await this.request<{ token: string }>('POST', '/connections/token');
      if (this.disconnected || !this.mqttConfig) return;
      this.mqttConfig.password = token;
      if (this.mqttClient) this.mqttClient.options.password = token;
      this.log(RiviumSyncLogLevel.DEBUG, 'Realtime token refreshed');
      this.scheduleTokenRefresh(token);
    } catch (error) {
      if (this.disconnected) return;
      this.log(RiviumSyncLogLevel.WARNING, 'Could not refresh the realtime token, retrying:', toSyncError(error).message);
      if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = unrefTimer(setTimeout(() => void this.refreshRealtimeToken(), TOKEN_REFRESH_RETRY_MS));
    }
  }

  private connectMqtt(): void {
    if (!this.mqttConfig) {
      return;
    }

    // Always encrypted, except a local server (useEmulator).
    const scheme = this.config.emulatorHost ? 'mqtt' : 'mqtts';
    const url = `${scheme}://${this.mqttConfig.host}:${this.mqttConfig.port}`;

    const options: IClientOptions = {
      clientId: this.mqttClientId,
      clean: false,
      connectTimeout: 10000,
      username: 'jwt',
      password: this.mqttConfig.password,
    };

    this.log(RiviumSyncLogLevel.DEBUG, 'Connecting to MQTT:', url);

    this.mqttClient = mqtt.connect(url, options);

    this.mqttClient.on('connect', () => {
      this.log(RiviumSyncLogLevel.INFO, 'MQTT connected');
      this.onMqttConnected();
    });

    this.mqttClient.on('message', (topic: string, payload: Buffer) => {
      let data: unknown;
      try {
        data = JSON.parse(payload.toString());
      } catch (error) {
        this.log(RiviumSyncLogLevel.ERROR, 'MQTT message parse error:', error);
        return;
      }
      this.handleMqttMessage(topic, data);
    });

    this.mqttClient.on('error', (error: Error) => {
      this.log(RiviumSyncLogLevel.ERROR, 'MQTT error:', error);
      // The broker refused the login (bad user name or password / not authorized, MQTT 3 and 5): the token
      // expired while the timer could not run (a sleeping machine). Fetch one now for the next reconnect.
      if ([4, 5, 134, 135].includes(Number((error as { code?: unknown }).code))) void this.refreshRealtimeToken();
    });

    this.mqttClient.on('close', () => {
      this.log(RiviumSyncLogLevel.INFO, 'MQTT disconnected');
    });
  }

  listenDocument<T>(
    databaseId: string,
    collectionId: string,
    documentId: string,
    callback: DocumentListener<T>,
    onError?: ListenerErrorCallback,
  ): Unsubscribe {
    if (!this.config.enableRealtime) {
      this.log(RiviumSyncLogLevel.WARNING, 'Realtime not enabled. Set enableRealtime: true in config.');
      // Still fetch initial data
      this.getDocument<T>(databaseId, collectionId, documentId).then(
        (doc) => callback(doc),
        (error) => this.reportListenerError(onError, toSyncError(error)),
      );
      return () => {};
    }

    const entry: ListenerEntry = {
      kind: 'document',
      databaseId,
      collectionId,
      documentId,
      onDoc: callback as DocumentListener<unknown>,
      onError,
      mode: 'pending',
      starting: false,
      docs: new Map(),
      retryDelay: LISTEN_RETRY_MIN_MS,
    };
    return this.addListener(entry);
  }

  listenCollection<T>(
    databaseId: string,
    collectionId: string,
    callback: CollectionListener<T>,
    options?: QueryOptions,
    onError?: ListenerErrorCallback,
  ): Unsubscribe {
    if (!this.config.enableRealtime) {
      this.log(RiviumSyncLogLevel.WARNING, 'Realtime not enabled. Set enableRealtime: true in config.');
      // Still fetch initial data
      this.getDocuments<T>(databaseId, collectionId, options).then(
        (docs) => callback(docs),
        (error) => this.reportListenerError(onError, toSyncError(error)),
      );
      return () => {};
    }

    const entry: ListenerEntry = {
      kind: 'query',
      databaseId,
      collectionId,
      options: options ? { ...options, filters: options.filters ? [...options.filters] : undefined } : undefined,
      onDocs: callback as CollectionListener<unknown>,
      onError,
      mode: 'pending',
      starting: false,
      docs: new Map(),
      retryDelay: LISTEN_RETRY_MIN_MS,
    };
    return this.addListener(entry);
  }

  /** Registers a listener; it starts now when connected, else when the connection comes up. */
  private addListener(entry: ListenerEntry): Unsubscribe {
    this.listeners.add(entry);
    this.startListener(entry);
    return () => this.stopListener(entry);
  }

  private onMqttConnected(): void {
    // A reconnect may come with a clean session: subscribe every listener's topic again.
    for (const topic of this.topicListeners.keys()) {
      this.mqttClient?.subscribe(topic, { qos: 1 });
    }
    // Listeners started while offline start now.
    for (const entry of this.listeners) {
      if (entry.mode === 'pending') this.startListener(entry);
    }
  }

  private startListener(entry: ListenerEntry): void {
    if (entry.mode !== 'pending' || entry.starting) return;
    const refused = this.realtimeError;
    if (refused) {
      // Realtime was refused: report it (after onSnapshot has returned).
      queueMicrotask(() => this.failListener(entry, refused));
      return;
    }
    if (!this.mqttClient?.connected) return; // started by onMqttConnected
    void this.listenOnServer(entry);
  }

  /** POST …/listen body for a listener. */
  private listenBody(entry: ListenerEntry): Record<string, unknown> {
    const body: Record<string, unknown> = { clientId: this.mqttClientId };
    if (entry.kind === 'document') {
      body.documentId = entry.documentId;
      return body;
    }
    const o = entry.options ?? {};
    if (o.filters?.length) body.filters = o.filters.map((f) => ({ field: f.field, operator: f.operator, value: f.value }));
    if (o.orderBy) body.orderBy = { field: o.orderBy, direction: o.orderDirection === 'desc' ? 'desc' : 'asc' };
    if (o.limit && o.limit > 0) {
      // Listeners have no offset on the server: ask for offset + limit and skip the first `offset` here.
      body.limit = o.limit + (o.offset && o.offset > 0 ? o.offset : 0);
    }
    return body;
  }

  /**
   * Starts a listener on the server (or starts it again: before it expires, or after the server ended it as
   * expired). The new subscription replaces the old one, which is then stopped.
   */
  private async listenOnServer(entry: ListenerEntry): Promise<void> {
    if (entry.mode === 'stopped' || entry.starting) return;
    entry.starting = true;
    this.clearTimer(entry, 'retryTimer');
    let answer: ListenAnswer;
    try {
      const raw = await this.request<unknown>(
        'POST',
        `/databases/${entry.databaseId}/collections/${entry.collectionId}/listen`,
        this.listenBody(entry),
      );
      answer = parseListenAnswer(raw);
    } catch (error) {
      entry.starting = false;
      this.onListenFailed(entry, toSyncError(error));
      return;
    }
    entry.starting = false;

    if ((entry.mode as ListenerEntry['mode']) === 'stopped') {
      // Stopped while the answer was on its way.
      this.deleteSubscription(entry.databaseId, answer.subscriptionId);
      return;
    }

    const previous = entry.mode === 'server' && entry.subscriptionId && entry.topic
      ? { subscriptionId: entry.subscriptionId, topic: entry.topic }
      : null;

    entry.mode = 'server';
    entry.subscriptionId = answer.subscriptionId;
    entry.topic = answer.topic;
    entry.retryDelay = LISTEN_RETRY_MIN_MS;
    this.addTopic(answer.topic, entry);

    // The answer's result is the listener's first callback (and, when started again, its new baseline).
    if (entry.kind === 'document') {
      entry.docs = answer.document ? new Map([[answer.document.id, answer.document]]) : new Map();
    } else {
      entry.docs = previous ? replaceWithSnapshot(entry.docs, answer.documents) : new Map(answer.documents.map((d) => [d.id, d]));
    }
    this.deliver(entry);
    this.scheduleRelisten(entry, answer.expiresAt);

    if (previous && previous.subscriptionId !== answer.subscriptionId) {
      this.removeTopic(previous.topic, entry);
      this.deleteSubscription(entry.databaseId, previous.subscriptionId);
    }
  }

  private onListenFailed(entry: ListenerEntry, error: RiviumSyncError): void {
    if (entry.mode === 'stopped') return;
    const status = error.status;

    if (status === 404) {
      // A backend without server-routed listeners: listen on its per-collection / per-document topics.
      this.log(RiviumSyncLogLevel.DEBUG, 'Server-routed listeners not available; using collection topics');
      this.startLegacy(entry);
      return;
    }

    // 401 is transient for apps (a user token on its way) but not here: the server secret does not change by
    // waiting, so a wrong key or secret is reported.
    if (status === 401 || !isTransientError(error)) {
      // Refused (403 query_not_allowed / permission denied / too_many_listeners, 400 …): never retried.
      this.failListener(entry, error);
      return;
    }

    // Network trouble or a server error: try again later. A running listener keeps its current subscription.
    this.log(RiviumSyncLogLevel.WARNING, 'Listener could not start, retrying:', error.details ?? error.message);
    const delay = entry.retryDelay;
    entry.retryDelay = Math.min(entry.retryDelay * 2, LISTEN_RETRY_MAX_MS);
    entry.retryTimer = unrefTimer(
      setTimeout(() => {
        entry.retryTimer = undefined;
        if (entry.mode === 'stopped') return;
        if (entry.mode === 'pending') this.startListener(entry);
        else void this.listenOnServer(entry);
      }, delay),
    );
  }

  private scheduleRelisten(entry: ListenerEntry, expiresAt: string): void {
    this.clearTimer(entry, 'relistenTimer');
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires)) return;
    const left = expires - Date.now();
    // About an hour before it expires (half the time left when that is less than two hours).
    const delay = left > 2 * RELISTEN_BEFORE_EXPIRY_MS ? left - RELISTEN_BEFORE_EXPIRY_MS : Math.max(left / 2, 1000);
    entry.relistenTimer = unrefTimer(
      setTimeout(() => {
        entry.relistenTimer = undefined;
        if (entry.mode === 'server') void this.listenOnServer(entry);
      }, Math.min(delay, MAX_TIMER_MS)),
    );
  }

  /** Fallback for older backends: the per-collection (`…/changes`) or per-document topic, unchanged. */
  private startLegacy(entry: ListenerEntry): void {
    this.clearTimer(entry, 'relistenTimer');
    if (entry.topic) this.removeTopic(entry.topic, entry);
    entry.mode = 'legacy';
    entry.subscriptionId = undefined;
    entry.topic = entry.kind === 'document'
      ? this.topicFor(entry.databaseId, entry.collectionId, entry.documentId)
      : this.topicFor(entry.databaseId, entry.collectionId, 'changes');
    this.addTopic(entry.topic, entry);

    if (entry.kind === 'document') {
      this.getDocument<unknown>(entry.databaseId, entry.collectionId, entry.documentId!).then(
        (doc) => {
          if (entry.mode !== 'legacy') return;
          const kept = toKeptDocument(doc);
          entry.docs = kept ? new Map([[kept.id, kept]]) : new Map();
          this.deliver(entry);
        },
        (error) => this.failListener(entry, toSyncError(error)),
      );
    } else {
      this.getDocuments<unknown>(entry.databaseId, entry.collectionId, entry.options).then(
        (docs) => {
          if (entry.mode !== 'legacy') return;
          entry.docs = new Map(
            docs.map((d) => toKeptDocument(d)).filter((d): d is KeptDocument => d !== null).map((d) => [d.id, d]),
          );
          this.deliver(entry);
        },
        (error) => this.failListener(entry, toSyncError(error)),
      );
    }
  }

  private stopListener(entry: ListenerEntry): void {
    if (entry.mode === 'stopped') return;
    const subscriptionId = entry.mode === 'server' ? entry.subscriptionId : undefined;
    entry.mode = 'stopped';
    this.clearTimer(entry, 'relistenTimer');
    this.clearTimer(entry, 'retryTimer');
    this.listeners.delete(entry);
    if (entry.topic) this.removeTopic(entry.topic, entry);
    if (subscriptionId) this.deleteSubscription(entry.databaseId, subscriptionId);
  }

  /** Stops a listener and reports why to its error callback. */
  private failListener(entry: ListenerEntry, error: RiviumSyncError): void {
    if (entry.mode === 'stopped') return;
    this.stopListener(entry);
    this.reportListenerError(entry.onError, error);
  }

  private reportListenerError(onError: ListenerErrorCallback | undefined, error: RiviumSyncError): void {
    if (!onError) {
      this.log(RiviumSyncLogLevel.ERROR, 'Listener error:', error);
      return;
    }
    try {
      onError(error);
    } catch (callbackError) {
      this.log(RiviumSyncLogLevel.ERROR, 'Listener error callback threw:', callbackError);
    }
  }

  /** DELETE …/listen/{id}: best effort, a failure is not reported. */
  private deleteSubscription(databaseId: string, subscriptionId: string): void {
    this.request<void>('DELETE', `/databases/${databaseId}/listen/${subscriptionId}`).catch((error) => {
      this.log(RiviumSyncLogLevel.DEBUG, 'Stopping a listener on the server failed:', error);
    });
  }

  private addTopic(topic: string, entry: ListenerEntry): void {
    let set = this.topicListeners.get(topic);
    if (!set) {
      set = new Set();
      this.topicListeners.set(topic, set);
    }
    const first = set.size === 0;
    set.add(entry);
    if (first && this.mqttClient?.connected) {
      this.mqttClient.subscribe(topic, { qos: 1 });
    }
  }

  private removeTopic(topic: string, entry: ListenerEntry): void {
    const set = this.topicListeners.get(topic);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) {
      this.topicListeners.delete(topic);
      this.mqttClient?.unsubscribe(topic);
    }
  }

  private clearTimer(entry: ListenerEntry, which: 'relistenTimer' | 'retryTimer'): void {
    const timer = entry[which];
    if (timer) clearTimeout(timer);
    entry[which] = undefined;
  }

  /** Calls the listener with its current result, unless that is what it was last given. */
  private deliver(entry: ListenerEntry): void {
    if (entry.mode === 'stopped') return;
    try {
      if (entry.kind === 'document') {
        const doc = entry.docs.get(entry.documentId!) ?? null;
        const signature = signatureOf(doc);
        if (signature === entry.lastSignature) return;
        entry.lastSignature = signature;
        entry.onDoc?.(doc ? toSyncDocument(doc) : null);
      } else {
        const o = entry.options ?? {};
        const result = queryResult(entry.docs, {
          orderBy: o.orderBy,
          orderDirection: o.orderDirection,
          limit: o.limit,
          offset: o.offset,
          // Older backends' collection topic carries every change of the collection: filter here.
          filters: entry.mode === 'legacy' ? o.filters : undefined,
        });
        const signature = signatureOf(result);
        if (signature === entry.lastSignature) return;
        entry.lastSignature = signature;
        entry.onDocs?.(result.map(toSyncDocument));
      }
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Listener callback threw:', error);
    }
  }

  private handleMqttMessage(topic: string, data: unknown): void {
    const entries = this.topicListeners.get(topic);
    if (!entries) return;
    for (const entry of [...entries]) {
      if (entry.mode === 'server') this.handleListenerEvent(entry, topic, data as ListenerEvent);
      else if (entry.mode === 'legacy') this.handleLegacyChange(entry, data);
    }
  }

  /** An event on a listener's private topic. */
  private handleListenerEvent(entry: ListenerEntry, topic: string, event: ListenerEvent): void {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'revoked') {
      // Only the current subscription's end matters (an old one being replaced may end too).
      if (topic !== entry.topic) return;
      if (event.subscriptionId && event.subscriptionId !== entry.subscriptionId) return;
      if (event.reason === 'expired') {
        void this.listenOnServer(entry);
      } else {
        this.failListener(entry, new ListenerRevokedError(event.reason || 'permission'));
      }
      return;
    }
    if (entry.kind === 'document' && event.documentId !== entry.documentId) return;
    if (applyEvent(entry.docs, event)) this.deliver(entry);
  }

  /** A change on an older backend's per-collection / per-document topic. */
  private handleLegacyChange(entry: ListenerEntry, data: unknown): void {
    if (entry.kind === 'document') {
      const id = (data as { documentId?: unknown })?.documentId;
      if (typeof id === 'string' && id && id !== entry.documentId) return;
      if (applyLegacyChange(entry.docs, data, entry.documentId)) this.deliver(entry);
      return;
    }
    if (applyLegacyChange(entry.docs, data)) this.deliver(entry);
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Disconnect from realtime updates
   */
  disconnect(): void {
    this.disconnected = true;
    if (this.realtimeRetryTimer) clearTimeout(this.realtimeRetryTimer);
    this.realtimeRetryTimer = undefined;
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = undefined;
    // Stop every listener (and end it on the server).
    for (const entry of [...this.listeners]) this.stopListener(entry);
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }
  }
}

// Default export
export default RiviumSyncAdmin;
