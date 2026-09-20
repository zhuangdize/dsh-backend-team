import { expect, it } from 'vitest'
import { resourceWidth } from '../src/ui/resource-layout.js'
it('keeps a readable resource panel and reserves space for conversation', () => {
  expect(resourceWidth(1586, 260)).toBe(571)
  expect(resourceWidth(1920, 280)).toBe(600)
  expect(resourceWidth(1024, 64)).toBe(369)
  expect(resourceWidth(1280, 280, 700)).toBe(560)
})
