import { randomUUID } from 'node:crypto'
import { sha256Canonical } from '@dsh-backend-team/core'

/** Full plan/slice binding plus a fresh dispatch identity, including after restart. */
export function sliceTaskId(role: string, planHash: string, sliceId: string, attempt: number): string {
  return `${role}-${binding(planHash, sliceId)}-${randomUUID().replaceAll('-', '')}-${attempt}`
}

export function ownsSliceTask(taskId: string, role: string, planHash: string, sliceId: string): boolean {
  const prefix = `${role}-${binding(planHash, sliceId)}-`
  if (taskId.startsWith(prefix) && /^[a-f0-9]{32}-[0-2]$/u.test(taskId.slice(prefix.length))) return true
  // Previously persisted plan-bound checkpoints remain readable.
  const legacy = `${role}-${planHash}-${sliceId}-`
  return taskId.startsWith(legacy) && /^\d+$/u.test(taskId.slice(legacy.length))
}

function binding(planHash: string, sliceId: string): string {
  return sha256Canonical({ planHash, sliceId })
}
