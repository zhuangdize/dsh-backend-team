/**
 * Acceptance suite for vertical slice S-health (feature gui-workflow-acceptance).
 *
 * Tooling (OSS-03): `node:test` + `node:assert/strict` + `node:http` client only,
 * against an ephemeral loopback port (listen(0), plan D-08/Q-09). The fixed
 * production address 127.0.0.1:3001 is never bound here; it is asserted only as
 * source literals (AC-004). The host runs the production entry as a separate
 * manual smoke step (T-106), which this file must not simulate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHealthServer, startHealthServer, HOST, PORT } from '../src/health-server.mjs';
import { decide } from '../src/health-decide.mjs';

const FROZEN_BODY = Buffer.from('{"ok":true}', 'utf8');

/** Bind a fresh server on an ephemeral loopback port and auto-close it. */
async function serverFor(t) {
  const server = await startHealthServer(createHealthServer(), { port: 0 });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  // R-03/AC-004 runtime confirmation: only the IPv4 loopback is served.
  assert.equal(server.address().address, '127.0.0.1');
  return server;
}

/** Issue one HTTP request to the ephemeral server and read it to completion. */
function request(server, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, agent: false },
      res => {
        const parts = [];
        res.on('data', part => parts.push(part));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(parts),
          complete: res.complete,
        }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function mediaType(value) {
  return String(value).split(';')[0].trim().toLowerCase();
}

function assertNoEcho(response, token) {
  assert.ok(!response.body.includes(token), 'request content echoed in body');
  for (const [name, raw] of Object.entries(response.headers)) {
    const joined = Array.isArray(raw) ? raw.join(',') : String(raw);
    assert.ok(!joined.includes(token), `request content echoed in header ${name}`);
  }
}

/* ------------------------------------------------------------------ *
 * T-101  V-01 / V-02 — AC-001 success path
 * ------------------------------------------------------------------ */
test('V-01: GET /health returns the byte-frozen 200 constant', async t => {
  const server = await serverFor(t);
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const r = await request(server, 'GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(Buffer.compare(r.body, FROZEN_BODY), 0);
    assert.equal(Buffer.byteLength(r.body), 11);
    assert.equal(mediaType(r.headers['content-type']), 'application/json');
    assert.equal(r.complete, true, 'response must fully terminate');
  }
});

test('V-02: query string is not routed and repeat/concurrent answers are identical', async t => {
  const server = await serverFor(t);
  // GET /health?a=1 follows the success path (Q-06).
  const q = await request(server, 'GET', '/health?a=1');
  assert.equal(q.status, 200);
  assert.equal(Buffer.compare(q.body, FROZEN_BODY), 0);
  assert.equal(Buffer.byteLength(q.body), 11);
  assert.equal(mediaType(q.headers['content-type']), 'application/json');
  assert.equal(q.complete, true);

  // Two plain repeats.
  const a = await request(server, 'GET', '/health');
  const b = await request(server, 'GET', '/health');

  // Ten concurrent requests carrying a token that must never be echoed back.
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, (_, i) => request(server, 'GET', `/health?echo=secret${i}zz`)),
  );

  for (const r of [a, b, q, ...concurrent]) {
    assert.equal(r.status, 200);
    assert.equal(Buffer.compare(r.body, FROZEN_BODY), 0);
    assert.equal(Buffer.byteLength(r.body), 11);
    assert.equal(r.complete, true);
    assertNoEcho(r, 'secret');
    assertNoEcho(r, 'zz');
  }
});

/* ------------------------------------------------------------------ *
 * T-103  V-03 — AC-002 pure decide() unit tests (no normalization)
 * ------------------------------------------------------------------ */
test('V-03: decide() is case-sensitive and never normalizes the path', () => {
  assert.equal(decide('GET', '/health'), 200);
  for (const path of ['/', '/health/', '/HEALTH', '/healthz', '/health%20', '%68ealth']) {
    assert.equal(decide('GET', path), 404, `expected 404 for ${path}`);
  }
  // Method is checked only after the path matched; ordering is fixed (D-02/D-03).
  assert.equal(decide('POST', '/healthz'), 404);
  assert.equal(decide('POST', '/health'), 405);
});

/* ------------------------------------------------------------------ *
 * T-104  V-04 — AC-002 HTTP equivalence: 404 beats 405
 * ------------------------------------------------------------------ */
