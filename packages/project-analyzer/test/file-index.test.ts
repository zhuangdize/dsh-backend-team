import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PolicyAction, PolicyContext, PolicyDecision, PolicyEngine } from '@dsh-backend-team/contracts'
import { FileIndex } from '../src/index.js'

const temporaryRoots: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'project-analyzer-index-'))
  temporaryRoots.push(root)
  return root
}

function policyContext(root: string): PolicyContext {
  return {
    workspace: {
      root,
      teamDir: join(root, '.backend-team'),
      stateDir: join(root, '.backend-team', 'state'),
      runtimeDir: join(root, '.backend-team', 'runtime'),
      cacheDir: join(root, '.backend-team', 'cache'),
      logsDir: join(root, '.backend-team', 'logs'),
      locksDir: join(root, '.backend-team', 'locks'),
      handoffDir: join(root, '.backend-team', 'handoff'),
    },
    phase: 'DISCOVER',
  }
}

type HandleBoundPolicyEngine = PolicyEngine & {
  executeApprovedRead<T>(action: Extract<PolicyAction, { kind: 'read' }>, context: PolicyContext, operation: (handle: FileHandle) => Promise<T>): Promise<T>
}

function descriptorPolicy(authorize: PolicyEngine['authorize']): HandleBoundPolicyEngine {
  return {
    authorize,
    async executeApprovedRead<T>(action, _context, operation): Promise<T> {
      const decision = await authorize(action, _context)
      if (decision.effect !== 'allow') throw new Error('policy denied')
      const handle = await open(action.targetPath, 'r')
      try {
        return await operation(handle)
      } finally {
        await handle.close()
      }
    },
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('FileIndex', () => {
  it('collects only safe, non-ignored workspace-relative text files without traversing symlinks', () => {
    const root = workspace()
    const outside = workspace()
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'visible.ts'), 'export const visible = true\n')
    mkdirSync(join(root, 'src', '.env'), { recursive: true })
    writeFileSync(join(root, 'src', '.env', 'server.ts'), 'export const shouldNotBeIndexed = true\n')
    writeFileSync(join(root, '.env.local'), 'SECRET=value\n')
    writeFileSync(join(root, '.envrc'), 'SECRET=value\n')
    writeFileSync(join(root, '.npmrc'), '//registry.example/:_authToken=secret\n')
    writeFileSync(join(root, 'id_rsa'), 'private key')
    writeFileSync(join(root, 'credentials.json'), '{"password":"secret"}')
    writeFileSync(join(root, 'ignored.txt'), 'ignored')
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'config'), 'ignored')
    mkdirSync(join(root, 'node_modules', 'dependency'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'dependency', 'index.js'), 'ignored')
    mkdirSync(join(root, '.backend-team', 'runtime'), { recursive: true })
    writeFileSync(join(root, '.backend-team', 'runtime', 'state.json'), 'ignored')
    mkdirSync(join(root, 'dist'), { recursive: true })
    writeFileSync(join(root, 'dist', 'output.js'), 'ignored')
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1))
    writeFileSync(join(outside, 'outside.ts'), 'must not be indexed')
    symlinkSync(outside, join(root, 'outside-link'))

    const result = FileIndex.build(root)

    expect(result.paths).toEqual(['.gitignore', 'src/visible.ts'])
    expect(result.warnings).toEqual([])
  })

  it('reports a warning when the configured path cap truncates evidence', () => {
    const root = workspace()
    writeFileSync(join(root, 'a.ts'), 'a')
    writeFileSync(join(root, 'b.ts'), 'b')
    writeFileSync(join(root, 'c.ts'), 'c')

    const result = FileIndex.build(root, { maxPaths: 2 })

    expect(result.paths).toEqual(['a.ts', 'b.ts'])
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'path-cap-reached' })])
  })

  it('collects a candidate only after its policy read authorization allows it', async () => {
    const root = workspace()
    writeFileSync(join(root, 'allowed.ts'), 'export const allowed = true')
    writeFileSync(join(root, 'denied.ts'), 'export const denied = true')
    const authorized: string[] = []
    const policyEngine = descriptorPolicy(async (action): Promise<PolicyDecision> => {
      authorized.push(action.kind === 'read' ? action.targetPath : '')
      return action.kind === 'read' && action.targetPath.endsWith('denied.ts')
        ? { effect: 'deny', ruleId: 'test-deny', reason: 'test denial' }
        : { effect: 'allow', ruleId: 'test-allow', reason: 'test allowance' }
    })

    const result = await FileIndex.buildAuthorized(root, { policyEngine, policyContext: policyContext(root) })

    expect(result.paths).toEqual(['allowed.ts'])
    expect(authorized.map((path) => path.split('/').at(-1))).toEqual([root.split('/').at(-1), 'allowed.ts', 'denied.ts'])
  })

  it('fails closed when the injected policy cannot bind a read to a protected descriptor', async () => {
    const root = workspace()
    writeFileSync(join(root, 'candidate.ts'), 'export const candidate = true')
    const policyEngine: PolicyEngine = {
      async authorize(): Promise<PolicyDecision> {
        return { effect: 'allow', ruleId: 'test-allow', reason: 'test allowance' }
      },
    }

    const result = await FileIndex.buildAuthorized(root, { policyEngine, policyContext: policyContext(root) })

    expect(result.paths).toEqual([])
  })
})
