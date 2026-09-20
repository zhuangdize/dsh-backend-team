import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentHandoffSchema } from '@dsh-backend-team/contracts'
import { HandoffStore } from '../src/handoff-store.js'

const handoff = AgentHandoffSchema.parse({
  id: 'handoff-1', taskId: 'worker-1', status: 'completed', summary: 'Implemented endpoint.', changedPaths: [], commands: [], evidencePaths: [], risks: [], unresolvedItems: [],
  consumedBudget: { tokens: 1, wallMs: 2, toolCalls: 1, retries: 0, children: 0 }, childResultIds: [], parentVerification: { status: 'pending' },
})

describe('HandoffStore', () => {
  it('writes an atomic workspace-local handoff and retains it until durable acknowledgement', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'agent-handoff-'))
    const store = new HandoffStore(root)
    const record = store.write(handoff, 'expert-1')
    expect(store.exists(record.id)).toBe(true)
    expect(record.parentTaskId).toBe('expert-1')
    expect(store.read(record.id).parentVerification.status).toBe('pending')
    expect(readdirSync(resolve(root, '.backend-team', 'handoff')).some((name) => name.endsWith('.tmp'))).toBe(false)
    const acknowledged = store.acknowledge(record.id, 'expert-1')
    expect(acknowledged.acknowledgedBy).toBe('expert-1')
    expect(store.read(record.id).parentVerification).toMatchObject({ status: 'accepted', verifiedBy: 'expert-1' })
    const raw = readFileSync(resolve(root, '.backend-team', 'handoff', `${record.id}.json`), 'utf8')
    expect(raw).toContain('expert-1')
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects path traversal and acknowledgement by an invalid parent', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'agent-handoff-'))
    const store = new HandoffStore(root)
    expect(() => store.read('../escape')).toThrow(/task ID|safe/i)
    const record = store.write(handoff, 'expert-1')
    expect(() => store.acknowledge(record.id, '../parent')).toThrow(/task ID/i)
    expect(() => store.acknowledge(record.id, 'other-parent')).toThrow(/another parent/i)
    rmSync(root, { recursive: true, force: true })
  })
})