for (const [method, path] of [
  ['GET', '/'],
  ['GET', '/health/'],
  ['GET', '/HEALTH'],
  ['GET', '/healthz'],
  ['GET', '/%68ealth'],
  ['POST', '/nope'],
]) {
  test(`V-04: ${method} ${path} is 404 (path checked before method)`, async t => {
    const r = await request(await serverFor(t), method, path);
    assert.equal(r.status, 404);
    assert.notEqual(r.status, 405);
    assert.equal(r.complete, true);
  });
}

/* ------------------------------------------------------------------ *
 * T-102  V-05 — AC-003 wrong method on the known resource
 * ------------------------------------------------------------------ */
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
  test(`V-05: ${method} /health is 405 (HEAD/OPTIONS do not fall through to 200, Q-01)`, async t => {
    const r = await request(await serverFor(t), method, '/health');
    assert.equal(r.status, 405);
    // Q-05: body, Content-Type and Allow are intentionally NOT asserted.
    assert.equal(r.complete, true, 'response must fully terminate');
  });
}

/* ------------------------------------------------------------------ *
 * T-102  V-08 — AC-003 close releases the port
 * ------------------------------------------------------------------ */
test('V-08: server.close() frees the port so it can be re-bound', async () => {
  const first = await startHealthServer(createHealthServer(), { port: 0 });
  const { port } = first.address();
  assert.ok(port > 0);
  await new Promise(resolve => { first.closeAllConnections(); first.close(resolve); });
  const second = await startHealthServer(createHealthServer(), { port });
  try {
    assert.equal(second.address().port, port, 'same port re-acquired after release');
    assert.equal(second.address().address, '127.0.0.1');
  } finally {
    await new Promise(resolve => { second.closeAllConnections(); second.close(resolve); });
  }
});

/* ------------------------------------------------------------------ *
 * T-105  V-06 / V-07 — AC-004 config literals + dependency surface
 * ------------------------------------------------------------------ */
