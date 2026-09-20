import { execFile } from 'node:child_process'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import vm from 'node:vm'
import { parse } from 'yaml'
import { containsSensitiveOrUnresolvedContent } from './release-content-policy.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeBin = dirname(process.execPath)
const npmPath = join(nodeBin, 'npm')
const tarPath = '/usr/bin/tar'
const requiredEntries = new Set([
  'package/package.json',
  'package/lib/index.js',
  'package/lib/index.d.ts',
  'package/lib/client.js',
  'package/lib/client.d.ts',
  'package/lib/production.js',
  'package/lib/production.d.ts',
  'package/lib/deepseek-harness.json',
  'package/lib/dbgate-loopback-preload.cjs',
  'package/cordis.patch.yml',
  'package/README.md',
  'package/LICENSES/THIRD_PARTY_NOTICES.md',
  'package/lib/team-theme.css',
  'package/lib/team-theme.json',
])
const allowedArchivePrefixes = ['package/lib/tooling/', 'package/LICENSES/']
// Managed workspace directory names are legitimate code constants. Archive
// entry validation above rejects shipping the directory itself; content checks
// focus on credentials, source maps, repository paths, and unresolved imports.

function fail(message) {
  throw new Error(`packed Bundle validation failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

async function assertRegularSingleLink(path, label) {
  const entry = await lstat(path)
  assert(entry.isFile(), `${label} must be a regular file`)
  assert(entry.nlink === 1, `${label} must have one link`)
  return entry
}

function validateArchivePath(path) {
  assert(typeof path === 'string' && path.length > 0, 'archive path must be a non-empty string')
  assert(!isAbsolute(path), `absolute archive path ${path}`)
  assert(!path.includes('\\') && !path.includes('\0'), `unsafe archive path ${path}`)
  assert(path.startsWith('package/'), `archive path outside package root ${path}`)
  assert(!path.split('/').includes('..'), `archive path traversal ${path}`)
  assert(normalize(path) === path, `non-normalized archive path ${path}`)
}

function isAllowedArchiveEntry(path) {
  return requiredEntries.has(path) || allowedArchivePrefixes.some((prefix) => path.startsWith(prefix))
}

async function assertArchiveListing(tarball) {
  const { stdout: names } = await execFileAsync(tarPath, ['-tzf', tarball], { cwd: root })
  const listing = names.split('\n').filter(Boolean)
  assert(new Set(listing).size === listing.length, 'archive contains duplicate paths')
  for (const path of listing) validateArchivePath(path)
  assert(listing.length >= requiredEntries.size, `archive entry count ${listing.length} is below required ${requiredEntries.size}`)
  for (const path of requiredEntries) assert(listing.includes(path), `missing archive entry ${path}`)
  for (const path of listing) assert(isAllowedArchiveEntry(path), `unexpected archive entry ${path}`)

  const { stdout: details } = await execFileAsync(tarPath, ['-tvzf', tarball], { cwd: root })
  for (const line of details.split('\n').filter(Boolean)) {
    assert(line[0] === '-' || line[0] === 'd', `archive contains non-regular entry: ${line}`)
  }
}

async function walkFiles(directory) {
  const output = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else output.push(path)
    }
  }
  return output
}

async function assertExtractedContents(extracted) {
  const files = await walkFiles(extracted)
  const relativeEntries = files.map((path) => relative(dirname(extracted), path).split(sep).join('/'))
  assert(new Set(relativeEntries).size === relativeEntries.length, 'extracted files contain duplicate paths')
  for (const path of relativeEntries) assert(isAllowedArchiveEntry(path), `unexpected extracted path ${path}`)
  for (const path of requiredEntries) assert(relativeEntries.includes(path), `missing extracted path ${path}`)

  for (const path of files) {
    await assertRegularSingleLink(path, path)
    const content = await readFile(path, 'utf8')
    assert(!content.includes(root), `workspace absolute path leaked into ${path}`)
    assert(!content.includes('../../../docs'), `repository compatibility fallback leaked into ${path}`)
    // Vendored compiler/type declarations and license texts are third-party
    // inputs; their ordinary vocabulary can contain names such as
    // `password` or private-package examples. Scan the Bundle-owned outputs
    // with the release policy while still checking every file for path leaks.
    if (!path.includes('/lib/tooling/') && !path.includes('/LICENSES/')) assert(!containsSensitiveOrUnresolvedContent(content, path), `sensitive or unresolved content leaked into ${path}`)
  }
}

function officialToolExecution(signal) {
  return {
    token: Symbol('packed-call'),
    callId: 'packed-call-1',
    rootCallId: 'packed-root-1',
    name: 'backend_team_status',
    arguments: {},
    signal,
  }
}

async function validateRuntime(extracted, manifest) {
  const entry = pathToFileURL(join(extracted, manifest.main)).href
  const module = await import(`${entry}?packed-bundle-check=${Date.now()}`)
  assert(Object.keys(module).sort().join(',') === 'FileMigrationReviewStore,apply,inject,name', 'public exports are not exactly FileMigrationReviewStore,apply,inject,name')
  assert(module.name === '@dsh-backend-team/bundle', 'public name mismatch')
  assert(Array.isArray(module.inject) && module.inject.join(',') === 'tools,llm', 'inject must declare tools and llm')

  const registrations = []
  const guards = []
  const tools = {
    register(definition) {
      registrations.push(definition)
      return () => {
        const index = registrations.indexOf(definition)
        if (index >= 0) registrations.splice(index, 1)
      }
    },
    guard(guard) {
      guards.push(guard)
      return () => {
        const index = guards.indexOf(guard)
        if (index >= 0) guards.splice(index, 1)
      }
    },
  }
  await module.apply({ tools })
  assert(registrations.length === 1, 'packed apply did not register exactly one tool')
  assert(registrations[0].name === 'backend_team_status', 'packed tool name mismatch')
  assert(guards.length === 0, 'packed apply registered a global guard')

  const definition = registrations[0]
  assert(JSON.stringify(definition.parameters) === JSON.stringify({ type: 'object', properties: {}, additionalProperties: false }), 'parameters schema is not strict empty object')
  assert(definition.output?.schema?.type === 'object' && definition.output.schema.additionalProperties === false, 'output schema is not closed')
  const controller = new AbortController()
  const report = await definition.execute({}, officialToolExecution(controller.signal))
  assert(Object.isFrozen(report), 'diagnostic report is not frozen')
  assert(report.version === 'unknown' && report.mode === 'read-only', 'diagnostic report is not unknown/read-only')
  assert(typeof report.evidenceStatus === 'string' && Array.isArray(report.reasons) && Array.isArray(report.missing), 'diagnostic report shape mismatch')
  const rendered = definition.output.render({}, report)
  assert(Array.isArray(rendered) && rendered.length === 1 && rendered[0]?.type === 'text' && typeof rendered[0].text === 'string', 'render must return one text block')
  const alternateRendered = definition.output.render({}, {
    version: 'alternate-version',
    mode: 'read-only',
    reasons: ['alternate reason'],
    missing: ['alternate capability'],
    evidenceStatus: 'pending-real-smoke',
  })
  assert(rendered[0].text !== alternateRendered[0]?.text, 'render must use the verified value argument')
  await assertRejects(definition.execute({ unexpected: true }, officialToolExecution(controller.signal)), 'non-empty arguments')
  controller.abort()
  await assertRejects(definition.execute({}, officialToolExecution(controller.signal)), 'aborted execution')

  const clientExport = manifest?.exports?.['./client']?.default
  assert(clientExport === './lib/client.js', 'packed client export mismatch')
  const clientSource = await readFile(join(extracted, clientExport), 'utf8')
  let handoff
  const styles = new Map()
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { handoff = value } } },
    document: {
      getElementById(id) { return styles.get(id) },
      createElement() { return { id: '', textContent: '' } },
      head: { appendChild(style) { styles.set(style.id, style) } },
    },
  }
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' })
  assert(handoff?.id === '@dsh-backend-team/bundle' && typeof handoff.factory === 'function', 'packed client did not register a ModuleLoader handoff')
  const client = handoff.factory((specifier) => {
    if (specifier === 'react') return {
      createElement: () => null,
      createContext: (value) => ({ _currentValue: value, Provider: () => null, Consumer: () => null }),
      forwardRef: (render) => render,
      memo: (component) => component,
      useCallback: (callback) => callback,
      useContext: (context) => context._currentValue,
      useEffect: () => undefined,
      useLayoutEffect: () => undefined,
      useMemo: (factory) => factory(),
      useRef: (current) => ({ current }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
    }
    if (specifier === 'react/jsx-runtime') return { Fragment: Symbol.for('react.fragment'), jsx: () => null, jsxs: () => null }
    if (specifier === 'react-dom') return { createPortal: () => null }
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: () => null }
    throw new Error(`unexpected client require: ${specifier}`)
  })
  assert(Object.keys(client).sort().join(',') === 'apply,backendTeamConversationDefinition,inject', 'packed client exports are incomplete')
  assert(Array.isArray(client.inject) && client.inject.join(',') === 'slots,conversationEvents,layout', 'packed client inject contract mismatch')
  assert(client.backendTeamConversationDefinition?.kind === 'backend-team' && client.backendTeamConversationDefinition?.target === 'chat', 'packed client conversation definition mismatch')
  const clientRegistrations = []
  const clientSlotNames = []
  const disposeClient = client.apply({
    conversationEvents: { register: () => () => undefined },
    layout: { openDetails: () => undefined, closeDetails: () => undefined },
    slots: {
      inject(name, factory) { clientSlotNames.push(name); const dispose = factory(); return () => dispose?.() },
      register(definition) { clientRegistrations.push(definition); return () => undefined },
    },
  })
  for (const slot of ['conversation.input.left', 'conversation.chat.node', 'conversation.view', 'conversation.session.header.actions', 'conversation.session.header.utilities', 'conversation.composer', 'conversation.input.dock']) assert(clientSlotNames.includes(slot), `packed client did not register ${slot}`)
  assert(clientRegistrations.some((row) => row?.name === 'conversation.view' && row?.id === 'backend-team-panel'), 'packed client overlay registration mismatch')
  disposeClient()

  const productionExport = manifest?.exports?.['./production']?.default
  assert(productionExport === './lib/production.js', 'packed production export mismatch')
  const production = await import(`${pathToFileURL(join(extracted, productionExport)).href}?packed-production-check=${Date.now()}`)
  assert(Object.keys(production).sort().join(',') === 'apply,applyBackendTeamControlRoute,createBackendTeamControlSurface,createBackendTeamProductionHost,createConfiguredWorkflowHost,createCoordinatorCommandHandlers,createCoordinatorControlAdapter,createDshLocalSessionInput,createDshProductionHost,createProductionActivation,createProductionAgentToolSetup,createProductionDevelopmentRun,createProductionWorkflowCommandImplementations,createVerifiedDshAgentPort,createVerifiedDshHostPort,createVerifiedDshSessionPort,createVerifiedWebServerBinding,inject,name', 'packed production exports are incomplete')
  assert(production.inject.join(',') === 'webServer,sessions,agents,tools,approval,userQuestions', 'workflow host inject mismatch')
  assert(await production.createConfiguredWorkflowHost({}, { enabled: false }) === undefined, 'disabled workflow host performed activation')
  const blocked = await production.createProductionActivation({})
  assert(blocked.mode === 'read-only' && blocked.missing.includes('agents'), 'packed production gate did not fail closed')
  const sessionId = 'session-1234567890'
  const sessionInput = production.createDshLocalSessionInput({
    context: {
      sessions: { get: (id) => id === sessionId ? { id, header: { cwd: tempRoot } } : undefined },
      agents: { get: (id) => id === sessionId ? { id } : undefined },
    },
    workspaceId: tempRoot,
    workspaceRoot: tempRoot,
  })({ method: 'GET', path: 'state', query: { sessionId }, headers: {}, remoteAddress: '127.0.0.1' })
  assert(sessionInput?.sessionId === sessionId && sessionInput?.loopback === true, 'packed DSH session adapter did not verify a local session')
}

async function assertRejects(promise, label) {
  try {
    await promise
    fail(`${label} was accepted`)
  } catch (error) {
    if (error?.message?.startsWith('packed Bundle validation failed:')) throw error
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-packed-bundle-check-'))
await chmod(tempRoot, 0o700)
let tarball
try {
  await access(npmPath)
  const nodeTarget = resolve(await realpath(process.execPath))
  const npmTarget = resolve(await realpath(npmPath))
  const nvmNodeRoot = resolve(nodeBin, '..')
  assert(nodeTarget.startsWith(`${nvmNodeRoot}${sep}`), 'NVM Node resolved outside the Node prefix')
  assert(npmTarget === nvmNodeRoot || npmTarget.startsWith(`${nvmNodeRoot}${sep}`), 'NVM npm resolved outside the Node prefix')
  await assertRegularSingleLink(nodeTarget, 'NVM Node')
  await assertRegularSingleLink(npmTarget, 'NVM npm')
  await access(tarPath)
  const packDir = join(tempRoot, 'pack')
  const extractDir = join(tempRoot, 'extract')
  await mkdir(packDir, { mode: 0o700 })
  await mkdir(extractDir, { mode: 0o700 })
  const env = { ...process.env, PATH: `${nodeBin}${process.env.PATH ? `:${process.env.PATH}` : ''}` }
  const { stdout } = await execFileAsync(nodeTarget, [npmTarget, 'pack', '--workspace', '@dsh-backend-team/bundle', '--json', '--pack-destination', packDir], { cwd: root, env })
  const result = JSON.parse(stdout)
  assert(Array.isArray(result) && result.length === 1, 'npm pack did not return one result')
  const filename = result[0]?.filename
  assert(typeof filename === 'string' && basenameSafe(filename), 'npm pack filename is not a basename')
  tarball = join(packDir, filename)
  await assertRegularSingleLink(tarball, 'generated tarball')
  await assertArchiveListing(tarball)
  await execFileAsync(tarPath, ['-xzf', tarball, '-C', extractDir], { cwd: root })
  const extracted = join(extractDir, 'package')
  await assertExtractedContents(extracted)
  const manifest = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'))
  assert(manifest.name === '@dsh-backend-team/bundle' && manifest.main === 'lib/index.js' && manifest.types === 'lib/index.d.ts', 'packed manifest mismatch')
  assert(manifest.exports?.['./package.json'] === './package.json', 'packed manifest must expose ./package.json for dsh.client discovery')
  const patch = parse(await readFile(join(extracted, manifest.dsh.bundle.patch), 'utf8'))
  assert(JSON.stringify(patch) === JSON.stringify([{ insert: [{ id: 'backend-team', name: '@dsh-backend-team/bundle' }] }]), 'packed patch mismatch')
  await validateRuntime(extracted, manifest)
  process.stdout.write(`packed Bundle verified: ${requiredEntries.size} required files plus ${allowedArchivePrefixes.join(', ')}\n`)
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

function basenameSafe(value) {
  return value.length > 0 && basename(value) === value && !isAbsolute(value) && !value.includes('/') && !value.includes('\\') && !value.includes('..')
}
