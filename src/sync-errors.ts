/**
 * Which failures retrying may fix, as in Firestore: only those where the server could not answer for good.
 *
 * Transient: no answer at all (no network, timeout), 401, 408, 429 and 5xx.
 *
 * Anything else is the server's final answer (403 the security rules refused, `query_not_allowed`, 400 / 409 / 413 /
 * 422 invalid, 404 not found): it reaches the caller and is never retried.
 */
import { RiviumSyncError, RiviumSyncErrorCode } from './index';

export function isTransientError(error: unknown): boolean {
  if (error instanceof RiviumSyncError) {
    if (error.serverCode === 'query_not_allowed') return false;
    const status = error.status;
    if (status !== undefined) return status === 401 || status === 408 || status === 429 || status >= 500;
    // No status: the server did not answer, or it is the SDK's own error (bad answer, revoked listener).
    // (Read here, not at load: index.ts imports this module.)
    switch (error.code) {
      case RiviumSyncErrorCode.CONNECTION_FAILED:
      case RiviumSyncErrorCode.CONNECTION_TIMEOUT:
      case RiviumSyncErrorCode.CONNECTION_LOST:
      // request(): fetch itself failed (DNS, refused, reset); an answer from the server always carries `status`.
      case RiviumSyncErrorCode.DATA_FETCH_FAILED:
        return true;
      default:
        return false;
    }
  }
  // A TypeError from fetch, an AbortError and the like: the request did not get through.
  return true;
}
