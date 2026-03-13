import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RiviumSyncAdmin,
  RiviumSyncError,
  RiviumSyncErrorCode,
  RiviumSyncLogLevel,
  SyncDatabase,
  SyncCollection,
  SyncDocumentRef,
  SyncQuery,
  WriteBatch,
} from '../index';

// ============================================================================
// Test Helpers
// ============================================================================

const VALID_CONFIG = {
  apiKey: 'rv_live_test1234567890',
  serverSecret: 'nl_srv_secret1234567890',
};

function createAdmin(overrides = {}) {
  return new RiviumSyncAdmin({ ...VALID_CONFIG, ...overrides });
}

function mockFetchSuccess(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchFailure(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

function mockFetchNetworkError(message: string) {
  return vi.fn().mockRejectedValue(new Error(message));
}

// ============================================================================
// RiviumSyncErrorCode Enum
// ============================================================================

describe('RiviumSyncErrorCode', () => {
  it('should define all connection error codes', () => {
    expect(RiviumSyncErrorCode.CONNECTION_FAILED).toBe(1000);
    expect(RiviumSyncErrorCode.CONNECTION_TIMEOUT).toBe(1001);
    expect(RiviumSyncErrorCode.CONNECTION_LOST).toBe(1002);
    expect(RiviumSyncErrorCode.AUTHENTICATION_FAILED).toBe(1004);
  });

  it('should define subscription error codes', () => {
    expect(RiviumSyncErrorCode.SUBSCRIPTION_FAILED).toBe(1100);
  });

  it('should define all data error codes', () => {
    expect(RiviumSyncErrorCode.DATA_FETCH_FAILED).toBe(1200);
    expect(RiviumSyncErrorCode.DATA_PARSE_ERROR).toBe(1201);
    expect(RiviumSyncErrorCode.DATA_WRITE_FAILED).toBe(1202);
    expect(RiviumSyncErrorCode.DATA_DELETE_FAILED).toBe(1203);
    expect(RiviumSyncErrorCode.DOCUMENT_NOT_FOUND).toBe(1204);
  });

  it('should define all configuration error codes', () => {
    expect(RiviumSyncErrorCode.INVALID_CONFIG).toBe(1300);
    expect(RiviumSyncErrorCode.MISSING_API_KEY).toBe(1301);
    expect(RiviumSyncErrorCode.MISSING_SERVER_URL).toBe(1302);
    expect(RiviumSyncErrorCode.MISSING_SERVER_SECRET).toBe(1303);
  });

  it('should define state error codes', () => {
    expect(RiviumSyncErrorCode.NOT_INITIALIZED).toBe(1500);
    expect(RiviumSyncErrorCode.NOT_CONNECTED).toBe(1501);
  });

  it('should define query error codes', () => {
    expect(RiviumSyncErrorCode.INVALID_QUERY).toBe(1700);
    expect(RiviumSyncErrorCode.QUERY_EXECUTION_FAILED).toBe(1701);
  });

  it('should define batch error codes', () => {
    expect(RiviumSyncErrorCode.BATCH_WRITE_FAILED).toBe(1800);
  });

  it('should define the unknown error code', () => {
    expect(RiviumSyncErrorCode.UNKNOWN_ERROR).toBe(9999);
  });

  it('should have exactly 20 error codes', () => {
    const numericValues = Object.values(RiviumSyncErrorCode).filter(
      (v) => typeof v === 'number',
    );
    expect(numericValues).toHaveLength(20);
  });
});

// ============================================================================
// RiviumSyncError
// ============================================================================

describe('RiviumSyncError', () => {
  it('should be an instance of Error', () => {
    const error = new RiviumSyncError(RiviumSyncErrorCode.UNKNOWN_ERROR);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RiviumSyncError);
  });

  it('should set the name to RiviumSyncError', () => {
    const error = new RiviumSyncError(RiviumSyncErrorCode.UNKNOWN_ERROR);
    expect(error.name).toBe('RiviumSyncError');
  });

  it('should store the error code', () => {
    const error = new RiviumSyncError(RiviumSyncErrorCode.CONNECTION_FAILED);
    expect(error.code).toBe(RiviumSyncErrorCode.CONNECTION_FAILED);
  });

  it('should map error codes to correct messages', () => {
    const testCases: [RiviumSyncErrorCode, string][] = [
      [RiviumSyncErrorCode.CONNECTION_FAILED, 'Failed to connect to server'],
      [RiviumSyncErrorCode.CONNECTION_TIMEOUT, 'Connection timed out'],
      [RiviumSyncErrorCode.CONNECTION_LOST, 'Connection to server was lost'],
      [RiviumSyncErrorCode.AUTHENTICATION_FAILED, 'Authentication failed - invalid API key'],
      [RiviumSyncErrorCode.SUBSCRIPTION_FAILED, 'Failed to subscribe to path'],
      [RiviumSyncErrorCode.DATA_FETCH_FAILED, 'Failed to fetch data'],
      [RiviumSyncErrorCode.DATA_PARSE_ERROR, 'Failed to parse data'],
      [RiviumSyncErrorCode.DATA_WRITE_FAILED, 'Failed to write data'],
      [RiviumSyncErrorCode.DATA_DELETE_FAILED, 'Failed to delete data'],
      [RiviumSyncErrorCode.DOCUMENT_NOT_FOUND, 'Document not found'],
      [RiviumSyncErrorCode.INVALID_CONFIG, 'Invalid configuration'],
      [RiviumSyncErrorCode.MISSING_API_KEY, 'API key is missing'],
      [RiviumSyncErrorCode.MISSING_SERVER_URL, 'Server URL is missing'],
      [RiviumSyncErrorCode.MISSING_SERVER_SECRET, 'Server secret is missing'],
      [RiviumSyncErrorCode.NOT_INITIALIZED, 'SDK is not initialized'],
      [RiviumSyncErrorCode.NOT_CONNECTED, 'Not connected to server'],
      [RiviumSyncErrorCode.INVALID_QUERY, 'Invalid query parameters'],
      [RiviumSyncErrorCode.QUERY_EXECUTION_FAILED, 'Query execution failed'],
      [RiviumSyncErrorCode.BATCH_WRITE_FAILED, 'Batch write operation failed'],
      [RiviumSyncErrorCode.UNKNOWN_ERROR, 'An unknown error occurred'],
    ];

    for (const [code, expectedMessage] of testCases) {
      const error = new RiviumSyncError(code);
      expect(error.message).toBe(expectedMessage);
    }
  });

  it('should store optional details', () => {
    const error = new RiviumSyncError(
      RiviumSyncErrorCode.DATA_FETCH_FAILED,
      'HTTP 500: Internal Server Error',
    );
    expect(error.details).toBe('HTTP 500: Internal Server Error');
  });

  it('should leave details undefined when not provided', () => {
    const error = new RiviumSyncError(RiviumSyncErrorCode.UNKNOWN_ERROR);
    expect(error.details).toBeUndefined();
  });

  describe('toJSON', () => {
    it('should return code, message, and details', () => {
      const error = new RiviumSyncError(
        RiviumSyncErrorCode.DATA_FETCH_FAILED,
        'extra info',
      );
      const json = error.toJSON();
      expect(json).toEqual({
        code: RiviumSyncErrorCode.DATA_FETCH_FAILED,
        message: 'Failed to fetch data',
        details: 'extra info',
      });
    });

    it('should include undefined details when not provided', () => {
      const error = new RiviumSyncError(RiviumSyncErrorCode.UNKNOWN_ERROR);
      const json = error.toJSON();
      expect(json).toEqual({
        code: 9999,
        message: 'An unknown error occurred',
        details: undefined,
      });
    });

    it('should be serializable via JSON.stringify', () => {
      const error = new RiviumSyncError(
        RiviumSyncErrorCode.MISSING_API_KEY,
        'Check env vars',
      );
      const serialized = JSON.stringify(error.toJSON());
      const parsed = JSON.parse(serialized);
      expect(parsed.code).toBe(1301);
      expect(parsed.message).toBe('API key is missing');
      expect(parsed.details).toBe('Check env vars');
    });
  });
});

// ============================================================================
// RiviumSyncLogLevel Enum
// ============================================================================

describe('RiviumSyncLogLevel', () => {
  it('should define NONE as 0', () => {
    expect(RiviumSyncLogLevel.NONE).toBe(0);
  });

  it('should define ERROR as 1', () => {
    expect(RiviumSyncLogLevel.ERROR).toBe(1);
  });

  it('should define WARNING as 2', () => {
    expect(RiviumSyncLogLevel.WARNING).toBe(2);
  });

  it('should define INFO as 3', () => {
    expect(RiviumSyncLogLevel.INFO).toBe(3);
  });

  it('should define DEBUG as 4', () => {
    expect(RiviumSyncLogLevel.DEBUG).toBe(4);
  });

  it('should define VERBOSE as 5', () => {
    expect(RiviumSyncLogLevel.VERBOSE).toBe(5);
  });

  it('should have levels in ascending order of verbosity', () => {
    expect(RiviumSyncLogLevel.NONE).toBeLessThan(RiviumSyncLogLevel.ERROR);
    expect(RiviumSyncLogLevel.ERROR).toBeLessThan(RiviumSyncLogLevel.WARNING);
    expect(RiviumSyncLogLevel.WARNING).toBeLessThan(RiviumSyncLogLevel.INFO);
    expect(RiviumSyncLogLevel.INFO).toBeLessThan(RiviumSyncLogLevel.DEBUG);
    expect(RiviumSyncLogLevel.DEBUG).toBeLessThan(RiviumSyncLogLevel.VERBOSE);
  });
});

// ============================================================================
// RiviumSyncAdmin - Constructor & Configuration
// ============================================================================

describe('RiviumSyncAdmin', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Suppress console output during tests
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create an instance with valid config', () => {
      const admin = createAdmin();
      expect(admin).toBeInstanceOf(RiviumSyncAdmin);
    });

    it('should throw MISSING_API_KEY when apiKey is empty string', () => {
      expect(() => new RiviumSyncAdmin({ apiKey: '', serverSecret: 'secret' })).toThrow(
        RiviumSyncError,
      );
      try {
        new RiviumSyncAdmin({ apiKey: '', serverSecret: 'secret' });
      } catch (e) {
        expect((e as RiviumSyncError).code).toBe(RiviumSyncErrorCode.MISSING_API_KEY);
      }
    });

    it('should throw MISSING_SERVER_SECRET when serverSecret is empty string', () => {
      expect(
        () => new RiviumSyncAdmin({ apiKey: 'rv_live_test', serverSecret: '' }),
      ).toThrow(RiviumSyncError);
      try {
        new RiviumSyncAdmin({ apiKey: 'rv_live_test', serverSecret: '' });
      } catch (e) {
        expect((e as RiviumSyncError).code).toBe(
          RiviumSyncErrorCode.MISSING_SERVER_SECRET,
        );
      }
    });

    it('should throw when both apiKey and serverSecret are missing', () => {
      expect(
        () => new RiviumSyncAdmin({ apiKey: '', serverSecret: '' }),
      ).toThrow(RiviumSyncError);
    });

    it('should accept optional logLevel', () => {
      const admin = createAdmin({ logLevel: RiviumSyncLogLevel.VERBOSE });
      expect(admin).toBeInstanceOf(RiviumSyncAdmin);
    });

    it('should accept optional timeout', () => {
      const admin = createAdmin({ timeout: 5000 });
      expect(admin).toBeInstanceOf(RiviumSyncAdmin);
    });

    it('should default enableRealtime to false', () => {
      // If enableRealtime were true by default, the constructor would try to
      // call initRealtime which makes an HTTP request. Since we are not mocking
      // fetch here, no request should be made.
      const admin = createAdmin();
      expect(admin).toBeInstanceOf(RiviumSyncAdmin);
    });
  });

  describe('setLogLevel', () => {
    it('should update the log level without error', () => {
      const admin = createAdmin();
      expect(() => admin.setLogLevel(RiviumSyncLogLevel.VERBOSE)).not.toThrow();
      expect(() => admin.setLogLevel(RiviumSyncLogLevel.NONE)).not.toThrow();
    });
  });

  describe('disconnect', () => {
    it('should not throw when called without realtime enabled', () => {
      const admin = createAdmin();
      expect(() => admin.disconnect()).not.toThrow();
    });

    it('should be callable multiple times without error', () => {
      const admin = createAdmin();
      admin.disconnect();
      admin.disconnect();
      expect(true).toBe(true);
    });
  });

  // ==========================================================================
  // Database Navigation
  // ==========================================================================

  describe('database()', () => {
    it('should return a SyncDatabase instance', () => {
      const admin = createAdmin();
      const db = admin.database('my-db');
      expect(db).toBeInstanceOf(SyncDatabase);
    });

    it('should return different instances for different database ids', () => {
      const admin = createAdmin();
      const db1 = admin.database('db-one');
      const db2 = admin.database('db-two');
      expect(db1).not.toBe(db2);
    });
  });

  describe('batch()', () => {
    it('should return a WriteBatch instance', () => {
      const admin = createAdmin();
      const batch = admin.batch();
      expect(batch).toBeInstanceOf(WriteBatch);
    });

    it('should return distinct WriteBatch instances each time', () => {
      const admin = createAdmin();
      const batch1 = admin.batch();
      const batch2 = admin.batch();
      expect(batch1).not.toBe(batch2);
    });
  });

  // ==========================================================================
  // HTTP Operations with mocked fetch
  // ==========================================================================

  describe('getDocument', () => {
    it('should call fetch with correct URL and headers', async () => {
      const mockDoc = { id: 'doc1', data: { name: 'Test' } };
      const fetchSpy = mockFetchSuccess(mockDoc);
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      const result = await admin.getDocument('db1', 'users', 'doc1');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'https://sync.rivium.co/databases/db1/collections/users/documents/sdk/doc1',
      );
      expect(options.method).toBe('GET');
      expect(options.headers['x-api-key']).toBe(VALID_CONFIG.apiKey);
      expect(options.headers['x-server-secret']).toBe(VALID_CONFIG.serverSecret);
      expect(result).toEqual(mockDoc);
    });

    it('should return null when document is not found (404)', async () => {
      const fetchSpy = mockFetchFailure(404, 'Not Found');
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      const result = await admin.getDocument('db1', 'users', 'missing');
      expect(result).toBeNull();
    });

    it('should throw RiviumSyncError on non-404 HTTP errors', async () => {
      const fetchSpy = mockFetchFailure(500, 'Internal Server Error');
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      await expect(admin.getDocument('db1', 'users', 'doc1')).rejects.toThrow(
        RiviumSyncError,
      );
    });

    it('should throw on network errors', async () => {
      const fetchSpy = mockFetchNetworkError('Network failure');
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      await expect(admin.getDocument('db1', 'col', 'doc')).rejects.toThrow(
        RiviumSyncError,
      );
    });
  });

  describe('getDocuments', () => {
    it('should return an array of documents from { documents: [...] } response', async () => {
      const docs = [
        { id: 'd1', data: { name: 'A' } },
        { id: 'd2', data: { name: 'B' } },
      ];
      vi.stubGlobal('fetch', mockFetchSuccess({ documents: docs }));

      const admin = createAdmin();
      const result = await admin.getDocuments('db1', 'users');
      expect(result).toEqual(docs);
    });

    it('should return an array of documents from a plain array response', async () => {
      const docs = [{ id: 'd1', data: { name: 'A' } }];
      vi.stubGlobal('fetch', mockFetchSuccess(docs));

      const admin = createAdmin();
      const result = await admin.getDocuments('db1', 'users');
      expect(result).toEqual(docs);
    });

    it('should include query params for filters, orderBy, limit, offset', async () => {
      const fetchSpy = mockFetchSuccess({ documents: [] });
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      await admin.getDocuments('db1', 'users', {
        filters: [{ field: 'age', operator: '>=', value: 18 }],
        orderBy: 'name',
        orderDirection: 'desc',
        limit: 10,
        offset: 5,
      });

      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('filters=');
      expect(calledUrl).toContain('orderBy=name');
      expect(calledUrl).toContain('orderDirection=desc');
      expect(calledUrl).toContain('limit=10');
      expect(calledUrl).toContain('offset=5');
    });
  });

  describe('addDocument', () => {
    it('should POST with data payload', async () => {
      const newDoc = { id: 'auto-id', data: { name: 'New' } };
      const fetchSpy = mockFetchSuccess(newDoc);
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      const result = await admin.addDocument('db1', 'users', { name: 'New' });

      expect(result).toEqual(newDoc);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'https://sync.rivium.co/databases/db1/collections/users/documents/sdk',
      );
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ data: { name: 'New' } });
    });
  });

  describe('setDocument', () => {
    it('should PUT with data payload', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      await admin.setDocument('db1', 'users', 'doc1', { name: 'Updated' });

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'https://sync.rivium.co/databases/db1/collections/users/documents/sdk/doc1',
      );
      expect(options.method).toBe('PUT');
      expect(JSON.parse(options.body)).toEqual({ data: { name: 'Updated' } });
    });
  });

  describe('updateDocument', () => {
    it('should PATCH with partial data payload', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      await admin.updateDocument('db1', 'users', 'doc1', { age: 30 });

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'https://sync.rivium.co/databases/db1/collections/users/documents/sdk/doc1',
      );
      expect(options.method).toBe('PATCH');
      expect(JSON.parse(options.body)).toEqual({ data: { age: 30 } });
    });
  });

  describe('deleteDocument', () => {
    it('should send DELETE request', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      await admin.deleteDocument('db1', 'users', 'doc1');

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe(
        'https://sync.rivium.co/databases/db1/collections/users/documents/sdk/doc1',
      );
      expect(options.method).toBe('DELETE');
    });
  });

  describe('executeBatch', () => {
    it('should execute all operations sequentially', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      await admin.executeBatch([
        { type: 'set', databaseId: 'db1', collectionId: 'users', documentId: 'd1', data: { a: 1 } },
        { type: 'update', databaseId: 'db1', collectionId: 'users', documentId: 'd2', data: { b: 2 } },
        { type: 'delete', databaseId: 'db1', collectionId: 'users', documentId: 'd3' },
      ]);

      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // Verify set (PUT)
      expect(fetchSpy.mock.calls[0][1].method).toBe('PUT');
      // Verify update (PATCH)
      expect(fetchSpy.mock.calls[1][1].method).toBe('PATCH');
      // Verify delete (DELETE)
      expect(fetchSpy.mock.calls[2][1].method).toBe('DELETE');
    });

    it('should handle empty operations array', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const admin = createAdmin();
      await admin.executeBatch([]);

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('request timeout handling', () => {
    it('should throw CONNECTION_TIMEOUT on AbortError', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

      const admin = createAdmin({ timeout: 1 });
      try {
        await admin.getDocument('db1', 'col', 'doc');
        expect.unreachable('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(RiviumSyncError);
        expect((e as RiviumSyncError).code).toBe(
          RiviumSyncErrorCode.CONNECTION_TIMEOUT,
        );
      }
    });
  });

  describe('request with empty response body', () => {
    it('should return empty object when response text is empty', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve(''),
        }),
      );

      const admin = createAdmin();
      const result = await admin.setDocument('db1', 'col', 'doc', { x: 1 });
      // setDocument calls request which returns {} for empty body
      expect(result).toBeUndefined(); // setDocument itself returns void
    });
  });
});

