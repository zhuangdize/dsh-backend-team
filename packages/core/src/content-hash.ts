import { createHash } from 'node:crypto'

export function sha256Canonical(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value, new Set<object>()), 'utf8')
    .digest('hex')
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return 'null'
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonical hashing rejects non-finite numbers')
      }
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new TypeError(`canonical hashing rejects ${typeof value}`)
    case 'object':
      return canonicalObject(value, ancestors)
  }

  throw new TypeError('canonical hashing rejects unsupported values')
}

function canonicalObject(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new TypeError('canonical hashing rejects cyclic values')
  }

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') {
          continue
        }
        if (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)) {
          throw new TypeError('canonical hashing rejects non-index array properties')
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('canonical hashing rejects non-index array properties')
        }
      }

      const entries: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError('canonical hashing rejects sparse arrays')
        }
        entries.push(canonicalJson(value[index], ancestors))
      }
      return `[${entries.join(',')}]`
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical hashing rejects non-plain objects')
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('canonical hashing rejects non-JSON object properties')
      }
    }
    const record = value as Record<string, unknown>

    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key
}
