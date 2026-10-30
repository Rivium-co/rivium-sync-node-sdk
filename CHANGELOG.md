# Changelog

## 0.3.0

### Breaking

- `set(data)` now replaces the whole document. Before, it
  merged the given fields into the existing document. To keep merging, write
  `set(data, { merge: true })`. The same applies to `batch.set()`.
- `get()` and `add()` return the document itself (`{ id, data, version, … }`).
  Before, it came wrapped in an extra `data` object. If your code read
  `doc.data.data`, read `doc.data`.

### Changes

- Queries (`where`, `orderBy`, `limit`, `offset`) are now applied on the
  server: only the matching documents are read and returned. Before, the
  server did not receive them.
- Listeners (`onSnapshot`) are checked by the database's security rules like
  a read or a query, and receive only what the user may read. The first
  callback is the current data. A query listener keeps its order and limit.
- Fixed listeners never receiving changes.
- `onSnapshot` takes an optional error callback. It receives a
  `QueryNotAllowedError`, a `ListenerRevokedError` (the server ended the
  listener because the user may no longer read what it listens to) or a
  `RiviumSyncError`; the listener is stopped.
- A query the security rules do not allow throws a `QueryNotAllowedError`
  (`RiviumSyncErrorCode.QUERY_NOT_ALLOWED`); its `fields` name the filters the
  rules expect.
- Errors from the Sync API carry `statusCode` (also as `status`; `undefined`
  when the server could not be reached) and `serverCode`.
- `batch.commit()` is atomic: all operations are written together, or none is
  when one is refused (for example by the security rules). Before, they were
  written one by one, and a refused operation left the earlier ones saved.
- Deleting a document that does not exist succeeds.
- `get()` of a document no longer returns `null` for a refused read whose
  message mentions "404"; only a missing document is `null`.
- When the server refuses realtime (`enableRealtime`), for example a wrong
  server secret, every listener's error callback receives the error. Before,
  listeners waited silently. A network error while starting realtime is
  retried.
- Fixed `getAll()` and query `get()` returning an empty list.
- `disconnect()` also stops every listener.

### Fixed

- Realtime fetches a new connection token before the current one expires (24
  hours), so a reconnect after that still logs in. Before, every reconnect
  after the first day was refused.

## 0.2.3

- Realtime (`enableRealtime`) is always encrypted. If the Sync
  API's answer is missing or not an encrypted rivium.co endpoint, the SDK uses
  its built-in encrypted endpoint; it never connects unencrypted.

## 0.2.2

- Realtime (`enableRealtime`) now uses an encrypted connection when
  the Sync API says so. Before, it always connected unencrypted.
- Added `THIRD_PARTY_NOTICES.md`.

## 0.2.1

- Every request to the Sync API now carries `X-Rivium-SDK: node/<version>`,
  so the Console can show which SDK and version a project uses. Realtime
  is unchanged. Exported `SDK_NAME`, `SDK_VERSION` and
  `SDK_HEADER_VALUE`.

## 0.2.0

- Added `createUserToken(userId, expiresIn?)`. Call it from your backend to mint
  a short-lived token for a signed-in user; the client SDKs send it so Security
  Rules can trust `auth.uid`.
- Fixed realtime subscriptions never firing. Topics did not match what the
  server publishes, so `listenCollection` and `listenDocument` stayed silent.
- Corrected the README: keys are `rv_live_` and `rv_srv_`, and credentials come
  from Rivium Console.

## 0.1.0

- First release.
