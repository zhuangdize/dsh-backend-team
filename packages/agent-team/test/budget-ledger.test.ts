import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { BudgetLedger } from '../src/budget-ledger.js'
import { DurableBudgetLedger } from '../src/durable-budget-ledger.js'

describe('BudgetLedger', () => {
  it('does not return consumed capacity when a reservation is released', () => {
    const ledger = new BudgetLedger()
    ledger.register('parent', { maxTokens: 100, maxWallMs: 100, maxToolCalls: 10, maxRetries: 2, maxChildren: 3 })
    const reservation = ledger.reserve('parent', 'child', { maxTokens: 40, maxWallMs: 40, maxToolCalls: 4, maxRetries: 1, maxChildren: 0 })

    ledger.consume(reservation, { tokens: 30, wallMs: 20, toolCalls: 3, retries: 1, children: 0 })
    ledger.release(reservation)

    expect(ledger.snapshot('parent')).toMatchObject({ status: 'ready', consumed: { tokens: 30, wallMs: 20, toolCalls: 3, retries: 1, children: 1 }, remaining: { maxTokens: 70, maxWallMs: 80, maxToolCalls: 7, maxRetries: 1, maxChildren: 2 } })
  })

  it('blocks further reservations when parent remaining budget is exhausted', () => {
    const ledger = new BudgetLedger()
    ledger.register('parent', { maxTokens: 10, maxWallMs: 10, maxToolCalls: 2, maxRetries: 0, maxChildren: 1 })
    const reservation = ledger.reserve('parent', 'first', { maxTokens: 10, maxWallMs: 10, maxToolCalls: 2, maxRetries: 0, maxChildren: 0 })
    ledger.consume(reservation, { tokens: 10, wallMs: 10, toolCalls: 2, retries: 0, children: 0 })

    expect(() => ledger.reserve('parent', 'second', { maxTokens: 1, maxWallMs: 1, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 })).toThrow(/parent budget exhausted/i)
    expect(ledger.snapshot('parent').status).toBe('blocked:budget-exhausted')
  })

  it('keeps the observed overrun visible when a top-level result exceeds its ceiling', () => {
    const ledger = new BudgetLedger()
    ledger.register('parent', { maxTokens: 10, maxWallMs: 100, maxToolCalls: 2, maxRetries: 0, maxChildren: 1 })

    expect(() => ledger.record('parent', { tokens: 15, wallMs: 20, toolCalls: 1, retries: 0, children: 0 })).toThrow(/task budget exhausted.*tokens used 15 > remaining 10/i)
    expect(ledger.snapshot('parent')).toMatchObject({
      status: 'blocked:budget-exhausted',
      consumed: { tokens: 15, wallMs: 20, toolCalls: 1, retries: 0, children: 0 },
      remaining: { maxTokens: 0, maxWallMs: 80, maxToolCalls: 1, maxRetries: 0, maxChildren: 1 },
      overrun: { usage: { tokens: 15, wallMs: 20, toolCalls: 1, retries: 0, children: 0 }, exceeded: ['tokens'] },
    })
  })

  it('keeps an exact successful result usable while allowing a timeout to mark terminal exhaustion', () => {
    const ledger = new BudgetLedger()
    const budget = { maxTokens: 10, maxWallMs: 10, maxToolCalls: 2, maxRetries: 1, maxChildren: 0 }
    ledger.register('successful', budget)
    ledger.record('successful', { tokens: 10, wallMs: 10, toolCalls: 2, retries: 1, children: 0 })
    expect(ledger.snapshot('successful')).toMatchObject({ status: 'ready', remaining: { maxTokens: 0, maxWallMs: 0 } })

    ledger.register('timed-out', budget)
    ledger.record('timed-out', { tokens: 0, wallMs: 10, toolCalls: 0, retries: 0, children: 0 })
    ledger.markExhausted('timed-out', { tokens: 0, wallMs: 10, toolCalls: 0, retries: 0, children: 0 }, ['wallMs'])
    expect(ledger.snapshot('timed-out')).toMatchObject({ status: 'blocked:budget-exhausted', consumed: { wallMs: 10 }, overrun: { exceeded: ['wallMs'] } })
  })

  it('recovers a durable overrun record without treating it as a malformed ledger', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'durable-budget-ledger-'))
    try {
      const first = new DurableBudgetLedger(root)
      first.register('parent', { maxTokens: 10, maxWallMs: 100, maxToolCalls: 2, maxRetries: 0, maxChildren: 1 })
      expect(() => first.record('parent', { tokens: 15, wallMs: 20, toolCalls: 1, retries: 0, children: 0 })).toThrow(/task budget exhausted/i)

      const recovered = new DurableBudgetLedger(root)
      expect(recovered.snapshot('parent')).toMatchObject({ status: 'blocked:budget-exhausted', consumed: { tokens: 15 }, overrun: { exceeded: ['tokens'] } })
      expect(() => recovered.reserve('parent', 'next', { maxTokens: 1, maxWallMs: 1, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 })).toThrow(/parent budget exhausted/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not let a forged reservation release a live child budget hold', () => {
    const ledger = new BudgetLedger()
    const budget = { maxTokens: 40, maxWallMs: 40, maxToolCalls: 4, maxRetries: 1, maxChildren: 0 }
    ledger.register('parent', { maxTokens: 100, maxWallMs: 100, maxToolCalls: 10, maxRetries: 2, maxChildren: 3 })
    const reservation = ledger.reserve('parent', 'child', budget)

    expect(() => ledger.release({ parentId: 'parent', childId: 'child', budget: { ...budget } })).toThrow(/reservation identity/i)
    expect(ledger.snapshot('parent').reserved).toEqual({ tokens: 40, wallMs: 40, toolCalls: 4, retries: 1, children: 1 })

    ledger.release(reservation)
    expect(ledger.snapshot('parent').reserved).toEqual({ tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0 })
  })

  it('rejects parent and child IDs that durable recovery would reject', () => {
    const ledger = new BudgetLedger()
    const budget = { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 1 }

    expect(() => ledger.register('../parent', budget)).toThrow(/parent task ID/i)
    ledger.register('parent', budget)
    expect(() => ledger.reserve('parent', '../child', budget)).toThrow(/child task ID/i)
  })

  it('does not let an old reservation handle release a replacement hold after state refresh', () => {
    const ledger = new BudgetLedger()
    const budget = { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 }
    ledger.register('parent', { maxTokens: 20, maxWallMs: 20, maxToolCalls: 2, maxRetries: 0, maxChildren: 2 })
    const oldReservation = ledger.reserve('parent', 'child', budget)
    const current = ledger.exportState()
    const originalId = current.records[0]?.reservations[0]?.reservationId
    if (originalId === undefined) throw new Error('test fixture did not create a reservation')
    const replacementId = originalId === '00000000-0000-4000-8000-000000000000' ? '11111111-1111-4111-8111-111111111111' : '00000000-0000-4000-8000-000000000000'
    ledger.replaceState({
      ...current,
      records: current.records.map((record) => ({
        ...record,
        reservations: record.reservations.map((reservation) => ({ ...reservation, reservationId: replacementId })),
      })),
    })

    expect(() => ledger.release(oldReservation)).toThrow(/reservation identity/i)
    expect(ledger.snapshot('parent').reserved).toEqual({ tokens: 10, wallMs: 10, toolCalls: 1, retries: 0, children: 1 })
  })

  it('recovers held child capacity after restart so a parent cannot be oversubscribed', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'durable-budget-ledger-'))
    try {
      const first = new DurableBudgetLedger(root)
      first.register('parent', { maxTokens: 100, maxWallMs: 100, maxToolCalls: 10, maxRetries: 2, maxChildren: 3 })
      first.reserve('parent', 'child-1', { maxTokens: 60, maxWallMs: 60, maxToolCalls: 6, maxRetries: 1, maxChildren: 0 })

      const recovered = new DurableBudgetLedger(root)

      expect(recovered.snapshot('parent')).toMatchObject({
        reserved: { tokens: 60, wallMs: 60, toolCalls: 6, retries: 1, children: 1 },
        remaining: { maxTokens: 40, maxWallMs: 40, maxToolCalls: 4, maxRetries: 1, maxChildren: 2 },
      })
      expect(() => recovered.reserve('parent', 'child-2', { maxTokens: 41, maxWallMs: 1, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 })).toThrow(/parent budget exhausted/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('secures a pre-existing workspace .backend-team directory before persisting budgets', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'durable-budget-ledger-'))
    try {
      mkdirSync(resolve(root, '.backend-team'), { mode: 0o755 })
      const ledger = new DurableBudgetLedger(root)

      ledger.register('parent', { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 1 })

      expect(ledger.snapshot('parent').remaining).toEqual({ maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed when recovered storage repeats a child reservation', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'durable-budget-ledger-'))
    try {
      const stateDirectory = resolve(root, '.backend-team', 'state')
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
      chmodSync(resolve(root, '.backend-team'), 0o700)
      chmodSync(stateDirectory, 0o700)
      writeFileSync(resolve(stateDirectory, 'budget-ledger.json'), JSON.stringify({
        schemaVersion: 2,
        records: [{
          parentId: 'parent',
          budget: { maxTokens: 10, maxWallMs: 10, maxToolCalls: 2, maxRetries: 1, maxChildren: 3 },
          consumed: { tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0 },
          reservations: [
            { childId: 'child', reservationId: '00000000-0000-4000-8000-000000000000', budget: { maxTokens: 1, maxWallMs: 1, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } },
            { childId: 'child', reservationId: '11111111-1111-4111-8111-111111111111', budget: { maxTokens: 1, maxWallMs: 1, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } },
          ],
          status: 'ready',
        }],
      }), { mode: 0o600 })

      expect(() => new DurableBudgetLedger(root)).toThrow(/malformed or conflicting/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed when the durable ledger file is not valid JSON', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'durable-budget-ledger-'))
    try {
      const stateDirectory = resolve(root, '.backend-team', 'state')
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
      chmodSync(resolve(root, '.backend-team'), 0o700)
      chmodSync(stateDirectory, 0o700)
      writeFileSync(resolve(stateDirectory, 'budget-ledger.json'), '{invalid', { mode: 0o600 })

      expect(() => new DurableBudgetLedger(root)).toThrow(/budget ledger recovery failed/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('migrates a valid v1 ledger file to v2 while preserving a held child budget', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'durable-budget-ledger-'))
    try {
      const stateDirectory = resolve(root, '.backend-team', 'state')
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
      chmodSync(resolve(root, '.backend-team'), 0o700)
      chmodSync(stateDirectory, 0o700)
      const statePath = resolve(stateDirectory, 'budget-ledger.json')
      writeFileSync(statePath, JSON.stringify({
        schemaVersion: 1,
        records: [{
          parentId: 'parent',
          budget: { maxTokens: 20, maxWallMs: 20, maxToolCalls: 2, maxRetries: 0, maxChildren: 2 },
          consumed: { tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0 },
          reservations: [{ childId: 'child', budget: { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } }],
          status: 'ready',
        }],
      }), { mode: 0o600 })

      const ledger = new DurableBudgetLedger(root)
      const migrated = JSON.parse(readFileSync(statePath, 'utf8')) as { schemaVersion: unknown; records: readonly { readonly reservations: readonly { readonly reservationId?: unknown }[] }[] }

      expect(ledger.snapshot('parent').reserved).toEqual({ tokens: 10, wallMs: 10, toolCalls: 1, retries: 0, children: 1 })
      expect(migrated.schemaVersion).toBe(2)
      expect(migrated.records[0]?.reservations[0]?.reservationId).toMatch(/^[0-9a-f-]{36}$/iu)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an over-budget v1 ledger file instead of migrating it', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'durable-budget-ledger-'))
    try {
      const stateDirectory = resolve(root, '.backend-team', 'state')
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 })
      chmodSync(resolve(root, '.backend-team'), 0o700)
      chmodSync(stateDirectory, 0o700)
      writeFileSync(resolve(stateDirectory, 'budget-ledger.json'), JSON.stringify({
        schemaVersion: 1,
        records: [{
          parentId: 'parent',
          budget: { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 1 },
          consumed: { tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0 },
          reservations: [{ childId: 'child', budget: { maxTokens: 11, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 } }],
          status: 'ready',
        }],
      }), { mode: 0o600 })

      expect(() => new DurableBudgetLedger(root)).toThrow(/malformed or conflicting/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refreshes before a second instance reserves capacity so it cannot overwrite a sibling reservation', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'durable-budget-ledger-'))
    try {
      const first = new DurableBudgetLedger(root)
      first.register('parent', { maxTokens: 100, maxWallMs: 100, maxToolCalls: 10, maxRetries: 2, maxChildren: 3 })
      const second = new DurableBudgetLedger(root)

      first.reserve('parent', 'child-1', { maxTokens: 60, maxWallMs: 60, maxToolCalls: 6, maxRetries: 1, maxChildren: 0 })

      expect(() => second.reserve('parent', 'child-2', { maxTokens: 60, maxWallMs: 60, maxToolCalls: 6, maxRetries: 1, maxChildren: 0 })).toThrow(/parent budget exhausted/i)
      expect(new DurableBudgetLedger(root).snapshot('parent').reserved).toEqual({ tokens: 60, wallMs: 60, toolCalls: 6, retries: 1, children: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the original durable reservation handle valid across the reload before consumption', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'durable-budget-ledger-'))
    try {
      const ledger = new DurableBudgetLedger(root)
      const childBudget = { maxTokens: 10, maxWallMs: 10, maxToolCalls: 1, maxRetries: 0, maxChildren: 0 }
      ledger.register('parent', { maxTokens: 20, maxWallMs: 20, maxToolCalls: 2, maxRetries: 0, maxChildren: 2 })
      const reservation = ledger.reserve('parent', 'child', childBudget)

      ledger.consume(reservation, { tokens: 4, wallMs: 5, toolCalls: 1, retries: 0, children: 0 })

      expect(ledger.snapshot('parent').consumed).toEqual({ tokens: 4, wallMs: 5, toolCalls: 1, retries: 0, children: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
