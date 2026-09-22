export const REQUIRED_RELEASE_EVIDENCE = Object.freeze([
  'production-coordinator',
  'browser-codex-chrome',
  'real-model-api',
  'dbgate-gui',
])

const REQUIRED_ARCHITECTURES = new Set(['darwin-arm64', 'darwin-x64'])

export function assertRuntimeManifest(manifest) {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || manifest.component !== 'postgresql' || manifest.version !== '18.6' || manifest.status !== 'verified' || typeof manifest.sourceManifest !== 'string' || manifest.sourceManifest.length === 0) {
    throw releaseError('INCOMPLETE_RUNTIME_PROVENANCE', 'PostgreSQL runtime manifest is not complete verified provenance')
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== REQUIRED_ARCHITECTURES.size) {
    throw releaseError('INCOMPLETE_RUNTIME_PROVENANCE', 'PostgreSQL runtime manifest must contain both native Darwin architectures')
  }

  const architectures = new Set()
  for (const artifact of manifest.artifacts) {
    if (!isRecord(artifact) || typeof artifact.architecture !== 'string' || architectures.has(artifact.architecture) || !REQUIRED_ARCHITECTURES.has(artifact.architecture) || artifact.version !== '18.6' || !isHttpsUrl(artifact.url) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256) || typeof artifact.attestation !== 'string' || artifact.attestation.length === 0) {
      throw releaseError('INCOMPLETE_RUNTIME_PROVENANCE', 'PostgreSQL runtime artifact provenance is malformed or incomplete')
    }
    architectures.add(artifact.architecture)
  }
  if (architectures.size !== REQUIRED_ARCHITECTURES.size) {
    throw releaseError('INCOMPLETE_RUNTIME_PROVENANCE', 'PostgreSQL runtime manifest is missing a native Darwin architecture')
  }
}

export function assertAgentFixture(fixture) {
  if (!isRecord(fixture) || fixture.schemaVersion !== 1 || fixture.status !== 'verified' || fixture.harness !== '0.1.0-rc.6' || !Array.isArray(fixture.notProven) || fixture.notProven.length !== 0 || !isRecord(fixture.adapter) || typeof fixture.adapter.entry !== 'string' || fixture.adapter.entry.length === 0 || !isRecord(fixture.publicSurface) || typeof fixture.publicSurface.create !== 'string' || fixture.publicSurface.create.length === 0 || !isRecord(fixture.observed) || fixture.observed.assistantEvent !== 'assistant/message' || fixture.observed.disposed !== true) {
    throw releaseError('INCOMPLETE_AGENT_RUNTIME_PROVENANCE', 'Agent runtime fixture is not fully verified')
  }
}

export function assertReleaseEvidence(evidence) {
  if (!isRecord(evidence) || evidence.schemaVersion !== 1 || !isRecord(evidence.gates)) {
    throw releaseError('INCOMPLETE_RELEASE_EVIDENCE', 'release evidence must contain an explicit gates object')
  }
  for (const gateId of REQUIRED_RELEASE_EVIDENCE) {
    const gate = evidence.gates[gateId]
    if (!isRecord(gate) || gate.status !== 'passed' || !isConcreteEvidenceRef(gate.evidenceRef)) {
      throw releaseError('INCOMPLETE_RELEASE_EVIDENCE', `required release gate ${gateId} is not explicitly passed with evidence`)
    }
  }
  const model = evidence.gates['real-model-api']
  if (typeof model.provider !== 'string' || model.provider.trim().length === 0 || typeof model.model !== 'string' || model.model.trim().length === 0 || model.provider.trim().toLowerCase() === 'test' || model.model.trim().toLowerCase() === 'test' || !['openai-responses', 'openai-chat-completions'].includes(model.api)) {
    throw releaseError('INCOMPLETE_RELEASE_EVIDENCE', 'model API evidence requires provider, model and a supported API protocol')
  }
}

export function releaseError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConcreteEvidenceRef(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  const ref = value.trim().toLowerCase()
  return !ref.startsWith('test://') && !ref.includes('example.test') && !ref.includes('placeholder')
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}