// ============================================================================
// SyncDatabase
// ============================================================================

describe('SyncDatabase', () => {
  let admin: RiviumSyncAdmin;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    admin = createAdmin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should expose the database id via getter', () => {
    const db = admin.database('test-db-123');
    expect(db.id).toBe('test-db-123');
  });

  it('should return a SyncCollection from collection()', () => {
    const db = admin.database('my-db');
    const col = db.collection('users');
    expect(col).toBeInstanceOf(SyncCollection);
  });

  it('should allow generic type parameter on collection()', () => {
    interface User {
      name: string;
      age: number;
    }
    const db = admin.database('my-db');
    const col = db.collection<User>('users');
    expect(col).toBeInstanceOf(SyncCollection);
  });
});

// ============================================================================
// SyncCollection
// ============================================================================

describe('SyncCollection', () => {
  let admin: RiviumSyncAdmin;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    admin = createAdmin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return a SyncDocumentRef from doc()', () => {
    const col = admin.database('db1').collection('users');
    const ref = col.doc('user-abc');
    expect(ref).toBeInstanceOf(SyncDocumentRef);
  });

  it('should return a SyncQuery from query()', () => {
    const col = admin.database('db1').collection('users');
    const q = col.query();
    expect(q).toBeInstanceOf(SyncQuery);
  });

  it('should return a SyncQuery from where()', () => {
    const col = admin.database('db1').collection('users');
    const q = col.where('age', '>=', 18);
    expect(q).toBeInstanceOf(SyncQuery);
  });

  it('should return a SyncQuery from orderBy()', () => {
    const col = admin.database('db1').collection('users');
    const q = col.orderBy('name', 'asc');
    expect(q).toBeInstanceOf(SyncQuery);
  });

  it('should return a SyncQuery from limit()', () => {
    const col = admin.database('db1').collection('users');
    const q = col.limit(10);
    expect(q).toBeInstanceOf(SyncQuery);
  });

  describe('add()', () => {
    it('should delegate to admin.addDocument', async () => {
      const mockDoc = { id: 'auto', data: { name: 'Alice' } };
      vi.stubGlobal('fetch', mockFetchSuccess(mockDoc));

      const col = admin.database('db1').collection('users');
      const result = await col.add({ name: 'Alice' });
      expect(result).toEqual(mockDoc);
    });
  });

  describe('get()', () => {
    it('should delegate to admin.getDocument', async () => {
      const mockDoc = { id: 'u1', data: { name: 'Bob' } };
      vi.stubGlobal('fetch', mockFetchSuccess(mockDoc));

      const col = admin.database('db1').collection('users');
      const result = await col.get('u1');
      expect(result).toEqual(mockDoc);
    });
  });

  describe('getAll()', () => {
    it('should delegate to admin.getDocuments', async () => {
      const docs = [{ id: 'u1', data: { name: 'A' } }];
      vi.stubGlobal('fetch', mockFetchSuccess({ documents: docs }));

      const col = admin.database('db1').collection('users');
      const result = await col.getAll();
      expect(result).toEqual(docs);
    });

    it('should pass query options when provided', async () => {
      const fetchSpy = mockFetchSuccess({ documents: [] });
      vi.stubGlobal('fetch', fetchSpy);

      const col = admin.database('db1').collection('users');
      await col.getAll({ limit: 5, orderBy: 'name' });

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('limit=5');
      expect(url).toContain('orderBy=name');
    });
  });

  describe('onSnapshot()', () => {
    it('should return an unsubscribe function', () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ documents: [] }));

      const col = admin.database('db1').collection('users');
      const unsub = col.onSnapshot(() => {});
      expect(typeof unsub).toBe('function');
    });
  });
});

