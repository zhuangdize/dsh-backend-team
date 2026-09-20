const SECRET_DIRECTORIES = new Set([
  '.aws',
  '.gnupg',
  '.ssh',
  'credential',
  'credentials',
  'private',
  'secrets',
])

const SECRET_FILE_NAME = /(?:^|[._-])(?:credential(?:s)?|token|password|secret|private[-_]?key|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$)/i
const PRIVATE_KEY_EXTENSION = /\.(?:key|pem|p12|pfx)$/i

function isSensitiveSegment(segment: string): boolean {
  return /^\.env(?:$|rc$|[._].*)/i.test(segment)
    || /^\.npmrc$/i.test(segment)
    || PRIVATE_KEY_EXTENSION.test(segment)
    || SECRET_FILE_NAME.test(segment)
    || SECRET_DIRECTORIES.has(segment.toLowerCase())
}

/** Identifies paths whose contents must never enter project-analysis evidence. */
export class SecretFilter {
  static isSensitivePath(relativePath: string): boolean {
    const normalized = relativePath.replaceAll('\\', '/')
    const segments = normalized.split('/').filter(Boolean)
    return segments.some(isSensitiveSegment)
  }
}
