import { describe, expect, it } from 'vitest'
import { sha256Canonical } from '../src/index.js'

describe('sha256Canonical', () => {
  it('hashes equivalent objects independently of key insertion order', () => {
    expect(sha256Canonical({ a: 1, b: 2 })).toBe(
      sha256Canonical({ b: 2, a: 1 }),
    )
  })

  it('preserves array order and exact user string bytes', () => {
    expect(sha256Canonical(['first', 'second'])).not.toBe(
      sha256Canonical(['second', 'first']),
    )
    expect(sha256Canonical('e\u0301')).not.toBe(sha256Canonical('é'))
  })

  it.each([
    ['undefined', undefined],
    ['function', () => undefined],
    ['symbol', Symbol('value')],
    ['bigint', 1n],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['non-plain object', new Date(0)],
  ])('rejects %s instead of silently coercing it', (_label, value) => {
    expect(() => sha256Canonical(value)).toThrow(/canonical hashing rejects/)
  })

  it('rejects cyclic values instead of serializing an ambiguous value', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    expect(() => sha256Canonical(cyclic)).toThrow(/cyclic/)
  })

  it('rejects non-index array properties that would otherwise be omitted', () => {
    const cyclicArray: unknown[] & { self?: unknown } = []
    cyclicArray.self = cyclicArray
    const hiddenArray: unknown[] = []
    Object.defineProperty(hiddenArray, 'hidden', {
      configurable: true,
      enumerable: false,
      value: undefined,
    })

    expect(() => sha256Canonical(cyclicArray)).toThrow(/canonical hashing rejects/)
    expect(() => sha256Canonical(hiddenArray)).toThrow(/canonical hashing rejects/)
  })

  it('rejects non-JSON object properties and accessors', () => {
    const hiddenObject = {}
    Object.defineProperty(hiddenObject, 'hidden', {
      configurable: true,
      enumerable: false,
      value: undefined,
    })
    const accessorObject = {}
    Object.defineProperty(accessorObject, 'value', {
      configurable: true,
      enumerable: true,
      get: () => 'unstable',
    })

    expect(() => sha256Canonical(hiddenObject)).toThrow(/canonical hashing rejects/)
    expect(() => sha256Canonical(accessorObject)).toThrow(/canonical hashing rejects/)
  })
})
