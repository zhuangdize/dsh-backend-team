/**
 * M2 routing decision for the local health endpoint (pure function).
 *
 * Boundary rules that this module owns (spec R-01, plan D-02/D-03/D-05,
 * clarifications Q-01, Q-02, Q-06):
 *
 *   1. Order is fixed: path first, method second. A request target that is
 *      not the exact string `/health` yields 404 whatever its method, so
 *      404 always takes precedence over 405.
 *   2. Comparison is raw string equality: case sensitive, no percent
 *      decoding, no trailing slash folding, no aliases, no redirects.
 *   3. On `/health`, any method other than `GET` yields 405. HEAD and
 *      OPTIONS are included deliberately (approved ruling Q-01, an
 *      intentional deviation from the RFC convention).
 *
 * No IO and no state: no imports, no I/O handles, no mutable module state,
 * no awareness of sockets or streams. Input normalization happens in the
 * HTTP layer before this function is called; the query string never reaches
 * it because routing is decided on the substring before the first `?`.
 */

/** The only request target served by this feature, as an exact string. */
export const HEALTH_PATH = '/health';

/** The only HTTP method allowed on the health resource. */
const SUCCESS_METHOD = 'GET';

/** Status codes produced by this feature: 200 success, 404 unmatched path, 405 wrong method. */
export const STATUS_OK = 200;
export const STATUS_NOT_FOUND = 404;
export const STATUS_METHOD_NOT_ALLOWED = 405;

/**
 * Decide the status code for one request.
 *
 * @param {string} method request method exactly as presented by `node:http`;
 *   never normalized here, so anything other than the literal `GET` is 405
 *   on the health path and 404 elsewhere.
 * @param {string} path raw request target already truncated at the first
 *   `?`, i.e. the query string is excluded from routing by the caller.
 * @returns {200 | 404 | 405}
 */
export function decide(method, path) {
  if (path !== HEALTH_PATH) return STATUS_NOT_FOUND;
  if (method !== SUCCESS_METHOD) return STATUS_METHOD_NOT_ALLOWED;
  return STATUS_OK;
}
