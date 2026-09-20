import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout, initializeWorkspaceLayout } from '@dsh-backend-team/platform-macos'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRuntimeEnvironment, runtimePath, runtimePythonPath } from '../src/runtime-environment.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('buildRuntimeEnvironment', () => {
  it('redirects every uv-controlled path into the canonical workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-env-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))

    expect(buildRuntimeEnvironment(layout)).toEqual({
      HOME: layout.teamDir,
      PATH: `${layout.runtimeDir}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: layout.cacheDir,
      XDG_CACHE_HOME: layout.cacheDir,
      XDG_CONFIG_HOME: layout.stateDir,
      XDG_DATA_HOME: layout.runtimeDir,
      XDG_STATE_HOME: layout.stateDir,
      UV_PROJECT_ENVIRONMENT: `${layout.runtimeDir}/spec-kit/.venv`,
      UV_CACHE_DIR: `${layout.cacheDir}/uv`,
      UV_PYTHON_INSTALL_DIR: `${layout.runtimeDir}/python`,
      UV_PYTHON_BIN_DIR: `${layout.runtimeDir}/bin`,
      UV_PYTHON_INSTALL_BIN: '0',
      UV_TOOL_DIR: `${layout.runtimeDir}/uv-tools`,
      UV_TOOL_BIN_DIR: `${layout.runtimeDir}/bin`,
      UV_NO_SYSTEM_CONFIG: '1', UV_NO_CONFIG: '1', UV_NO_MODIFY_PATH: '1', UV_PYTHON_PREFERENCE: 'only-managed',
      UV_PYTHON_DOWNLOADS: 'manual', UV_PYTHON_INSTALL_MIRROR: `file://${layout.cacheDir}/python-mirror`, UV_OFFLINE: '1',
      PIP_CONFIG_FILE: '/dev/null', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
    })
  })

  it('rejects a managed runtime path whose existing ancestor is a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-env-link-')); roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-runtime-env-outside-')); roots.push(outside)
    const layout = createWorkspaceLayout(root)
    await symlink(outside, layout.teamDir)

    expect(() => buildRuntimeEnvironment(layout)).toThrow(/symlink|escapes|unsafe/i)
    expect(await realpath(layout.root)).toBe(layout.root)
  })

  it('refuses runtime-relative traversal even when it would remain below .backend-team', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-env-traversal-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    expect(() => runtimePath(layout, '../state')).toThrow(/relative/i)
  })

  it('allows the official final Python symlink only when it targets a workspace-managed runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-env-python-link-')); roots.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'dsh-runtime-env-python-outside-')); roots.push(outside)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const managedTarget = join(layout.runtimeDir, 'python', 'cpython-3.13.15-macos-aarch64-none', 'bin', 'python3.13')
    const pythonLink = join(layout.runtimeDir, 'spec-kit', '.venv', 'bin', 'python')
    await mkdir(join(layout.runtimeDir, 'python', 'cpython-3.13.15-macos-aarch64-none', 'bin'), { recursive: true })
    await mkdir(join(layout.runtimeDir, 'spec-kit', '.venv', 'bin'), { recursive: true })
    await writeFile(managedTarget, '')
    await symlink(managedTarget, pythonLink)

    expect(runtimePythonPath(layout)).toBe(pythonLink)

    const outsideTarget = join(outside, 'python3.13')
    await writeFile(outsideTarget, '')
    await rm(pythonLink)
    await symlink(outsideTarget, pythonLink)
    expect(() => runtimePythonPath(layout)).toThrow(/workspace|managed|escape/i)
  })
})
