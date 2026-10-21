# Changelog

## Unreleased

- Every request to the Sync API now carries `X-Rivium-SDK: node/<version>`,
  so the Console can show which SDK and version a project uses. Realtime
  (MQTT) is unchanged. Exported `SDK_NAME`, `SDK_VERSION` and
  `SDK_HEADER_VALUE` (`src/version.ts`, generated from package.json by
  `scripts/gen-version.mjs` before build and test).

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
