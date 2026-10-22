# Changelog

## 0.2.3

- Realtime (`enableRealtime`) is always encrypted (`mqtts`). If the Sync
  API's answer is missing or not an encrypted rivium.co endpoint, the SDK uses
  its built-in encrypted endpoint; it never connects unencrypted.

## 0.2.2

- Realtime (`enableRealtime`) now uses an encrypted connection (`mqtts`) when
  the Sync API says so. Before, it always connected unencrypted.
- Added `THIRD_PARTY_NOTICES.md`.

## 0.2.1

- Every request to the Sync API now carries `X-Rivium-SDK: node/<version>`,
  so the Console can show which SDK and version a project uses. Realtime
  (MQTT) is unchanged. Exported `SDK_NAME`, `SDK_VERSION` and
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
