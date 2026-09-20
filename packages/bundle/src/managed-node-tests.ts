import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

export interface ManagedNodeTestOptions {
  readonly testCli?: boolean
  readonly workspaceRoot: string
  readonly files: readonly string[]
  readonly readPaths: readonly string[]
  readonly signal: AbortSignal
  readonly maxWallMs: number
}

/** Fixed Node test invocation: no shell, inherited secrets, writes or external network. */
export async function runManagedNodeTests(options: ManagedNodeTestOptions): Promise<{ readonly argv: readonly string[]; readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('managed tests require macOS and Node 24 or newer')
  if (options.signal.aborted) throw new Error('managed test aborted')
  if (!Number.isSafeInteger(options.maxWallMs) || options.maxWallMs < 1 || options.files.length === 0) throw new Error('test files and a positive deadline are required')
  const root = await realpath(options.workspaceRoot)
  const paths = [...new Set(options.readPaths)]
  for (const path of paths) {
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /[\\:\u0000-\u001f\u007f]/u.test(path)) throw new Error('unsafe test input path')
    const absolute = join(root, path)
    if (await realpath(absolute) !== absolute) throw new Error('test inputs must not contain symlinks')
    const stat = await lstat(absolute)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('test inputs must be regular unlinked files')
  }
  for (const file of options.files) if (!paths.includes(file) || !/(?:^|\/)(?:test|tests)\/.*\.(?:mjs|cjs|js|mts|cts|ts)$/u.test(file)) throw new Error('test file is outside declared test inputs')
  const node = await realpath(process.execPath)
  const sandbox = await realpath('/usr/bin/sandbox-exec')
  if (sandbox !== '/usr/bin/sandbox-exec') throw new Error('unexpected sandbox executable')
  const absolutePaths = paths.map(path => resolve(root, path))
  const quote = (path: string): string => JSON.stringify(path)
  const directories = new Set<string>()
  for (const path of [...absolutePaths, node]) {
    let parent = dirname(path)
    while (!directories.has(parent)) { directories.add(parent); const next = dirname(parent); if (next === parent) break; parent = next }
  }
  // macOS getcwd needs directory traversal. Literal directory access does not
  // authorize reading their children; only declared input files gain data access.
  const profile = `(version 1) (allow default) (deny network*) (allow network* (remote ip "localhost:*") (local ip "localhost:*")) (deny file-write*) (deny file-read-data (subpath ${quote(root)}) (subpath ${quote(homedir())})) (allow file-read-data (subpath ${quote(dirname(node))}) ${[...directories, ...absolutePaths].map(path => `(literal ${quote(path)})`).join(' ')}) (deny process-exec) (allow process-exec (literal ${quote(node)}))`
  // Node's CLI discovers explicit test files through its glob walker. Directory
  // traversal is allowed here; the macOS profile still denies undeclared data.
  const argv = ['--permission', ...(options.testCli === true ? ['--allow-fs-read=' + root] : []), ...absolutePaths.map(path => '--allow-fs-read=' + path), ...(options.testCli === true
    ? ['--test', '--test-isolation=none', '--test-reporter=tap', ...options.files]
    : ['--input-type=module', '--test-reporter=tap', '-e', 'for (const file of process.argv.slice(1)) await import(file)', ...options.files.map(file => pathToFileURL(join(root, file)).href)])]
  return new Promise((resolveResult, reject) => {
    execFile(sandbox, ['-p', profile, node, ...argv], { cwd: root, env: { PATH: dirname(node), TZ: 'UTC' }, shell: false, signal: options.signal, timeout: Math.min(options.maxWallMs, 120000), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null && (typeof error.code !== 'number' || error.killed || options.signal.aborted)) { reject(new Error('managed test aborted, timed out or exceeded output limit: ' + (error.signal ?? error.code) + ' ' + stderr.slice(0, 2000))); return }
      if (error === null && !/^# tests [1-9][0-9]*\s*$/mu.test(stdout)) { reject(new Error('managed execution produced no test cases')); return }
      resolveResult({ argv: [node, ...argv], exitCode: error?.code === undefined ? 0 : Number(error.code), stdout, stderr })
    })
  })
}
