import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertBundleCompatibilityMatrixDocument } from './compatibility-gate.mjs'

const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(bundleRoot, '../../docs/compatibility/deepseek-harness.json')
const target = resolve(bundleRoot, 'lib/deepseek-harness.json')
const bytes = await readFile(source)
assertBundleCompatibilityMatrixDocument(JSON.parse(bytes.toString('utf8')))
await mkdir(dirname(target), { recursive: true })
await writeFile(target, bytes, { flag: 'w' })
const copied = await readFile(target)
if (!copied.equals(bytes)) throw new Error('compatibility document was not copied byte-for-byte')

// Re-enter the built Bundle so this check uses its inlined compatibility
// parser and adjacent-only locator. A malformed source matrix must fail the
// build instead of silently shipping a read-only diagnostic.
const built = await import(`${pathToFileURL(resolve(bundleRoot, 'lib/index.js')).href}?compatibility-copy-check=${Date.now()}`)
const definitions = []
const context = {
  tools: {
    register(definition) {
      definitions.push(definition)
      return () => {}
    },
  },
}
await built.apply(context)
if (definitions.length !== 1) throw new Error('compatibility document validation did not register the diagnostic')
const report = await definitions[0].execute({}, {
  token: Symbol('compatibility-copy-check'),
  callId: 'compatibility-copy-check',
  rootCallId: 'compatibility-copy-check',
  name: 'backend_team_status',
  arguments: {},
  signal: new AbortController().signal,
})
if (report.reasons.includes('trusted compatibility matrix failed strict validation')) {
  throw new Error('trusted compatibility matrix failed strict validation')
}

// Ship the reviewed loopback preload with the standalone production host.
await writeFile(resolve(bundleRoot, 'lib/dbgate-loopback-preload.cjs'), await readFile(resolve(bundleRoot, '../database/src/dbgate-loopback-preload.cjs')))
