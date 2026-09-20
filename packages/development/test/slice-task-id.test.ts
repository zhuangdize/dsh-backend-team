import { expect, it } from 'vitest'
import { ownsSliceTask, sliceTaskId } from '../src/slice-task-id.js'

it('binds unique dispatch identities to the exact plan, slice and role within handoff ID limits', () => {
  const hash = 'a'.repeat(64)
  const slice = 'S'.repeat(40)
  const first = sliceTaskId('developer', hash, slice, 0)
  const second = sliceTaskId('developer', hash, slice, 0)
  expect(first).not.toBe(second)
  expect(('handoff-' + first).length).toBeLessThanOrEqual(128)
  expect(ownsSliceTask(first, 'developer', hash, slice)).toBe(true)
  expect(ownsSliceTask(first, 'tester', hash, slice)).toBe(false)
  expect(ownsSliceTask(first, 'developer', 'b'.repeat(64), slice)).toBe(false)
  expect(ownsSliceTask(first, 'developer', hash, 'S2')).toBe(false)
  expect(ownsSliceTask(first + '-extra', 'developer', hash, slice)).toBe(false)
})
