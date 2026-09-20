# @rivium/sync-node

Official Node.js SDK for RiviumSync Realtime Database. Designed for server-side applications with admin-level access.

## Features

- **Server-side access** - Authenticates with your server secret, not an app key
- **Full CRUD operations** - Create, read, update, delete documents
- **Query support** - Filters, sorting, pagination
- **Batch operations** - Atomic writes across multiple documents
- **Optional realtime** - MQTT-based subscriptions when needed
- **TypeScript** - Full type definitions included

## Installation

```bash
# npm
npm install @rivium/sync-node

# yarn
yarn add @rivium/sync-node

# pnpm
pnpm add @rivium/sync-node
```

## Quick Start

```typescript
import { RiviumSyncAdmin } from '@rivium/sync-node';

// Initialize with your Project API Key and Server Secret
const riviumSync = new RiviumSyncAdmin({
  apiKey: process.env.RIVIUM_SYNC_API_KEY,           // rv_live_xxx
  serverSecret: process.env.RIVIUM_SYNC_SERVER_SECRET, // rv_srv_xxx - Required for server-side operations
});

// Get a database reference (database must be created via dashboard first)
const db = riviumSync.database('your-database-id');

// Get a collection reference
const users = db.collection('users');
```

> **Note:** Both `apiKey` and `serverSecret` are required for all server-side SDK operations. You can find these credentials in [Rivium Console](https://console.rivium.co) when you create a project. Database creation and deletion is managed via the dashboard, not via SDK.

## CRUD Operations

### Create a Document

```typescript
// Add with auto-generated ID
const newUser = await users.add({
  name: 'John Doe',
  email: 'john@example.com',
  age: 28,
  createdAt: new Date().toISOString(),
});
console.log('Created user with ID:', newUser.id);

// Set with specific ID
await users.doc('user-123').set({
  name: 'Jane Doe',
  email: 'jane@example.com',
});
```

### Read Documents

```typescript
// Get a single document
const user = await users.get('user-123');
if (user) {
  console.log('User name:', user.data.name);
}

// Check if document exists
const exists = await users.doc('user-123').exists();

// Get all documents
const allUsers = await users.getAll();
console.log('Total users:', allUsers.length);
```

### Update Documents

```typescript
// Partial update (merge)
await users.doc('user-123').update({
  age: 29,
  updatedAt: new Date().toISOString(),
});

// Full replace
await users.doc('user-123').set({
  name: 'John Updated',
  email: 'john.new@example.com',
  age: 29,
});
```

### Delete Documents

```typescript
await users.doc('user-123').delete();
```

## Querying

```typescript
// Build queries with fluent API
const adults = await users
  .where('age', '>=', 18)
  .where('status', '==', 'active')
  .orderBy('createdAt', 'desc')
  .limit(20)
  .get();

// Get first result only
const firstUser = await users
  .where('email', '==', 'john@example.com')
  .query()
  .getFirst();

// Count matching documents
const activeCount = await users
  .where('status', '==', 'active')
  .query()
  .count();

// Pagination
const page1 = await users.orderBy('name').limit(10).get();
const page2 = await users.orderBy('name').limit(10).offset(10).get();
```

### Available Query Operators

| Operator | Description |
|----------|-------------|
| `==` | Equal |
| `!=` | Not equal |
| `<` | Less than |
| `<=` | Less than or equal |
| `>` | Greater than |
| `>=` | Greater than or equal |
| `in` | Value in array |
| `not-in` | Value not in array |
| `array-contains` | Array contains value |

## Batch Operations

Execute multiple writes atomically:

```typescript
const batch = riviumSync.batch();

// Add operations to the batch
batch.set(users.doc('user1'), { name: 'User 1', status: 'active' });
batch.update(users.doc('user2'), { lastSeen: new Date().toISOString() });
batch.delete(users.doc('user3'));

// Commit all operations
await batch.commit();
```

## Realtime Updates (Optional)

Enable realtime subscriptions for server-side event processing:

```typescript
const riviumSync = new RiviumSyncAdmin({
  apiKey: process.env.RIVIUM_SYNC_API_KEY!,
  serverSecret: process.env.RIVIUM_SYNC_SERVER_SECRET!,
  enableRealtime: true, // Enable MQTT connection
});

// Listen to a single document
const unsubscribe = users.doc('user-123').onSnapshot((user) => {
  if (user) {
    console.log('User updated:', user.data);
  } else {
    console.log('User was deleted');
  }
});

// Listen to a collection
const unsubscribeAll = users.onSnapshot((allUsers) => {
  console.log('Users changed, count:', allUsers.length);
});

// Listen to query results
const unsubscribeQuery = users
  .where('status', '==', 'online')
  .onSnapshot((onlineUsers) => {
    console.log('Online users:', onlineUsers.length);
  });

// Stop listening when done
unsubscribe();
unsubscribeAll();
unsubscribeQuery();
```

## User Tokens

Your app's Security Rules check `auth.uid`. A browser or phone cannot be
trusted to say who the user is - the API key it ships with is public - so your
backend mints a short-lived token for the user it has already signed in, and
the client SDK sends it:

```typescript
// In your backend, behind your own session check:
app.post('/rivium-sync-token', async (req, res) => {
  const { token, expiresIn } = await riviumSync.createUserToken(req.session.userId);
  res.json({ token, expiresIn });
});
```

The client passes that to its `tokenProvider` option. Tokens last an hour by
default; pass a second argument in seconds to change it, up to 24 hours.

This SDK holds the server secret, so it is already trusted and never needs a
token of its own.

## Configuration Options

```typescript
const riviumSync = new RiviumSyncAdmin({
  // Required
  apiKey: 'rv_live_xxxxxxxxxxxxxxxxxxxxx',        // Required - from Rivium Console
  serverSecret: 'rv_srv_xxxxxxxxxxxxxxxxxxxxx',   // Required - from Rivium Console

  // Optional
  enableRealtime: false, // Enable MQTT subscriptions
  logLevel: RiviumSyncLogLevel.ERROR, // Logging level
  timeout: 30000, // Request timeout in ms
});
```

### Credentials

| Credential | Format | Description |
|------------|--------|-------------|
| **API Key** | `rv_live_xxx` | Used for client-side SDKs and server-side SDKs |
| **Server Secret** | `rv_srv_xxx` | **Required** for server-side operations. Never expose in client-side code. |

Both credentials are generated when you create a project in [Rivium Console](https://console.rivium.co). Store them securely and never commit them to version control.

### Log Levels

```typescript
import { RiviumSyncLogLevel } from '@rivium/sync-node';

RiviumSyncLogLevel.NONE    // No logs
RiviumSyncLogLevel.ERROR   // Only errors
RiviumSyncLogLevel.WARNING // Errors and warnings
RiviumSyncLogLevel.INFO    // General info
RiviumSyncLogLevel.DEBUG   // Debug info
RiviumSyncLogLevel.VERBOSE // Everything
```

## TypeScript Support

Full TypeScript support with generics:

```typescript
interface User {
  name: string;
  email: string;
  age: number;
  status: 'active' | 'inactive';
}

const users = db.collection<User>('users');

// All operations are now typed
const newUser = await users.add({
  name: 'John',
  email: 'john@example.com',
  age: 28,
  status: 'active',
});

// Type inference works
const user = await users.get('user-123');
if (user) {
  console.log(user.data.name); // string
  console.log(user.data.age);  // number
}
```

## Error Handling

```typescript
import { RiviumSyncError, RiviumSyncErrorCode } from '@rivium/sync-node';

try {
  await users.get('nonexistent-id');
} catch (error) {
  if (error instanceof RiviumSyncError) {
    console.error('Error code:', error.code);
    console.error('Message:', error.message);
    console.error('Details:', error.details);

    if (error.code === RiviumSyncErrorCode.DOCUMENT_NOT_FOUND) {
      // Handle not found
    }
  }
}
```

## Use Cases

### Backend API Server

```typescript
// Express.js example
import express from 'express';
import { RiviumSyncAdmin } from '@rivium/sync-node';

const app = express();
const riviumSync = new RiviumSyncAdmin({
  apiKey: process.env.RIVIUM_SYNC_API_KEY!,
  serverSecret: process.env.RIVIUM_SYNC_SERVER_SECRET!,
});
const db = riviumSync.database('my-database');

app.get('/api/users', async (req, res) => {
  const users = await db.collection('users').getAll();
  res.json(users);
});

app.post('/api/users', async (req, res) => {
  const user = await db.collection('users').add(req.body);
  res.json(user);
});
```

### Serverless Functions

```typescript
// AWS Lambda example
import { RiviumSyncAdmin } from '@rivium/sync-node';

const riviumSync = new RiviumSyncAdmin({
  apiKey: process.env.RIVIUM_SYNC_API_KEY!,
  serverSecret: process.env.RIVIUM_SYNC_SERVER_SECRET!,
});

export async function handler(event) {
  const db = riviumSync.database('my-database');
  const users = await db.collection('users')
    .where('status', '==', 'active')
    .get();

  return {
    statusCode: 200,
    body: JSON.stringify(users),
  };
}
```

### Data Migration Script

```typescript
import { RiviumSyncAdmin } from '@rivium/sync-node';

const riviumSync = new RiviumSyncAdmin({
  apiKey: process.env.RIVIUM_SYNC_API_KEY!,
  serverSecret: process.env.RIVIUM_SYNC_SERVER_SECRET!,
});
const db = riviumSync.database('my-database');

async function migrate() {
  const users = await db.collection('users').getAll();

  const batch = riviumSync.batch();
  for (const user of users) {
    // Add migration logic
    batch.update(db.collection('users').doc(user.id), {
      migratedAt: new Date().toISOString(),
      version: 2,
    });
  }

  await batch.commit();
  console.log('Migration complete!');
}

migrate();
```

## API Reference

### RiviumSyncAdmin

| Method | Description |
|--------|-------------|
| `database(id)` | Get a database reference |
| `batch()` | Create a write batch |
| `disconnect()` | Disconnect from realtime |
| `setLogLevel(level)` | Change log level |

### SyncDatabase

| Method | Description |
|--------|-------------|
| `collection<T>(id)` | Get a typed collection reference |

### SyncCollection

| Method | Description |
|--------|-------------|
| `doc(id)` | Get a document reference |
| `add(data)` | Create document with auto ID |
| `get(id)` | Get a single document |
| `getAll(options?)` | Get all documents |
| `where(field, op, value)` | Start a query |
| `orderBy(field, direction?)` | Start a sorted query |
| `limit(count)` | Start a limited query |
| `query()` | Get query builder |
| `onSnapshot(callback, options?)` | Listen to changes |

### SyncDocumentRef

| Method | Description |
|--------|-------------|
| `get()` | Get document data |
| `exists()` | Check if document exists |
| `set(data)` | Set document (overwrite) |
| `update(data)` | Update document (merge) |
| `delete()` | Delete document |
| `onSnapshot(callback)` | Listen to changes |

### SyncQuery

| Method | Description |
|--------|-------------|
| `where(field, op, value)` | Add filter |
| `orderBy(field, direction?)` | Set ordering |
| `limit(count)` | Limit results |
| `offset(count)` | Skip results |
| `startAfter(count)` | Alias for offset |
| `get()` | Execute query |
| `getFirst()` | Get first result |
| `count()` | Count results |
| `onSnapshot(callback)` | Listen to query |

### WriteBatch

| Method | Description |
|--------|-------------|
| `set(docRef, data)` | Add set operation |
| `update(docRef, data)` | Add update operation |
| `delete(docRef)` | Add delete operation |
| `commit()` | Execute all operations |
| `size` | Number of pending operations |

## License

MIT
