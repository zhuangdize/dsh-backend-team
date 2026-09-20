/**
 * M1 + M3 — HTTP handler and startup entry for the local health endpoint.
 *
 * Approved surface only: one request target (`/health`), one allowed method
 * (`GET`), three outcomes (200 / 404 / 405). Routing is delegated to the pure
 * decision function in ./health-decide.mjs, so this file owns only request
 * target extraction, response writing and the listening socket.
 *
 * Constraints encoded here (spec R-02, R-03; plan D-04, D-08; clarifications
 * Q-05, Q-06, Q-07):
 *   - The routing path is the substring of `req.url` before the first `?`; the
 *     query string never takes part in routing and nothing is decoded.
 *   - Success writes `Content-Type: application/json` plus the frozen 11-byte
 *     literal body below; no serializer is involved, so no whitespace, BOM or
 *     dynamic field can slip in.
 *   - 404 and 405 are asserted (and implemented) as "status code plus complete
 *     termination": no error body and no `Allow` header is promised.
 *   - No request content is ever echoed, retained or logged.
 *   - The listening address is a code constant: the IPv4 loopback literal
 *     `127.0.0.1` on TCP port `3001`. There is no environment variable or
 *     command-line override, no wildcard-interface bind, and the IPv6 loopback
 *     is not listened on (attempts there fail by design, outside acceptance).
 *
 * Node.js built-in modules only; no dependencies and no install step (AC-004).
 */

import { createServer } from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { decide, STATUS_OK, HEALTH_PATH } from './health-decide.mjs';

/** Approved IPv4 loopback literal; a code constant, not configuration. */
const HOST = '127.0.0.1';
/** Approved TCP port; a code constant, not configuration. */
const PORT = 3001;

/** Frozen success body: exactly 11 bytes, written verbatim without a serializer. */
const HEALTH_BODY_BYTES = Buffer.from('{"ok":true}', 'utf8');
/** Bare media type of the success response. */
const HEALTH_CONTENT_TYPE = 'application/json';

/**
 * Extract the routing request target: the substring before the first `?`.
 * No percent decoding, no trailing-slash folding, no case folding.
 *
 * @param {string | undefined} rawUrl
 * @returns {string}
 */
export function requestPathOf(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const queryIndex = rawUrl.indexOf('?');
  return queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
}

/**
 * M3 — write the response for one request. Mutually exclusive outcomes, each
 * fully terminated with `res.end()`; no branch echoes anything from the request.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export function handleHealthRequest(req, res) {
  // Drain any request body without inspecting or retaining it (no echo, no state).
  if (typeof req.resume === 'function') req.resume();

  const status = decide(req.method, requestPathOf(req.url));

  if (status === STATUS_OK) {
    res.statusCode = STATUS_OK;
    res.setHeader('Content-Type', HEALTH_CONTENT_TYPE);
    res.setHeader('Content-Length', String(HEALTH_BODY_BYTES.length));
    res.end(HEALTH_BODY_BYTES);
    return;
  }

  // 404 (request target not matched exactly, always evaluated first) and 405
  // (non-GET method on the matched resource). Status code and complete
  // termination only: an error body and an `Allow` header are out of scope.
  res.statusCode = status;
  res.setHeader('Content-Length', '0');
  res.end();
}

/**
 * Create the server without binding it. Exported so the suite can drive its
 * own lifecycle; on its own it never touches the fixed address.
 *
 * @returns {import('node:http').Server}
 */
export function createHealthServer() {
  const server = createServer(handleHealthRequest);
  // Node routes CONNECT separately from ordinary request events.
  server.on('connect', (req, socket) => {
    const status = decide(req.method, requestPathOf(req.url));
    const reason = status === 404 ? 'Not Found' : 'Method Not Allowed';
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  });
  return server;
}

/**
 * Single bind site. The host argument is always supplied explicitly, because
 * a port-only bind would silently widen to every interface.
 *
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<import('node:http').Server>}
 */
function bindToLoopback(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/**
 * Production bind: the fixed, code-constant loopback address. Deliberately
 * takes no arguments, so no caller can widen the bind surface.
 *
 * @param {import('node:http').Server} server
 * @returns {Promise<import('node:http').Server>}
 */
export function listenOnApprovedAddress(server) {
  return bindToLoopback(server, PORT, HOST);
}

/**
 * Test seam (plan D-08): only the port is injectable, `0` requesting an
 * ephemeral port so the suite never competes for the fixed one. The host is
 * never a parameter: every bind, production or test, uses the frozen loopback
 * constant (R-03). This is an internal factory argument, not an external
 * setting — no environment variable and no CLI value reaches it.
 *
 * @param {import('node:http').Server} [server]
 * @param {{ port?: number }} [options]
 * @returns {Promise<import('node:http').Server>}
 */
export async function startHealthServer(server = createHealthServer(), options = {}) {
  const { port = PORT } = options;
  return bindToLoopback(server, port, HOST);
}

/**
 * Entry point used by `node src/health-server.mjs`.
 *
 * A bind failure such as EADDRINUSE exits non-zero immediately: no retry, no
 * port fallback, no silent re-bind. `server.close()` or process exit releases
 * the port (F-03).
 *
 * @returns {Promise<import('node:http').Server>}
 */
export async function main() {
  const server = createHealthServer();
  try {
    await listenOnApprovedAddress(server);
  } catch (err) {
    process.exitCode = 1;
    process.stderr.write(`health-server: bind failed on ${HOST}:${PORT} (${/** @type {Error} */ (err).message})\n`);
    return server;
  }
  const shutdown = () => {
    // F-03: drop idle and in-flight connections so close() cannot be held open
    // by a client keep-alive session; the port is then released immediately.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

// Module entry detection only: compares the invoked script path with this
// file's own URL. No address or port is read from the command line.
const invokedScript = process.argv[1];
if (invokedScript !== undefined && pathToFileURL(invokedScript).href === import.meta.url) {
  void main();
}

export { HOST, PORT, HEALTH_PATH };
