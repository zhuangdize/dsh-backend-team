import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ManagedNodeTestOptions } from './managed-node-tests.js'

/** Fixed strict file check, with host tooling; never runs project scripts or tsconfig plugins. */
export async function runManagedTypecheck(options: ManagedNodeTestOptions) {
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24) throw new Error('类型检查需要 macOS 和 Node 24。')
  if (options.signal.aborted || !Number.isSafeInteger(options.maxWallMs) || options.maxWallMs < 1) throw new Error('类型检查已取消或超时。')
  const root = await realpath(options.workspaceRoot)
  const paths = [...new Set(options.readPaths)]
  for (const path of paths) {
    if (!path || path.split('/').some(part => !part || part.startsWith('.')) || /[\\:\u0000-\u001f\u007f]/u.test(path)) throw new Error('类型检查文件路径无效。')
    const absolute = join(root, path)
    const stat = await lstat(absolute)
    if (await realpath(absolute) !== absolute || !stat.isFile() || stat.nlink !== 1) throw new Error('类型检查只能读取声明的普通文件。')
  }
  if (!options.files.length || options.files.some(file => !paths.includes(file) || !/\.(?:ts|mts|cts)$/u.test(file) || /\.d\.(?:ts|mts|cts)$/u.test(file))) throw new Error('请选择任务声明中的 TypeScript 源文件。')
  const tooling = await realpath(fileURLToPath(new URL('../lib/tooling', import.meta.url)))
  const compiler = join(tooling, 'typescript/lib/tsc.js')
  const node = await realpath(process.execPath)
  if (await realpath('/usr/bin/sandbox-exec') !== '/usr/bin/sandbox-exec' || await realpath(compiler) !== compiler) throw new Error('类型检查运行时路径无效。')
  const absolutePaths = paths.map(path => resolve(root, path))
  const directories = new Set<string>()
  for (const path of [...absolutePaths, node, tooling]) {
    let parent = dirname(path)
    while (!directories.has(parent)) { directories.add(parent); const next = dirname(parent); if (next === parent) break; parent = next }
  }
  const q = JSON.stringify
  const profile = `(version 1) (allow default) (deny network*) (deny file-write*) (deny file-read-data (subpath ${q(root)}) (subpath ${q(homedir())})) (allow file-read-data (subpath ${q(dirname(node))}) (subpath ${q(tooling)}) ${[...directories, ...absolutePaths].map(path => `(literal ${q(path)})`).join(' ')}) (deny process-exec) (allow process-exec (literal ${q(node)}))`
  const argv = ['--permission', '--allow-fs-read=' + root, '--allow-fs-read=' + tooling, compiler, '--ignoreConfig', '--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--allowImportingTsExtensions', '--types', 'node', '--typeRoots', join(tooling, 'types'), '--pretty', 'false', ...options.files]
  const scope = '仅检查所选文件及声明依赖；固定 strict / ES2022 / ESNext / bundler / Node 类型，不读取项目 tsconfig，不代表完整项目类型检查或构建。'
  return new Promise<{ argv: string[]; exitCode: number; stdout: string; stderr: string; scope: string }>((done, reject) => {
    execFile('/usr/bin/sandbox-exec', ['-p', profile, node, ...argv], { cwd: root, env: { PATH: dirname(node), TZ: 'UTC' }, signal: options.signal, shell: false, timeout: Math.min(options.maxWallMs, 120000), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed || options.signal.aborted)) { reject(new Error('类型检查中断、超时或输出超限。')); return }
      done({ argv: [node, ...argv], exitCode: error?.code === undefined ? 0 : Number(error.code), stdout, stderr, scope })
    })
  })
}
