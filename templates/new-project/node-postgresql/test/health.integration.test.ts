import { describe, expect, it } from 'vitest'
import { HealthController } from '../src/health/health.controller.js'

describe('health baseline', () => { it('returns the generated service health contract', () => { expect(new HealthController().check()).toEqual({ status: 'ok' }) }) })
