import { realpathSync } from 'node:fs'
import { lstatSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkspaceLayout } from '@dsh-backend-team/contracts'

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** Returns the complete, deliberately non-inheriting process environment for local uv commands. */
export function buildRuntimeEnvironment(layout: WorkspaceLayout): Readonly<Record<string, string>> {
  const root = realpathSync(layout.root)
  if (root !== layout.root) throw new Error('workspace root must be canonical')
  const binDir = managed(layout, 'runtime/bin')
  const venv = managed(layout, 'runtime/spec-kit/.venv')
  const pythonMirror = managed(layout, 'cache/python-mirror')
  return Object.freeze({
    HOME: layout.teamDir,
    PATH: `${binDir}:${SYSTEM_PATH}`,
    TMPDIR: layout.cacheDir,
    XDG_CACHE_HOME: layout.cacheDir,
    XDG_CONFIG_HOME: layout.stateDir,
    XDG_DATA_HOME: layout.runtimeDir,
    XDG_STATE_HOME: layout.stateDir,
    UV_PROJECT_ENVIRONMENT: venv,
    UV_CACHE_DIR: managed(layout, 'cache/uv'),
    UV_PYTHON_INSTALL_DIR: managed(layout, 'runtime/python'),
    UV_PYTHON_BIN_DIR: binDir,
    UV_PYTHON_INSTALL_BIN: '0',
    UV_TOOL_DIR: managed(layout, 'runtime/uv-tools'),
    UV_TOOL_BIN_DIR: binDir,
    UV_NO_SYSTEM_CONFIG: '1',
    UV_NO_CONFIG: '1',
    UV_NO_MODIFY_PATH: '1',
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_PYTHON_DOWNLOADS: 'manual',
    UV_PYTHON_INSTALL_MIRROR: pathToFileURL(pythonMirror).href,
    UV_OFFLINE: '1',
    PIP_CONFIG_FILE: '/dev/null',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  })
}

/** Resolves a fixed runtime-relative location while rejecting every symlinked or escaping ancestor. */
export function runtimePath(layout: WorkspaceLayout, relativePath: string): string {
  if (relativePath.includes('\0') || relativePath.length === 0 || isAbsolute(relativePath) || relativePath.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) throw new Error('runtime path must be a non-empty relative path')
  return managed(layout, `runtime/${relativePath}`)
}

/** Resolves uv's venv interpreter link while constraining its final target to managed runtime trees. */
export function runtimePythonPath(layout: WorkspaceLayout): string {
  const target = managed(layout, 'runtime/spec-kit/.venv/bin/python', true)
  try {
    const canonical = realpathSync(target)
    const venv = managed(layout, 'runtime/spec-kit/.venv')
    const managedPython = managed(layout, 'runtime/python')
    if (!inside(venv, canonical) && !inside(managedPython, canonical)) throw new Error('workspace Python executable target escapes managed runtime')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target
}

export function runtimeDownloadPath(layout: WorkspaceLayout): string { return managed(layout, 'cache/downloads/uv-0.12.3.tar.gz') }

export function assertRuntimeEnvironment(layout: WorkspaceLayout, environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const expected = buildRuntimeEnvironment(layout)
  const actualKeys = Object.keys(environment).sort(); const expectedKeys = Object.keys(expected).sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index] || environment[key] !== expected[key])) throw new Error('runtime environment must exactly match the workspace-local environment')
  return expected
}

function managed(layout: WorkspaceLayout, relativePath: string, allowFinalSymlink = false): string {
  if (relativePath.includes('\0')) throw new Error('managed runtime path contains NUL')
  const root = realpathSync(layout.root)
  const target = resolve(root, '.backend-team', relativePath)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('managed runtime path escapes workspace')
  let current = root
  const segments = target.slice(root.length + 1).split('/')
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment)
    try {
      const details = lstatSync(current)
      if (details.isSymbolicLink() && !(allowFinalSymlink && index === segments.length - 1)) throw new Error(`managed runtime path has symlink ancestor: ${current}`)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      break
    }
  }
  return target
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}