test('V-06/V-07: loopback code constants, no wildcard/env/CLI override, node-only imports', async () => {
  assert.equal(HOST, '127.0.0.1');
  assert.equal(PORT, 3001);

  const serverSrc = await readFile(new URL('../src/health-server.mjs', import.meta.url), 'utf8');
  const decideSrc = await readFile(new URL('../src/health-decide.mjs', import.meta.url), 'utf8');

  // The single bind site exists and is driven by the frozen loopback literals.
  assert.match(serverSrc, /\.listen\s*\(/, 'no listen() call found');
  assert.match(serverSrc, /'127\.0\.0\.1'/, 'loopback literal 127.0.0.1 missing');
  assert.match(serverSrc, /\b3001\b/, 'port literal 3001 missing');
  assert.match(serverSrc, /bindToLoopback\(\s*server\s*,\s*PORT\s*,\s*HOST\s*\)/, 'production bind does not pass HOST/PORT to listen');
  assert.match(serverSrc, /const\s+HOST\s*=\s*'127\.0\.0\.1'\s*;/, 'HOST is not a frozen code constant');
  assert.match(serverSrc, /const\s+PORT\s*=\s*3001\s*;/, 'PORT is not a frozen code constant');

  // Every bind site — production and the D-08 test seam alike — is driven by
  // the frozen HOST constant, so no caller can widen the interface (R-03).
  const bindArgs = [...serverSrc.matchAll(/\breturn\s+bindToLoopback\s*\(([^)]*)\)/g)]
    .map(m => m[1].replace(/\s+/g, ' ').trim());
  assert.ok(bindArgs.length >= 2, `expected production and test bind sites, found ${bindArgs.length}`);
  for (const args of bindArgs) {
    assert.match(args, /,\s*HOST$/, `bind site must pass HOST: bindToLoopback(${args})`);
  }
  // Only the port is injectable; there is no host option to override.
  assert.doesNotMatch(serverSrc, /host\s*=\s*options|\bhost\s*:\s*(?:options|opts)\b/, 'host is injectable');

  // No wildcard interface, no IPv6 loopback listener (R-03, Q-07).
  assert.doesNotMatch(serverSrc, /0\.0\.0\.0/, 'wildcard bind literal present');
  assert.doesNotMatch(serverSrc, /::1/, 'IPv6 loopback bind literal present');

  // No environment-variable or CLI override of host/port (Q-07). Only argv[1]
  // may be read, and solely for module-entry detection.
  assert.doesNotMatch(serverSrc, /process\.env/, 'reads process.env for host/port');
  assert.doesNotMatch(serverSrc, /process\.argv\s*\[\s*[2-9]/, 'reads a CLI argument beyond the entry check');
  assert.doesNotMatch(serverSrc, /argv\.(slice|forEach|find|values)\b/, 'parses CLI arguments');

  // The pure decision module has no IO surface at all (T-001).
  assert.doesNotMatch(decideSrc, /\bimport\b/, 'health-decide.mjs must not import anything');
  assert.doesNotMatch(decideSrc, /process\.|require\(|readFile|createServer/, 'health-decide.mjs touches IO');

  // Import surface: node: builtins or the local feature module only (AC-004).
  for (const [label, src] of [['health-server.mjs', serverSrc], ['health-decide.mjs', decideSrc]]) {
    for (const m of src.matchAll(/(?:^|\n)\s*import\b[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('node:') || spec === './health-decide.mjs',
        `${label} has a non-built-in, non-local import: ${spec}`);
    }
    assert.doesNotMatch(src, /\brequire\s*\(/, `${label} uses require()`);
  }
});

/* ------------------------------------------------------------------ *
 * T-004  V-10 — Contract baseline: structural checks of openapi.yaml
 *
 * No YAML/OpenAPI validator is bundled with Node.js and installing one is
 * forbidden (OSS-05 / U-1), so the agreed structure is verified with a
 * deterministic, indentation-aware line scan of the approved document.
 * ------------------------------------------------------------------ */
const CONTRACT_URL = '../specs/gui-workflow-acceptance/contracts/openapi.yaml';

test('V-10: openapi.yaml records the approved single-path, method-matrix contract', async () => {
  const yaml = await readFile(new URL(CONTRACT_URL, import.meta.url), 'utf8');

  // Root-level security: explicitly empty, with no invented scheme.
  assert.match(yaml, /^security:[ \t]*\[\][ \t]*$/m, 'root security: [] missing');
  assert.doesNotMatch(yaml, /securitySchemes[ \t]*:/, 'securitySchemes must not be declared');

  // Servers: exactly one url, the loopback literal. Only the machine-readable
  // `url:` values are inspected; the servers block description deliberately
  // mentions "::1" as prose about out-of-scope IPv6, so prose is excluded here.
  const srvStart = yaml.indexOf('\nservers:');
  const secStart = yaml.indexOf('\nsecurity:');
  assert.ok(srvStart !== -1 && secStart !== -1 && srvStart < secStart, 'servers block not found before security');
  const serversBlock = yaml.slice(srvStart, secStart);
  const urls = [...serversBlock.matchAll(/url:[ \t]*(\S+)/g)].map(m => m[1]);
  assert.deepEqual(urls, ['http://127.0.0.1:3001'], 'servers must be exactly the loopback literal');
  for (const u of urls) {
    assert.doesNotMatch(u, /0\.0\.0\.0|::1|localhost/, `server url must not be wildcard/IPv6/named host: ${u}`);
  }

  // Paths: only /health, with its 7 approved operations.
  const pStart = yaml.indexOf('\npaths:');
  const cStart = yaml.indexOf('\ncomponents:');
  assert.ok(pStart !== -1 && cStart !== -1 && pStart < cStart, 'paths block not found before components');
  const pathsRegion = yaml.slice(pStart, cStart);
  const pathKeys = [...pathsRegion.matchAll(/^ {2}(\/[^\s:]*):[ \t]*$/gm)].map(m => m[1]);
  assert.deepEqual(pathKeys, ['/health'], 'paths must contain only /health');

  const hStart = pathsRegion.indexOf('/health:');
  const healthBlock = pathsRegion.slice(hStart);
  const methodNames = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  for (const m of methodNames) {
    assert.match(healthBlock, new RegExp(`^ {4}${m}:[ \\t]*$`, 'm'), `operation ${m} missing`);
  }
  assert.doesNotMatch(healthBlock, /^ {4}(trace|connect):[ \t]*$/m, 'unapproved method operation present');
  assert.equal([...healthBlock.matchAll(/^ {4}(get|post|put|patch|delete|head|options):[ \t]*$/gm)].length, 7,
    'exactly 7 method operations expected');

  const methodSlice = name => {
    const mm = healthBlock.match(new RegExp(`^ {4}${name}:[ \\t]*$`, 'm'));
    const start = mm.index + mm[0].length;
    const rest = healthBlock.slice(start);
    const next = rest.search(/^ {4}\S/m);
    return next === -1 ? rest : rest.slice(0, next);
  };

  const getBlock = methodSlice('get');
  assert.ok(/"200":/.test(getBlock) && !/"405":/.test(getBlock), 'get must map to 200 only');
  assert.ok(getBlock.includes('#/components/responses/HealthFound'), 'get must reference HealthFound');
  for (const m of methodNames.filter(x => x !== 'get')) {
    const blk = methodSlice(m);
    assert.ok(/"405":/.test(blk) && !/"200":/.test(blk), `${m} must map to 405 only`);
    assert.ok(blk.includes('#/components/responses/MethodNotAllowed'), `${m} must reference MethodNotAllowed`);
  }

  // 404 is a global rule carried only by the document-level extension; the
  // NotFound component is declared for traceability but referenced by no path.
  assert.match(yaml, /^x-unmatched-path-rule:[ \t]*$/m, 'x-unmatched-path-rule missing');
  const ruleRegion = yaml.slice(yaml.indexOf('x-unmatched-path-rule:'));
  assert.match(ruleRegion, /status-code:[ \t]*404/, 'unmatched-path rule must declare 404');
  assert.ok(!pathsRegion.includes('NotFound'), 'paths must not reference NotFound');
  assert.ok(!/"404":/.test(healthBlock), 'no path operation may attach a 404 response');
  assert.match(yaml, /^ {4}NotFound:[ \t]*$/m, 'NotFound component should be declared for traceability');
  assert.equal((yaml.match(/['"]#\/components\/responses\/NotFound['"]/g) || []).length, 0,
    'NotFound must not be referenced by any path');
});

/* ------------------------------------------------------------------ *
 * T-004 addendum — opportunistic external YAML parser evidence.
 *
 * The task records a validator result only "if the consumer environment already
 * ships one", and installing anything is forbidden (OSS-05 / U-1, install=false),
 * so this probe merely looks for an already present YAML parser. It never claims
 * that a parser is absent from the machine: an unreadable resolution attempt
 * (MODULE_NOT_FOUND or a sandbox ERR_ACCESS_DENIED) is recorded as
 * "not reachable from this runner", which is all this suite can honestly state.
 * When a parser is reachable, its real parse result replaces the line scan.
 * ------------------------------------------------------------------ */
const YAML_PARSER_CANDIDATES = ['yaml', 'js-yaml'];

test('V-10 (tooling addendum): use an already-present YAML parser when reachable, else record that fact', t => {
  let requireFromProject;
  try {
    requireFromProject = createRequire(import.meta.url);
  } catch (err) {
    t.diagnostic(`module resolution unavailable on this runner: ${err && (err.code || err.message)}`);
  }

  let parserName = null;
  if (requireFromProject) {
    for (const candidate of YAML_PARSER_CANDIDATES) {
      try {
        requireFromProject.resolve(candidate);
        parserName = candidate;
        break;
      } catch (err) {
        t.diagnostic(`YAML parser candidate not reachable from this runner: ${candidate} (${err && (err.code || err.message)}); absence and sandbox read restriction are indistinguishable here`);
      }
    }
  }

  if (parserName === null) {
    // Honest negative record: nothing was installed and no parser result exists.
    t.diagnostic('no external YAML/OpenAPI tool could be exercised from this runner; no dependency was installed (OSS-05/U-1). The recorded contract evidence is the indentation-aware line scan in the previous test plus the manual reading of the artifact.');
    assert.ok(true);
    return;
  }

  t.diagnostic(`parsing the contract with the pre-existing parser module "${parserName}"`);
  const source = readFileSync(new URL(CONTRACT_URL, import.meta.url), 'utf8');
  const mod = requireFromProject(parserName);
  const doc = parserName === 'yaml'
    ? (typeof mod.parse === 'function' ? mod.parse(source) : mod.YAML.parse(source))
    : mod.load(source);

  assert.equal(typeof doc, 'object');
  assert.deepEqual(doc.security, [], 'root security must be the empty array');
  assert.equal(doc.components.securitySchemes, undefined, 'no securitySchemes may exist');
  assert.deepEqual(doc.servers.map(s => s.url), ['http://127.0.0.1:3001']);
  assert.deepEqual(Object.keys(doc.paths), ['/health']);

  const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  const ops = Object.keys(doc.paths['/health']).filter(k => methods.includes(k));
  assert.equal(ops.length, 7, 'exactly the 7 approved method operations');
  assert.deepEqual(Object.keys(doc.paths['/health'].get.responses), ['200']);
  for (const m of methods.filter(x => x !== 'get')) {
    assert.deepEqual(Object.keys(doc.paths['/health'][m].responses), ['405'], `${m} must declare 405 only`);
  }

  assert.equal(doc['x-unmatched-path-rule']['status-code'], 404);
  assert.ok(doc.components.responses.NotFound, 'NotFound component declared for traceability');
  assert.ok(!JSON.stringify(doc).includes('#/components/responses/NotFound'),
    'NotFound must not be referenced by any path');
});
