import { randomUUID } from 'node:crypto'
import { AgentBudgetSchema, ConsumedBudgetSchema } from '@dsh-backend-team/contracts'
import type { AgentBudget, ConsumedBudget } from '@dsh-backend-team/contracts'

export interface BudgetReservation { readonly parentId: string; readonly childId: string; readonly budget: AgentBudget }
export interface BudgetOverrun { readonly usage: ConsumedBudget; readonly exceeded: readonly ('tokens' | 'wallMs' | 'toolCalls' | 'retries' | 'children')[] }
export interface BudgetSnapshot { readonly status: 'ready' | 'blocked:budget-exhausted'; readonly consumed: ConsumedBudget; readonly reserved: ConsumedBudget; readonly remaining: AgentBudget; readonly overrun?: BudgetOverrun }
export interface BudgetLedgerReservationState { readonly childId: string; readonly reservationId: string; readonly budget: AgentBudget }
export interface BudgetLedgerRecordState { readonly parentId: string; readonly budget: AgentBudget; readonly consumed: ConsumedBudget; readonly reservations: readonly BudgetLedgerReservationState[]; readonly status: BudgetSnapshot['status']; readonly overrun?: BudgetOverrun }
export interface BudgetLedgerState { readonly schemaVersion: 2; readonly records: readonly BudgetLedgerRecordState[] }
export interface BudgetLedgerStateRecovery { readonly state: BudgetLedgerState; readonly migratedFromV1: boolean }

interface ReservationState { readonly id: string; readonly budget: AgentBudget; readonly held: ConsumedBudget; readonly reservation: BudgetReservation }
interface RecordState { readonly budget: AgentBudget; consumed: ConsumedBudget; reserved: Map<string, ReservationState>; status: BudgetSnapshot['status']; overrun?: BudgetOverrun }
const zero = (): ConsumedBudget => ({ tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0 })
const add = (left: ConsumedBudget, right: ConsumedBudget): ConsumedBudget => ({ tokens: left.tokens + right.tokens, wallMs: left.wallMs + right.wallMs, toolCalls: left.toolCalls + right.toolCalls, retries: left.retries + right.retries, children: left.children + right.children })

/** In-memory monotonic parent budget accounting; DurableBudgetLedger persists this state. */
export class BudgetLedger {
  private readonly records = new Map<string, RecordState>()

  register(parentId: string, budget: AgentBudget): void {
    assertParentId(parentId)
    const parsed = AgentBudgetSchema.parse(budget)
    const existing = this.records.get(parentId)
    if (existing !== undefined) {
      if (JSON.stringify(existing.budget) !== JSON.stringify(parsed)) throw new Error('parent budget is already registered with a different ceiling')
      if (existing.status !== 'ready') throw new Error('parent budget exhausted')
      return
    }
    this.records.set(parentId, { budget: parsed, consumed: zero(), reserved: new Map(), status: 'ready' })
  }

  reserve(parentId: string, childId: string, budget: AgentBudget): BudgetReservation {
    assertParentId(parentId)
    assertChildId(childId)
    const record = this.require(parentId)
    if (record.reserved.has(childId)) throw new Error('child budget is already reserved')
    const requested = AgentBudgetSchema.parse(budget)
    const held: ConsumedBudget = { tokens: requested.maxTokens, wallMs: requested.maxWallMs, toolCalls: requested.maxToolCalls, retries: requested.maxRetries, children: 1 }
    if (!this.fits(record, held)) {
      const remaining = this.snapshotFor(record)
      record.status = 'blocked:budget-exhausted'
      record.overrun = { usage: { ...held }, exceeded: exceededDimensions(held, remaining) }
      throw new Error(formatBudgetError('parent budget exhausted', held, remaining))
    }
    const reservation = { parentId, childId, budget: requested }
    record.reserved.set(childId, { id: randomUUID(), budget: requested, held, reservation })
    return reservation
  }

  consume(reservation: BudgetReservation, usage: ConsumedBudget): void {
    const record = this.require(reservation.parentId)
    const held = record.reserved.get(reservation.childId)
    if (held === undefined) throw new Error('budget reservation is missing')
    this.assertReservationIdentity(held, reservation)
    const parsed = ConsumedBudgetSchema.parse(usage)
    if (!sameBudget(held.budget, reservation.budget)) throw new Error('budget reservation does not match the held ceiling')
    if (parsed.tokens > held.held.tokens || parsed.wallMs > held.held.wallMs || parsed.toolCalls > held.held.toolCalls || parsed.retries > held.held.retries || parsed.children > held.budget.maxChildren) throw new Error('budget usage exceeds reservation')
    record.reserved.delete(reservation.childId)
    record.consumed = add(record.consumed, { ...parsed, children: held.held.children })
  }