// ============================================================================
// SyncDocumentRef
// ============================================================================

describe('SyncDocumentRef', () => {
  let admin: RiviumSyncAdmin;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    admin = createAdmin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should expose the document id via getter', () => {
    const ref = admin.database('db1').collection('users').doc('user-xyz');
    expect(ref.id).toBe('user-xyz');
  });

  it('should expose the full path via getter', () => {
    const ref = admin.database('db1').collection('users').doc('user-xyz');
    expect(ref.path).toBe('/db1/users/user-xyz');
  });

  it('should construct correct path with various ids', () => {
    const ref = admin
      .database('prod-database')
      .collection('orders')
      .doc('order-001');
    expect(ref.path).toBe('/prod-database/orders/order-001');
  });

  describe('get()', () => {
    it('should fetch the document', async () => {
      const mockDoc = { id: 'doc1', data: { title: 'Hello' } };
      vi.stubGlobal('fetch', mockFetchSuccess(mockDoc));

      const ref = admin.database('db1').collection('posts').doc('doc1');
      const result = await ref.get();
      expect(result).toEqual(mockDoc);
    });
  });

  describe('exists()', () => {
    it('should return true when document exists', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetchSuccess({ id: 'doc1', data: { x: 1 } }),
      );

      const ref = admin.database('db1').collection('col').doc('doc1');
      const result = await ref.exists();
      expect(result).toBe(true);
    });

    it('should return false when document does not exist (404)', async () => {
      vi.stubGlobal('fetch', mockFetchFailure(404, 'Not Found'));

      const ref = admin.database('db1').collection('col').doc('missing');
      const result = await ref.exists();
      expect(result).toBe(false);
    });
  });

  describe('set()', () => {
    it('should send PUT request via admin', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const ref = admin.database('db1').collection('users').doc('u1');
      await ref.set({ name: 'Alice', age: 30 });

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0][1].method).toBe('PUT');
    });
  });

  describe('update()', () => {
    it('should send PATCH request via admin', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const ref = admin.database('db1').collection('users').doc('u1');
      await ref.update({ age: 31 });

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0][1].method).toBe('PATCH');
    });
  });

  describe('delete()', () => {
    it('should send DELETE request via admin', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const ref = admin.database('db1').collection('users').doc('u1');
      await ref.delete();

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  describe('onSnapshot()', () => {
    it('should return an unsubscribe function', () => {
      vi.stubGlobal(
        'fetch',
        mockFetchSuccess({ id: 'doc1', data: {} }),
      );

      const ref = admin.database('db1').collection('col').doc('doc1');
      const unsub = ref.onSnapshot(() => {});
      expect(typeof unsub).toBe('function');
    });
  });
});

// ============================================================================
// SyncQuery
// ============================================================================

describe('SyncQuery', () => {
  let admin: RiviumSyncAdmin;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    admin = createAdmin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should support chaining where()', () => {
    const col = admin.database('db1').collection('users');
    const q = col.query().where('age', '>=', 18).where('status', '==', 'active');
    expect(q).toBeInstanceOf(SyncQuery);
  });

  it('should support chaining orderBy()', () => {
    const col = admin.database('db1').collection('users');
    const q = col.query().orderBy('name', 'asc');
    expect(q).toBeInstanceOf(SyncQuery);
  });

  it('should support chaining limit()', () => {
    const col = admin.database('db1').collection('users');
    const q = col.query().limit(25);
    expect(q).toBeInstanceOf(SyncQuery);
  });

  it('should support chaining offset()', () => {
    const col = admin.database('db1').collection('users');
    const q = col.query().offset(10);
    expect(q).toBeInstanceOf(SyncQuery);
  });

  it('should support chaining startAfter() as alias for offset()', () => {
    const col = admin.database('db1').collection('users');
    const q = col.query().startAfter(5);
    expect(q).toBeInstanceOf(SyncQuery);
  });

  it('should support full chaining of all query methods', () => {
    const col = admin.database('db1').collection('users');
    const q = col
      .query()
      .where('age', '>=', 18)
      .where('country', '==', 'US')
      .orderBy('name', 'desc')
      .limit(10)
      .offset(20);
    expect(q).toBeInstanceOf(SyncQuery);
  });

  it('should support all query operators in where()', () => {
    const col = admin.database('db1').collection('items');
    const operators = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains'] as const;
    for (const op of operators) {
      const q = col.query().where('field', op, 'value');
      expect(q).toBeInstanceOf(SyncQuery);
    }
  });

  describe('get()', () => {
    it('should execute the query and return documents', async () => {
      const docs = [
        { id: 'd1', data: { name: 'Alice', age: 25 } },
        { id: 'd2', data: { name: 'Bob', age: 30 } },
      ];
      const fetchSpy = mockFetchSuccess({ documents: docs });
      vi.stubGlobal('fetch', fetchSpy);

      const col = admin.database('db1').collection('users');
      const result = await col.query().where('age', '>=', 18).get();
      expect(result).toEqual(docs);

      // Verify the URL includes filter params
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('filters=');
    });

    it('should pass orderBy and limit to the request', async () => {
      const fetchSpy = mockFetchSuccess({ documents: [] });
      vi.stubGlobal('fetch', fetchSpy);

      const col = admin.database('db1').collection('users');
      await col.query().orderBy('name', 'desc').limit(5).get();

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('orderBy=name');
      expect(url).toContain('orderDirection=desc');
      expect(url).toContain('limit=5');
    });

    it('should pass offset to the request', async () => {
      const fetchSpy = mockFetchSuccess({ documents: [] });
      vi.stubGlobal('fetch', fetchSpy);

      const col = admin.database('db1').collection('users');
      await col.query().offset(15).get();

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('offset=15');
    });
  });

  describe('getFirst()', () => {
    it('should return the first document when results exist', async () => {
      const docs = [
        { id: 'd1', data: { name: 'First' } },
        { id: 'd2', data: { name: 'Second' } },
      ];
      vi.stubGlobal('fetch', mockFetchSuccess({ documents: docs }));

      const col = admin.database('db1').collection('users');
      const result = await col.query().getFirst();
      expect(result).toEqual(docs[0]);
    });

    it('should return null when no results', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ documents: [] }));

      const col = admin.database('db1').collection('users');
      const result = await col.query().getFirst();
      expect(result).toBeNull();
    });
  });

  describe('count()', () => {
    it('should return the number of matching documents', async () => {
      const docs = [
        { id: 'd1', data: {} },
        { id: 'd2', data: {} },
        { id: 'd3', data: {} },
      ];
      vi.stubGlobal('fetch', mockFetchSuccess({ documents: docs }));

      const col = admin.database('db1').collection('users');
      const count = await col.query().count();
      expect(count).toBe(3);
    });

    it('should return 0 for empty results', async () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ documents: [] }));

      const col = admin.database('db1').collection('users');
      const count = await col.query().count();
      expect(count).toBe(0);
    });
  });

  describe('onSnapshot()', () => {
    it('should return an unsubscribe function', () => {
      vi.stubGlobal('fetch', mockFetchSuccess({ documents: [] }));

      const col = admin.database('db1').collection('users');
      const unsub = col.query().where('active', '==', true).onSnapshot(() => {});
      expect(typeof unsub).toBe('function');
    });
  });
});

