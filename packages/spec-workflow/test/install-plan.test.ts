import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout, initializeWorkspaceLayout } from '@dsh-backend-team/platform-macos'
import { afterEach, describe, expect, it } from 'vitest'
import { buildInstallPlan, createInstallPlanBuilder, installApprovalDigest, type InstallApprovalDigest } from '../src/install-plan.js'
import { parseRuntimeManifest } from '../src/runtime-manifest.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }) })

const manifestRoot = new URL('../../../runtime-manifests/', import.meta.url)
async function manifests() { return parseRuntimeManifest(JSON.parse(await readFile(new URL('uv-0.12.3.json', manifestRoot), 'utf8')) && { uv: JSON.parse(await readFile(new URL('uv-0.12.3.json', manifestRoot), 'utf8')), specKit: JSON.parse(await readFile(new URL('spec-kit-0.16.5.json', manifestRoot), 'utf8')) }) }

describe('install plans', () => {
  it('binds consent to destination and every command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plan-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const plan = buildInstallPlan(layout, await manifests(), 'arm64', [{ executable: join(root, 'runtime', 'uv'), args: ['tool', 'install'], cwd: root, env: { UV_NO_SYNC: '1' }, executionFingerprint: 'a'.repeat(64), codeWillExecute: true, networkPolicy: 'deny' }])
    const changedDestination = { ...plan, destination: '.backend-team/runtime/global-bin' }
    const changedCommand = { ...plan, commands: [{ ...plan.commands[0]!, args: ['tool', 'run'] }] }

    expect(installApprovalDigest(plan).value).not.toBe(installApprovalDigest(changedDestination).value)
    expect(installApprovalDigest(plan).value).not.toBe(installApprovalDigest(changedCommand).value)
  })

  it('builds only runtime-install plans and gives init a distinct explicit intent digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plan-intent-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const builder = createInstallPlanBuilder()
    const currentManifests = await manifests()
    const runtimePlan = builder.buildRuntimeInstall(layout, currentManifests, 'arm64')
    const digest: InstallApprovalDigest = installApprovalDigest(runtimePlan)
    expect(runtimePlan.intent).toBe('runtime-install')
    expect(digest).toMatchObject({ algorithm: 'sha256', value: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(() => builder.buildRuntimeInstall(layout, currentManifests, 'arm64', [{ executable: join(root, 'specify'), args: ['init'], cwd: root, env: {}, executionFingerprint: 'a'.repeat(64), codeWillExecute: true, networkPolicy: 'deny' }])).toThrow(/specify init.*separate/i)
    expect(digest.value).not.toBe(installApprovalDigest({ ...runtimePlan, intent: 'spec-kit-init' }).value)
  })

  it('uses the workspace cache download destination required by UvInstaller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plan-download-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    expect(buildInstallPlan(layout, await manifests(), 'arm64').destination).toBe('.backend-team/cache/downloads/uv-0.12.3.tar.gz')
  })

  it('rejects an absolute destination outside the workspace before approval can be requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-plan-outside-')); roots.push(root)
    const layout = await initializeWorkspaceLayout(createWorkspaceLayout(root))
    const currentManifests = await manifests()
    expect(() => buildInstallPlan(layout, currentManifests, 'arm64', [], '/tmp/global-bin')).toThrow(/destination.*workspace/i)
  })
})
