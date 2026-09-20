import { describe, expect, it } from 'vitest'
import { assertReleaseEvidence } from '../../scripts/release-gates.mjs'

function evidence(model: Record<string, unknown>) {
  return { schemaVersion: 1, gates: {
    'production-coordinator': { status: 'passed', evidenceRef: 'coordinator.json' },
    'browser-codex-chrome': { status: 'passed', evidenceRef: 'browser.json' },
    'dbgate-gui': { status: 'passed', evidenceRef: 'dbgate.json' },
    'real-model-api': model,
  } }
}
const model = { status: 'passed', evidenceRef: 'qwen-run.json', provider: 'qwen-4399', model: 'qwen3.8-flash', api: 'openai-responses' }

describe('release model API gate', () => {
  it.each(['openai-responses', 'openai-chat-completions'])('accepts identified model evidence using %s', api => {
    expect(() => assertReleaseEvidence(evidence({ ...model, api }))).not.toThrow()
  })
  it.each(['provider', 'model', 'api'])('rejects missing %s without exposing evidence contents', key => {
    const invalid: Record<string, unknown> = { ...model }; delete invalid[key]
    expect(() => assertReleaseEvidence(evidence(invalid))).toThrow(/model API evidence requires/)
  })
  it('rejects Agent-server evidence as model API evidence', () => {
    expect(() => assertReleaseEvidence(evidence({ ...model, api: 'codex-app-server' }))).toThrow(/model API evidence requires/)
  })
  it('does not accept the legacy vendor-specific gate as a substitute', () => {
    const input = evidence(model); const { 'real-model-api': legacy, ...gates } = input.gates
    expect(() => assertReleaseEvidence({ ...input, gates: { ...gates, 'real-deepseek-model': legacy } })).toThrow(/real-model-api/)
  })
  it('retains the requirement for real passed evidence', () => {
    expect(() => assertReleaseEvidence(evidence({ ...model, status: 'not-run' }))).toThrow(/not explicitly passed/)
  })
})