// ============================================================================
// WriteBatch
// ============================================================================

describe('WriteBatch', () => {
  let admin: RiviumSyncAdmin;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    admin = createAdmin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should start with size 0', () => {
    const batch = admin.batch();
    expect(batch.size).toBe(0);
  });

  it('should increment size after set()', () => {
    const batch = admin.batch();
    const ref = admin.database('db1').collection('users').doc('u1');
    batch.set(ref, { name: 'Alice' });
    expect(batch.size).toBe(1);
  });

  it('should increment size after update()', () => {
    const batch = admin.batch();
    const ref = admin.database('db1').collection('users').doc('u1');
    batch.update(ref, { name: 'Updated' });
    expect(batch.size).toBe(1);
  });

  it('should increment size after delete()', () => {
    const batch = admin.batch();
    const ref = admin.database('db1').collection('users').doc('u1');
    batch.delete(ref);
    expect(batch.size).toBe(1);
  });

  it('should track multiple operations', () => {
    const batch = admin.batch();
    const col = admin.database('db1').collection('users');

    batch.set(col.doc('u1'), { name: 'A' });
    batch.update(col.doc('u2'), { name: 'B' });
    batch.delete(col.doc('u3'));

    expect(batch.size).toBe(3);
  });

  it('should support method chaining for set()', () => {
    const batch = admin.batch();
    const col = admin.database('db1').collection('users');

    const result = batch.set(col.doc('u1'), { name: 'A' });
    expect(result).toBe(batch);
  });

  it('should support method chaining for update()', () => {
    const batch = admin.batch();
    const col = admin.database('db1').collection('users');

    const result = batch.update(col.doc('u1'), { name: 'A' });
    expect(result).toBe(batch);
  });

  it('should support method chaining for delete()', () => {
    const batch = admin.batch();
    const col = admin.database('db1').collection('users');

    const result = batch.delete(col.doc('u1'));
    expect(result).toBe(batch);
  });

  it('should support full method chaining', () => {
    const batch = admin.batch();
    const col = admin.database('db1').collection('users');

    batch
      .set(col.doc('u1'), { name: 'A' })
      .update(col.doc('u2'), { name: 'B' })
      .delete(col.doc('u3'));

    expect(batch.size).toBe(3);
  });

  describe('commit()', () => {
    it('should call executeBatch on the admin instance', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const batch = admin.batch();
      const col = admin.database('db1').collection('users');
      batch.set(col.doc('u1'), { name: 'A' });
      batch.update(col.doc('u2'), { name: 'B' });

      await batch.commit();

      // Two operations: PUT for set, PATCH for update
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should clear operations after commit (size becomes 0)', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const batch = admin.batch();
      const col = admin.database('db1').collection('users');
      batch.set(col.doc('u1'), { name: 'A' });
      expect(batch.size).toBe(1);

      await batch.commit();
      expect(batch.size).toBe(0);
    });

    it('should allow re-use after commit by adding new operations', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const batch = admin.batch();
      const col = admin.database('db1').collection('users');

      batch.set(col.doc('u1'), { name: 'A' });
      await batch.commit();
      expect(batch.size).toBe(0);

      batch.set(col.doc('u2'), { name: 'B' });
      expect(batch.size).toBe(1);
      await batch.commit();
      expect(batch.size).toBe(0);

      // Total fetch calls: 1 from first commit + 1 from second commit
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should handle commit with zero operations gracefully', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const batch = admin.batch();
      await batch.commit();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(batch.size).toBe(0);
    });

    it('should use correct document id from SyncDocumentRef', async () => {
      const fetchSpy = mockFetchSuccess({});
      vi.stubGlobal('fetch', fetchSpy);

      const batch = admin.batch();
      const ref = admin.database('my-db').collection('orders').doc('order-42');
      batch.set(ref, { total: 100 });

      await batch.commit();

      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain('/databases/my-db/collections/orders/documents/sdk/order-42');
    });
  });
});

