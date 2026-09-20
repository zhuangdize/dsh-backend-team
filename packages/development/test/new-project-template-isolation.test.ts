import { describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { NewProjectBootstrapper } from '../src/new-project-bootstrapper.js'
import { NodeRuntimeManifestResolver } from '../../platform-macos/src/node-runtime-manifest-resolver.js'
import { PolicyOwnedArtifactAdapter } from '../../platform-macos/src/policy-owned-artifact-adapter.js'
import { WorkspaceNodeBootstrap } from '../../platform-macos/src/workspace-node-bootstrap.js'
import { WorkspaceNodeRuntime } from '../../platform-macos/src/workspace-node-runtime.js'

const strategy = { kind: 'new-project', nodeRuntime: { exactVersion: '24.19.0', source: 'new-project-default' } }
const fixtureCommandTimeoutMs = 240_000

describe('new-project template isolated fixture', () => {
  it('uses the concrete target-local Node 24 runtime and verifies real install, build, and health', async () => {
    expect(process.versions.node).toBe('24.19.0')
    const fixture = await mkdtemp(join(tmpdir(), 'new-project-fixture-')); const root = join(fixture, 'workspace'); await mkdir(root)
    const profile = join(fixture, '.zshrc'); const aliases = join(fixture, '.nvm-aliases'); await writeFile(profile, 'profile sentinel\n'); await writeFile(aliases, 'alias sentinel\n')
    const shadow = join(fixture, 'path-shadow/npm'); const externalLoader = join(fixture, 'external-nvm.sh'); await mkdir(dirname(shadow), { recursive: true }); await writeFile(shadow, '#!/bin/sh\necho shadow > "$PWD/.path-shadow-called"\n', { mode: 0o755 }); await chmod(shadow, 0o755); await writeFile(externalLoader, 'echo external > .external-loader-called\n', { mode: 0o755 })
    const workspaceRoot = await realpath(root); const runtimeRoot = join(workspaceRoot, '.backend-team/runtime/nvm'); const resolver = new NodeRuntimeManifestResolver()
    const adapter = new PolicyOwnedArtifactAdapter({ workspaceRoot, capability: { executeApprovedArtifact: async (_scope, _signal, operation) => operation() } })
    const runtime = new WorkspaceNodeRuntime({ workspaceRoot, resolver, commandRunner: { run: async () => ({ exitCode: 0 }) }, bootstrap: new WorkspaceNodeBootstrap({ workspaceRoot, adapter }) })
    const beforeProfile = await readFile(profile); const beforeAliases = await readFile(aliases); let installRequest: { executable: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; networkPolicy: string } | undefined
    const bootstrapper = new NewProjectBootstrapper({
      workspaceRoot,
      runtime: { resolve: async (input) => { const result = await runtime.resolve(input); return { nodeRealPath: result.nodeRealPath, npmRealPath: result.npmRealPath, npxRealPath: result.npxRealPath } } },
      commandRunner: { run: async (request) => {
        installRequest = request
        const fixtureHome = join(fixture, 'home'); const fixtureTmp = join(fixture, 'tmp'); const fixtureXdgConfig = join(fixture, 'xdg/config'); const fixtureXdgCache = join(fixture, 'xdg/cache'); const fixturePrefix = join(request.cwd, '.backend-team/npm-prefix'); const fixtureCache = request.env.NPM_CONFIG_CACHE
        if (fixtureCache === undefined) throw new Error('new-project install must provide a target-local npm cache')
        await mkdir(fixtureHome, { recursive: true }); await mkdir(fixtureTmp, { recursive: true }); await mkdir(fixtureXdgConfig, { recursive: true }); await mkdir(fixtureXdgCache, { recursive: true }); await mkdir(fixturePrefix, { recursive: true }); await mkdir(fixtureCache, { recursive: true }); await writeFile(join(fixture, 'npmrc'), '')
        const env = { PATH: `${request.env.PATH ?? ''}:/usr/bin:/bin`, HOME: fixtureHome, TMPDIR: fixtureTmp, TMP: fixtureTmp, TEMP: fixtureTmp, XDG_CONFIG_HOME: fixtureXdgConfig, XDG_CACHE_HOME: fixtureXdgCache, NPM_CONFIG_USERCONFIG: join(fixture, 'npmrc'), NPM_CONFIG_CACHE: fixtureCache, NPM_CONFIG_PREFIX: fixturePrefix, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_legacy_peer_deps: 'true', npm_config_registry: 'https://registry.npmjs.org', npm_config_update_notifier: 'false' }
        const install = spawnSync(request.executable, request.args, { cwd: request.cwd, env, encoding: 'utf8', timeout: fixtureCommandTimeoutMs })
        if (install.status !== 0) throw new Error(`real npm install failed: ${install.stdout}\n${install.stderr}`)
        await writeFile(join(request.cwd, 'src/database/database.module.ts'), 'export class DatabaseModule {}\n')
        for (const args of [['run', 'typecheck'], ['run', 'build'], ['test', '--', '--run']]) {
          const result = spawnSync(request.executable, args, { cwd: request.cwd, env, encoding: 'utf8', timeout: fixtureCommandTimeoutMs })
          if (result.status !== 0) throw new Error(`fixture command ${args.join(' ')} failed: ${result.stdout}\n${result.stderr}`)
        }
        return { exitCode: 0 }
      } },
    })
    try {
      const result = await bootstrapper.apply(strategy, { design: true, dependency: true, install: true, installToken: 'fixture-install-approved' })
      expect(result.files.length).toBeGreaterThan(5)
      expect(installRequest).toMatchObject({ args: ['install', '--ignore-scripts'], networkPolicy: 'allow' })
      expect(installRequest?.executable).toContain(`${runtimeRoot}/`)
      expect(installRequest?.env.PATH).toContain(runtimeRoot)
      expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))).toMatchObject({ type: 'module', engines: { node: '>=24 <25' } })
      await expect(stat(join(root, '.path-shadow-called'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(root, '.external-loader-called'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(profile)).toEqual(beforeProfile); expect(await readFile(aliases)).toEqual(beforeAliases)
      const resolved = await runtime.resolve({ selection: strategy.nodeRuntime, projectKind: strategy.kind, architecture: 'darwin-arm64', installApproval: { approved: true, token: 'fixture-install-approved' } })
      for (const path of [resolved.loaderRealPath, resolved.nodeRealPath, resolved.npmRealPath, resolved.npxRealPath]) expect(await realpath(path)).toContain(await realpath(runtimeRoot))
    } finally { await rm(fixture, { recursive: true, force: true }) }
  }, 300_000)
})