  /** Records usage for a top-level task that has no parent reservation. */
  record(parentId: string, usage: ConsumedBudget): void {
    const record = this.require(parentId)
    const parsed = ConsumedBudgetSchema.parse(usage)
    const remaining = this.snapshotFor(record)
    const exceeded = exceededDimensions(parsed, remaining)
    if (exceeded.length > 0) {
      record.status = 'blocked:budget-exhausted'
      record.consumed = add(record.consumed, parsed)
      record.overrun = { usage: { ...parsed }, exceeded }
      // `record` is used for a top-level task without a parent reservation;
      // reserve() remains the parent-budget path. Keep the user-facing reason
      // accurate so the task panel does not imply a missing parent task.
      throw new Error(formatBudgetError('task budget exhausted', parsed, remaining))
    }
    record.consumed = add(record.consumed, parsed)
  }

  /** Records a terminal timeout/exhaustion without treating an exact ceiling as an overrun. */
  markExhausted(parentId: string, usage: ConsumedBudget, exceeded: readonly BudgetOverrun['exceeded'][number][]): void {
    const record = this.require(parentId)
    const parsed = ConsumedBudgetSchema.parse(usage)
    const dimensions = [...new Set(exceeded)]
    if (dimensions.length === 0) throw new Error('budget exhaustion dimension is required')
    record.status = 'blocked:budget-exhausted'
    // The overrun field is the durable terminal reason. A wall-clock timeout
    // may equal its ceiling, so this is not necessarily a numerical overrun.
    record.overrun = { usage: { ...parsed }, exceeded: dimensions }
  }

  release(reservation: BudgetReservation): void {
    const record = this.require(reservation.parentId)
    const held = record.reserved.get(reservation.childId)
    if (held === undefined) return
    this.assertReservationIdentity(held, reservation)
    if (!sameBudget(held.budget, reservation.budget)) throw new Error('budget reservation does not match the held ceiling')
    record.reserved.delete(reservation.childId)
  }

  snapshot(parentId: string): BudgetSnapshot {
    const record = this.require(parentId)
    const reserved = [...record.reserved.values()].map((reservation) => reservation.held).reduce(add, zero())
    return {
      status: record.status,
      consumed: record.consumed,
      reserved,
      remaining: this.snapshotFor(record),
      ...(record.overrun === undefined ? {} : { overrun: { usage: { ...record.overrun.usage }, exceeded: [...record.overrun.exceeded] } }),
    }
  }

  exportState(): BudgetLedgerState {
    return {
      schemaVersion: 2,
      records: [...this.records.entries()].map(([parentId, record]) => ({
        parentId,
        budget: { ...record.budget },
        consumed: { ...record.consumed },
        reservations: [...record.reserved.entries()].map(([childId, reservation]) => ({ childId, reservationId: reservation.id, budget: { ...reservation.budget } })).sort((left, right) => left.childId.localeCompare(right.childId)),
        status: record.status,
        ...(record.overrun === undefined ? {} : { overrun: { usage: { ...record.overrun.usage }, exceeded: [...record.overrun.exceeded] } }),
      })).sort((left, right) => left.parentId.localeCompare(right.parentId)),
    }
  }

  restoreState(value: unknown): void {
    if (this.records.size !== 0) throw new Error('budget ledger state can only be restored into an empty ledger')
    this.replaceState(value)
  }

  replaceState(value: unknown): void {
    const state = parseState(value)
    const previous = this.records
    const records = new Map<string, RecordState>()
    for (const saved of state.records) {
      const reserved = new Map<string, ReservationState>()
      for (const reservation of saved.reservations) {
        if (reserved.has(reservation.childId)) throw new Error('budget ledger state contains conflicting child reservations')
        const prior = previous.get(saved.parentId)?.reserved.get(reservation.childId)
        const handle = prior !== undefined && prior.id === reservation.reservationId && sameBudget(prior.budget, reservation.budget)
          ? prior.reservation
          : { parentId: saved.parentId, childId: reservation.childId, budget: reservation.budget }
        reserved.set(reservation.childId, { id: reservation.reservationId, budget: reservation.budget, held: heldFor(reservation.budget), reservation: handle })
      }
      const record: RecordState = { budget: saved.budget, consumed: saved.consumed, reserved, status: saved.status, ...(saved.overrun === undefined ? {} : { overrun: saved.overrun }) }
      if (record.status === 'ready' && !this.fitsWithinCeiling(record)) throw new Error('budget ledger state exceeds a parent budget')
      if (records.has(saved.parentId)) throw new Error('budget ledger state contains duplicate parents')
      records.set(saved.parentId, record)
    }
    this.records.clear()
    for (const [parentId, record] of records) this.records.set(parentId, record)
  }