// ============================================================================
// Full Navigation Chain
// ============================================================================

describe('Full navigation chain: admin.database().collection().doc()', () => {
  let admin: RiviumSyncAdmin;

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    admin = createAdmin();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should navigate from admin to document ref in one chain', () => {
    const ref = admin.database('prod-db').collection('users').doc('user-123');
    expect(ref).toBeInstanceOf(SyncDocumentRef);
    expect(ref.id).toBe('user-123');
    expect(ref.path).toBe('/prod-db/users/user-123');
  });

  it('should create independent references that do not share state', () => {
    const ref1 = admin.database('db1').collection('col1').doc('d1');
    const ref2 = admin.database('db2').collection('col2').doc('d2');

    expect(ref1.id).toBe('d1');
    expect(ref1.path).toBe('/db1/col1/d1');
    expect(ref2.id).toBe('d2');
    expect(ref2.path).toBe('/db2/col2/d2');
  });

  it('should allow building queries from collection in the chain', () => {
    const query = admin
      .database('analytics-db')
      .collection('events')
      .where('type', '==', 'click')
      .orderBy('timestamp', 'desc')
      .limit(50);

    expect(query).toBeInstanceOf(SyncQuery);
  });

  it('should perform async operations through the navigation chain', async () => {
    const mockDoc = { id: 'u1', data: { name: 'Alice' } };
    vi.stubGlobal('fetch', mockFetchSuccess(mockDoc));

    const result = await admin
      .database('app-db')
      .collection('users')
      .doc('u1')
      .get();

    expect(result).toEqual(mockDoc);
  });

  it('should perform set through the navigation chain', async () => {
    const fetchSpy = mockFetchSuccess({});
    vi.stubGlobal('fetch', fetchSpy);

    await admin
      .database('app-db')
      .collection('users')
      .doc('u1')
      .set({ name: 'Bob', email: 'bob@test.com' });

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/databases/app-db/collections/users/documents/sdk/u1');
    expect(options.method).toBe('PUT');
  });

  it('should perform delete through the navigation chain', async () => {
    const fetchSpy = mockFetchSuccess({});
    vi.stubGlobal('fetch', fetchSpy);

    await admin
      .database('app-db')
      .collection('users')
      .doc('u1')
      .delete();

    expect(fetchSpy.mock.calls[0][1].method).toBe('DELETE');
  });
});

