const EXPECTED_VERSION = '0.1.0-rc.6'
const ALLOWED_STATUSES = new Set(['pending-real-smoke', 'verified'])

export function assertBundleCompatibilityMatrixDocument(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || input.schemaVersion !== 1 || !Array.isArray(input.entries)) {
    throw new Error('Bundle compatibility matrix must use schemaVersion 1 with entries')
  }
  if (input.entries.length !== 1) throw new Error('Bundle compatibility matrix must contain exactly one entry')
  const entry = input.entries[0]
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || entry.version !== EXPECTED_VERSION) {
    throw new Error(`Bundle compatibility matrix must contain only ${EXPECTED_VERSION}`)
  }
  if (!ALLOWED_STATUSES.has(entry.status)) throw new Error('Bundle compatibility matrix status is not allowed for Stage01')
}