  private fits(record: RecordState, held: ConsumedBudget): boolean {
    const remaining = this.snapshotFor(record)
    return held.tokens <= remaining.maxTokens && held.wallMs <= remaining.maxWallMs && held.toolCalls <= remaining.maxToolCalls && held.retries <= remaining.maxRetries && held.children <= remaining.maxChildren
  }
  private snapshotFor(record: RecordState): AgentBudget {
    const reserved = [...record.reserved.values()].map((reservation) => reservation.held).reduce(add, zero())
    const total = add(record.consumed, reserved)
    return { maxTokens: Math.max(0, record.budget.maxTokens - total.tokens), maxWallMs: Math.max(0, record.budget.maxWallMs - total.wallMs), maxToolCalls: Math.max(0, record.budget.maxToolCalls - total.toolCalls), maxRetries: Math.max(0, record.budget.maxRetries - total.retries), maxChildren: Math.max(0, record.budget.maxChildren - total.children) }
  }
  private fitsWithinCeiling(record: RecordState): boolean {
    const reserved = [...record.reserved.values()].map((reservation) => reservation.held).reduce(add, zero())
    const total = add(record.consumed, reserved)
    return total.tokens <= record.budget.maxTokens && total.wallMs <= record.budget.maxWallMs && total.toolCalls <= record.budget.maxToolCalls && total.retries <= record.budget.maxRetries && total.children <= record.budget.maxChildren
  }
  private assertReservationIdentity(held: ReservationState, reservation: BudgetReservation): void {
    if (held.reservation !== reservation) throw new Error('budget reservation identity is invalid')
  }
  private require(parentId: string): RecordState { const record = this.records.get(parentId); if (record === undefined) throw new Error('parent budget is unknown'); return record }
}