// ============================================================================
// Edge Cases & Error Propagation
// ============================================================================

describe('Edge cases', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should propagate HTTP errors through SyncDocumentRef.set()', async () => {
    vi.stubGlobal('fetch', mockFetchFailure(403, 'Forbidden'));

    const admin = createAdmin();
    const ref = admin.database('db1').collection('col').doc('doc1');

    await expect(ref.set({ x: 1 })).rejects.toThrow(RiviumSyncError);
  });

  it('should propagate HTTP errors through SyncDocumentRef.update()', async () => {
    vi.stubGlobal('fetch', mockFetchFailure(500, 'Server Error'));

    const admin = createAdmin();
    const ref = admin.database('db1').collection('col').doc('doc1');

    await expect(ref.update({ x: 2 })).rejects.toThrow(RiviumSyncError);
  });

  it('should propagate HTTP errors through SyncDocumentRef.delete()', async () => {
    vi.stubGlobal('fetch', mockFetchFailure(500, 'Server Error'));

    const admin = createAdmin();
    const ref = admin.database('db1').collection('col').doc('doc1');

    await expect(ref.delete()).rejects.toThrow(RiviumSyncError);
  });

  it('should propagate HTTP errors through SyncCollection.add()', async () => {
    vi.stubGlobal('fetch', mockFetchFailure(400, 'Bad Request'));

    const admin = createAdmin();
    const col = admin.database('db1').collection('col');

    await expect(col.add({ x: 1 })).rejects.toThrow(RiviumSyncError);
  });

  it('should propagate network errors through query.get()', async () => {
    vi.stubGlobal('fetch', mockFetchNetworkError('DNS resolution failed'));

    const admin = createAdmin();
    const col = admin.database('db1').collection('col');

    await expect(col.query().get()).rejects.toThrow(RiviumSyncError);
  });

  it('should propagate errors through WriteBatch.commit()', async () => {
    vi.stubGlobal('fetch', mockFetchFailure(500, 'Internal error'));

    const admin = createAdmin();
    const batch = admin.batch();
    const ref = admin.database('db1').collection('col').doc('d1');
    batch.set(ref, { a: 1 });

    await expect(batch.commit()).rejects.toThrow(RiviumSyncError);
  });

  it('RiviumSyncError should have a stack trace', () => {
    const error = new RiviumSyncError(RiviumSyncErrorCode.UNKNOWN_ERROR);
    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('RiviumSyncError');
  });

  it('should handle special characters in database/collection/document ids', () => {
    const admin = createAdmin();
    const ref = admin
      .database('db-with-dashes')
      .collection('col_with_underscores')
      .doc('doc.with.dots');

    expect(ref.path).toBe('/db-with-dashes/col_with_underscores/doc.with.dots');
  });

  it('should create multiple admins independently', () => {
    const admin1 = createAdmin({ apiKey: 'rv_live_key1aaaaaa' });
    const admin2 = createAdmin({ apiKey: 'rv_live_key2bbbbbb' });

    expect(admin1).not.toBe(admin2);
    expect(admin1).toBeInstanceOf(RiviumSyncAdmin);
    expect(admin2).toBeInstanceOf(RiviumSyncAdmin);
  });
});

// ============================================================================
// Default Base URL
// ============================================================================

describe('RiviumSyncAdmin default base URL', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use https://sync.rivium.co as the base URL for requests', async () => {
    const fetchSpy = mockFetchSuccess({ id: 'x', data: {} });
    vi.stubGlobal('fetch', fetchSpy);

    const admin = createAdmin();
    await admin.getDocument('db1', 'col1', 'doc1');

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url.startsWith('https://sync.rivium.co/')).toBe(true);
  });
});
