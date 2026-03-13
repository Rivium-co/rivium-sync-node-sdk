/**
 * RiviumSync Node.js SDK
 * Server-side SDK for RiviumSync Realtime Database
 *
 * Features:
 * - Admin-level access (bypasses security rules by default)
 * - Full CRUD operations on databases, collections, documents
 * - Query support with filters, sorting, pagination
 * - Batch operations for atomic writes
 * - Realtime subscriptions via MQTT
 * - Ideal for backend services, serverless functions, data migrations
 *
 * @packageDocumentation
 */

import mqtt, { MqttClient, IClientOptions } from 'mqtt';

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
  [RiviumSyncErrorCode.BATCH_WRITE_FAILED]: 'Batch write operation failed',
  [RiviumSyncErrorCode.UNKNOWN_ERROR]: 'An unknown error occurred',
};

export class RiviumSyncError extends Error {
  readonly code: RiviumSyncErrorCode;
  readonly details?: string;

  constructor(code: RiviumSyncErrorCode, details?: string) {
    super(ERROR_MESSAGES[code] || 'Unknown error');
    this.name = 'RiviumSyncError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
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
  /** Server secret for server-side authentication (nl_srv_xxx) - REQUIRED for all server operations */
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
  enableRealtime: boolean;
  logLevel: RiviumSyncLogLevel;
  timeout: number;
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
export type Unsubscribe = () => void;

// ============================================================================
// Batch Operation Types
// ============================================================================

interface BatchOperation {
  type: 'set' | 'update' | 'delete';
  databaseId: string;
  collectionId: string;
  documentId: string;
  data?: unknown;
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
   * Listen to collection changes (requires enableRealtime: true)
   */
  onSnapshot(callback: CollectionListener<T>, options?: QueryOptions): Unsubscribe {
    return this.admin.listenCollection<T>(this.databaseId, this.collectionId, callback, options);
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
   * Set document data (overwrite)
   */
  async set(data: T): Promise<void> {
    await this.admin.setDocument<T>(this.databaseId, this.collectionId, this.documentId, data);
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
   * Listen to document changes (requires enableRealtime: true)
   */
  onSnapshot(callback: DocumentListener<T>): Unsubscribe {
    return this.admin.listenDocument<T>(this.databaseId, this.collectionId, this.documentId, callback);
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
   * Listen to query results (requires enableRealtime: true)
   */
  onSnapshot(callback: CollectionListener<T>): Unsubscribe {
    return this.admin.listenCollection<T>(this.databaseId, this.collectionId, callback, this.options);
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

  get id(): string {
    return this.databaseId;
  }

  /**
   * Get a collection reference
   */
  collection<T = Record<string, unknown>>(collectionId: string): SyncCollection<T> {
    return new SyncCollection<T>(this.admin, this.databaseId, collectionId);
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
   * Add a set operation to the batch
   */
  set<T>(docRef: SyncDocumentRef<T>, data: T): WriteBatch {
    this.operations.push({
      type: 'set',
      databaseId: (docRef as unknown as { databaseId: string }).databaseId,
      collectionId: (docRef as unknown as { collectionId: string }).collectionId,
      documentId: docRef.id,
      data,
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
 * // Get a database reference
 * const db = riviumSync.database('my-database-id');
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

  // Realtime listeners
  private documentListeners: Map<string, Set<DocumentListener<unknown>>> = new Map();
  private collectionListeners: Map<string, Set<{ callback: CollectionListener<unknown>; options?: QueryOptions }>> = new Map();
  private cachedCollections: Map<string, SyncDocument<unknown>[]> = new Map();

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

    // Initialize realtime if enabled
    if (this.config.enableRealtime) {
      this.initRealtime();
    }
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'x-server-secret': this.config.serverSecret,
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
        throw new RiviumSyncError(
          RiviumSyncErrorCode.DATA_FETCH_FAILED,
          `HTTP ${response.status}: ${errorText}`,
        );
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
   * Get a database reference
   */
  database(databaseId: string): SyncDatabase {
    return new SyncDatabase(this, databaseId);
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
      const response = await this.request<SyncDocument<T>>(
        'GET',
        `/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`,
      );
      return response;
    } catch (error) {
      if ((error as RiviumSyncError).details?.includes('404')) {
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
      const queryParams = new URLSearchParams();

      if (options?.filters) {
        queryParams.set('filters', JSON.stringify(options.filters));
      }
      if (options?.orderBy) {
        queryParams.set('orderBy', options.orderBy);
        queryParams.set('orderDirection', options.orderDirection || 'asc');
      }
      if (options?.limit) {
        queryParams.set('limit', options.limit.toString());
      }
      if (options?.offset) {
        queryParams.set('offset', options.offset.toString());
      }

      const queryString = queryParams.toString();
      const path = `/databases/${databaseId}/collections/${collectionId}/documents/sdk${queryString ? `?${queryString}` : ''}`;

      const response = await this.request<{ documents: SyncDocument<T>[] } | SyncDocument<T>[]>(
        'GET',
        path,
      );

      return Array.isArray(response) ? response : response.documents || [];
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
      const response = await this.request<SyncDocument<T>>(
        'POST',
        `/databases/${databaseId}/collections/${collectionId}/documents/sdk`,
        { data },
      );
      return response;
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
  ): Promise<void> {
    try {
      await this.request<void>(
        'PUT',
        `/databases/${databaseId}/collections/${collectionId}/documents/sdk/${documentId}`,
        { data },
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
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to delete document:', error);
      throw error;
    }
  }

  // ==========================================================================
  // Batch Operations
  // ==========================================================================

  async executeBatch(operations: BatchOperation[]): Promise<void> {
    // Execute operations sequentially for now
    // In a production system, this would be a single atomic transaction
    for (const op of operations) {
      switch (op.type) {
        case 'set':
          await this.setDocument(op.databaseId, op.collectionId, op.documentId, op.data);
          break;
        case 'update':
          await this.updateDocument(op.databaseId, op.collectionId, op.documentId, op.data as Record<string, unknown>);
          break;
        case 'delete':
          await this.deleteDocument(op.databaseId, op.collectionId, op.documentId);
          break;
      }
    }
  }

  // ==========================================================================
  // Realtime (Optional)
  // ==========================================================================

  private async initRealtime(): Promise<void> {
    try {
      this.log(RiviumSyncLogLevel.DEBUG, 'Fetching MQTT token...');

      const tokenData = await this.request<{
        token: string;
        mqtt: { host: string; port: number; useTls: boolean };
      }>('POST', '/connections/token');

      this.mqttConfig = {
        host: tokenData.mqtt.host,
        port: tokenData.mqtt.port,
        wsHost: tokenData.mqtt.host,
        wsPort: tokenData.mqtt.port,
        password: tokenData.token,
      };

      this.connectMqtt();
    } catch (error) {
      this.log(RiviumSyncLogLevel.ERROR, 'Failed to fetch MQTT token:', error);
    }
  }

  private connectMqtt(): void {
    if (!this.mqttConfig) {
      return;
    }

    const url = `mqtt://${this.mqttConfig.host}:${this.mqttConfig.port}`;
    const clientId = `rivium_sync_node_${this.generateUUID()}`;

    const options: IClientOptions = {
      clientId,
      clean: false,
      connectTimeout: 10000,
      username: 'jwt',
      password: this.mqttConfig.password,
    };

    this.log(RiviumSyncLogLevel.DEBUG, 'Connecting to MQTT:', url);

    this.mqttClient = mqtt.connect(url, options);

    this.mqttClient.on('connect', () => {
      this.log(RiviumSyncLogLevel.INFO, 'MQTT connected');
      this.resubscribeAll();
    });

    this.mqttClient.on('message', (topic: string, payload: Buffer) => {
      try {
        const data = JSON.parse(payload.toString());
        this.handleMqttMessage(topic, data);
      } catch (error) {
        this.log(RiviumSyncLogLevel.ERROR, 'MQTT message parse error:', error);
      }
    });

    this.mqttClient.on('error', (error: Error) => {
      this.log(RiviumSyncLogLevel.ERROR, 'MQTT error:', error);
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
  ): Unsubscribe {
    if (!this.config.enableRealtime) {
      this.log(RiviumSyncLogLevel.WARNING, 'Realtime not enabled. Set enableRealtime: true in config.');
      // Still fetch initial data
      this.getDocument<T>(databaseId, collectionId, documentId).then((doc) => {
        callback(doc);
      });
      return () => {};
    }

    const path = `/${databaseId}/${collectionId}/${documentId}`;
    const mqttTopic = `rivium_sync/${this.config.apiKey.substring(0, 16)}/db/${databaseId}/${collectionId}/${documentId}`;

    if (!this.documentListeners.has(path)) {
      this.documentListeners.set(path, new Set());
    }
    this.documentListeners.get(path)!.add(callback as DocumentListener<unknown>);

    if (this.mqttClient?.connected) {
      this.mqttClient.subscribe(mqttTopic, { qos: 1 });
    }

    // Fetch initial data
    this.getDocument<T>(databaseId, collectionId, documentId).then((doc) => {
      callback(doc);
    });

    return () => {
      const listeners = this.documentListeners.get(path);
      if (listeners) {
        listeners.delete(callback as DocumentListener<unknown>);
        if (listeners.size === 0) {
          this.documentListeners.delete(path);
          this.mqttClient?.unsubscribe(mqttTopic);
        }
      }
    };
  }

  listenCollection<T>(
    databaseId: string,
    collectionId: string,
    callback: CollectionListener<T>,
    options?: QueryOptions,
  ): Unsubscribe {
    if (!this.config.enableRealtime) {
      this.log(RiviumSyncLogLevel.WARNING, 'Realtime not enabled. Set enableRealtime: true in config.');
      // Still fetch initial data
      this.getDocuments<T>(databaseId, collectionId, options).then((docs) => {
        callback(docs);
      });
      return () => {};
    }

    const path = `/${databaseId}/${collectionId}`;
    const mqttTopic = `rivium_sync/${this.config.apiKey.substring(0, 16)}/db/${databaseId}/${collectionId}/+`;

    if (!this.collectionListeners.has(path)) {
      this.collectionListeners.set(path, new Set());
    }
    this.collectionListeners.get(path)!.add({
      callback: callback as CollectionListener<unknown>,
      options,
    });

    if (this.mqttClient?.connected) {
      this.mqttClient.subscribe(mqttTopic, { qos: 1 });
    }

    // Fetch initial data
    this.getDocuments<T>(databaseId, collectionId, options).then((docs) => {
      this.cachedCollections.set(path, docs as SyncDocument<unknown>[]);
      callback(docs);
    });

    return () => {
      const listeners = this.collectionListeners.get(path);
      if (listeners) {
        const listenerObj = Array.from(listeners).find((l) => l.callback === callback);
        if (listenerObj) {
          listeners.delete(listenerObj);
        }
        if (listeners.size === 0) {
          this.collectionListeners.delete(path);
          this.cachedCollections.delete(path);
          this.mqttClient?.unsubscribe(mqttTopic);
        }
      }
    };
  }

  private resubscribeAll(): void {
    if (!this.mqttClient?.connected) return;

    const appId = this.config.apiKey.substring(0, 16);

    this.documentListeners.forEach((_, path) => {
      const parts = path.split('/').filter((p) => p);
      if (parts.length === 3) {
        const [databaseId, collectionId, documentId] = parts;
        const topic = `rivium_sync/${appId}/db/${databaseId}/${collectionId}/${documentId}`;
        this.mqttClient!.subscribe(topic, { qos: 1 });
      }
    });

    this.collectionListeners.forEach((_, path) => {
      const parts = path.split('/').filter((p) => p);
      if (parts.length === 2) {
        const [databaseId, collectionId] = parts;
        const topic = `rivium_sync/${appId}/db/${databaseId}/${collectionId}/+`;
        this.mqttClient!.subscribe(topic, { qos: 1 });
      }
    });
  }

  private handleMqttMessage(topic: string, data: unknown): void {
    const parts = topic.split('/');
    if (parts.length < 6) return;

    const databaseId = parts[3];
    const collectionId = parts[4];
    const documentId = parts[5];

    const documentPath = `/${databaseId}/${collectionId}/${documentId}`;
    const collectionPath = `/${databaseId}/${collectionId}`;

    const typedData = data as Record<string, unknown>;

    // Notify document listeners
    const docListeners = this.documentListeners.get(documentPath);
    if (docListeners) {
      const document: SyncDocument<unknown> = {
        id: documentId,
        data: typedData.data || typedData,
        createdAt: typedData.createdAt as string,
        updatedAt: typedData.updatedAt as string,
        version: typedData.version as number,
      };

      docListeners.forEach((callback) => {
        if (typedData.deleted) {
          callback(null);
        } else {
          callback(document);
        }
      });
    }

    // Notify collection listeners
    const colListeners = this.collectionListeners.get(collectionPath);
    if (colListeners) {
      let docs = this.cachedCollections.get(collectionPath) || [];

      if (typedData.deleted) {
        docs = docs.filter((d) => d.id !== documentId);
      } else {
        const existingIndex = docs.findIndex((d) => d.id === documentId);
        const newDoc: SyncDocument<unknown> = {
          id: documentId,
          data: typedData.data || typedData,
          createdAt: typedData.createdAt as string,
          updatedAt: typedData.updatedAt as string,
          version: typedData.version as number,
        };

        if (existingIndex >= 0) {
          docs[existingIndex] = newDoc;
        } else {
          docs.push(newDoc);
        }
      }

      this.cachedCollections.set(collectionPath, docs);

      colListeners.forEach(({ callback, options }) => {
        let filteredDocs = [...docs];

        if (options?.filters) {
          filteredDocs = this.applyFilters(filteredDocs, options.filters);
        }

        if (options?.orderBy) {
          filteredDocs = this.applyOrdering(filteredDocs, options.orderBy, options.orderDirection);
        }

        if (options?.limit) {
          filteredDocs = filteredDocs.slice(options.offset || 0, (options.offset || 0) + options.limit);
        }

        callback(filteredDocs);
      });
    }
  }

  private applyFilters(docs: SyncDocument<unknown>[], filters: QueryFilter[]): SyncDocument<unknown>[] {
    return docs.filter((doc) => {
      const data = doc.data as Record<string, unknown>;
      return filters.every((filter) => {
        const value = data[filter.field];

        switch (filter.operator) {
          case '==':
            return value === filter.value;
          case '!=':
            return value !== filter.value;
          case '<':
            return (value as number) < (filter.value as number);
          case '<=':
            return (value as number) <= (filter.value as number);
          case '>':
            return (value as number) > (filter.value as number);
          case '>=':
            return (value as number) >= (filter.value as number);
          case 'in':
            return Array.isArray(filter.value) && filter.value.includes(value);
          case 'not-in':
            return Array.isArray(filter.value) && !filter.value.includes(value);
          case 'array-contains':
            return Array.isArray(value) && value.includes(filter.value);
          default:
            return true;
        }
      });
    });
  }

  private applyOrdering(
    docs: SyncDocument<unknown>[],
    orderBy: string,
    direction?: 'asc' | 'desc',
  ): SyncDocument<unknown>[] {
    return [...docs].sort((a, b) => {
      const aData = a.data as Record<string, unknown>;
      const bData = b.data as Record<string, unknown>;
      const aVal = aData[orderBy] as string | number | boolean | null | undefined;
      const bVal = bData[orderBy] as string | number | boolean | null | undefined;

      let comparison = 0;
      if (aVal == null && bVal != null) comparison = -1;
      else if (aVal != null && bVal == null) comparison = 1;
      else if (aVal != null && bVal != null) {
        if (aVal < bVal) comparison = -1;
        else if (aVal > bVal) comparison = 1;
      }

      return direction === 'desc' ? -comparison : comparison;
    });
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Disconnect from realtime updates
   */
  disconnect(): void {
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }
  }
}

// Default export
export default RiviumSyncAdmin;