function heldFor(budget: AgentBudget): ConsumedBudget { return { tokens: budget.maxTokens, wallMs: budget.maxWallMs, toolCalls: budget.maxToolCalls, retries: budget.maxRetries, children: 1 } }
function sameBudget(left: AgentBudget, right: AgentBudget): boolean { return left.maxTokens === right.maxTokens && left.maxWallMs === right.maxWallMs && left.maxToolCalls === right.maxToolCalls && left.maxRetries === right.maxRetries && left.maxChildren === right.maxChildren }
function exceededDimensions(usage: ConsumedBudget, remaining: AgentBudget): BudgetOverrun['exceeded'] {
  const exceeded: ('tokens' | 'wallMs' | 'toolCalls' | 'retries' | 'children')[] = []
  if (usage.tokens > remaining.maxTokens) exceeded.push('tokens')
  if (usage.wallMs > remaining.maxWallMs) exceeded.push('wallMs')
  if (usage.toolCalls > remaining.maxToolCalls) exceeded.push('toolCalls')
  if (usage.retries > remaining.maxRetries) exceeded.push('retries')
  if (usage.children > remaining.maxChildren) exceeded.push('children')
  return exceeded
}
function formatBudgetError(prefix: string, usage: ConsumedBudget, remaining: AgentBudget): string {
  const exceeded = exceededDimensions(usage, remaining)
  const detail = exceeded.map((dimension) => `${dimension} used ${usage[dimension]} > remaining ${limitFor(remaining, dimension)}`).join(', ')
  return detail.length === 0 ? prefix : `${prefix}: ${detail}`
}
function limitFor(remaining: AgentBudget, dimension: BudgetOverrun['exceeded'][number]): number {
  return dimension === 'tokens' ? remaining.maxTokens : dimension === 'wallMs' ? remaining.maxWallMs : dimension === 'toolCalls' ? remaining.maxToolCalls : dimension === 'retries' ? remaining.maxRetries : remaining.maxChildren
}
function parseOverrun(value: unknown): BudgetOverrun {
  if (!isRecord(value) || !onlyKeys(value, ['usage', 'exceeded']) || !Array.isArray(value.exceeded)) throw new Error('budget ledger state is malformed')
  const exceeded = value.exceeded.filter((item): item is BudgetOverrun['exceeded'][number] => item === 'tokens' || item === 'wallMs' || item === 'toolCalls' || item === 'retries' || item === 'children')
  if (exceeded.length !== value.exceeded.length || new Set(exceeded).size !== exceeded.length) throw new Error('budget ledger state is malformed')
  return { usage: ConsumedBudgetSchema.parse(value.usage), exceeded }
}
export function recoverBudgetLedgerState(value: unknown): BudgetLedgerStateRecovery {
  if (!isRecord(value)) throw new Error('budget ledger state is malformed')
  if (value.schemaVersion === 2) return { state: parseState(value), migratedFromV1: false }
  if (value.schemaVersion === 1) return { state: migrateV1State(value), migratedFromV1: true }
  throw new Error('budget ledger state is malformed')
}
function parseState(value: unknown): BudgetLedgerState {
  if (!isRecord(value) || !onlyKeys(value, ['schemaVersion', 'records']) || value.schemaVersion !== 2 || !Array.isArray(value.records)) throw new Error('budget ledger state is malformed')
  const parentIds = new Set<string>()
  const records: BudgetLedgerRecordState[] = value.records.map((record) => {
    if (!isRecord(record) || !onlyKeys(record, ['parentId', 'budget', 'consumed', 'reservations', 'status', 'overrun']) || !isId(record.parentId) || !Array.isArray(record.reservations) || (record.status !== 'ready' && record.status !== 'blocked:budget-exhausted')) throw new Error('budget ledger state is malformed')
    if (parentIds.has(record.parentId)) throw new Error('budget ledger state contains duplicate parents')
    parentIds.add(record.parentId)
    const childIds = new Set<string>()
    const reservations: BudgetLedgerReservationState[] = record.reservations.map((reservation) => {
      if (!isRecord(reservation) || !onlyKeys(reservation, ['childId', 'reservationId', 'budget']) || !isId(reservation.childId) || !isReservationId(reservation.reservationId)) throw new Error('budget ledger state is malformed')
      if (childIds.has(reservation.childId)) throw new Error('budget ledger state contains conflicting child reservations')
      childIds.add(reservation.childId)
      return { childId: reservation.childId, reservationId: reservation.reservationId, budget: AgentBudgetSchema.parse(reservation.budget) }
    })
    return { parentId: record.parentId, budget: AgentBudgetSchema.parse(record.budget), consumed: ConsumedBudgetSchema.parse(record.consumed), reservations, status: record.status, ...(record.overrun === undefined ? {} : { overrun: parseOverrun(record.overrun) }) }
  })
  return { schemaVersion: 2, records }
}
function migrateV1State(value: Record<string, unknown>): BudgetLedgerState {
  if (!onlyKeys(value, ['schemaVersion', 'records']) || !Array.isArray(value.records)) throw new Error('budget ledger state is malformed')
  const parentIds = new Set<string>()
  const records: BudgetLedgerRecordState[] = value.records.map((record) => {
    if (!isRecord(record) || !onlyKeys(record, ['parentId', 'budget', 'consumed', 'reservations', 'status', 'overrun']) || !isId(record.parentId) || !Array.isArray(record.reservations) || (record.status !== 'ready' && record.status !== 'blocked:budget-exhausted')) throw new Error('budget ledger state is malformed')
    if (parentIds.has(record.parentId)) throw new Error('budget ledger state contains duplicate parents')
    parentIds.add(record.parentId)
    const childIds = new Set<string>()
    const reservations: BudgetLedgerReservationState[] = record.reservations.map((reservation) => {
      if (!isRecord(reservation) || !onlyKeys(reservation, ['childId', 'budget']) || !isId(reservation.childId)) throw new Error('budget ledger state is malformed')
      if (childIds.has(reservation.childId)) throw new Error('budget ledger state contains conflicting child reservations')
      childIds.add(reservation.childId)
      return { childId: reservation.childId, reservationId: randomUUID(), budget: AgentBudgetSchema.parse(reservation.budget) }
    })
    return { parentId: record.parentId, budget: AgentBudgetSchema.parse(record.budget), consumed: ConsumedBudgetSchema.parse(record.consumed), reservations, status: record.status, ...(record.overrun === undefined ? {} : { overrun: parseOverrun(record.overrun) }) }
  })
  return { schemaVersion: 2, records }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)) }
function isId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) }
function isReservationId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) }
function assertParentId(value: unknown): asserts value is string { if (!isId(value)) throw new Error('parent task ID is invalid') }
function assertChildId(value: unknown): asserts value is string { if (!isId(value)) throw new Error('child task ID is invalid') }
