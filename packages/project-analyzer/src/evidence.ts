import { z } from 'zod'

function isWorkspaceRelativePath(path: string): boolean {
  if (path.length === 0 || path === '.' || path.startsWith('/') || path.includes('\\')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

const WorkspaceRelativePath = z.string().max(1024).refine(
  isWorkspaceRelativePath,
  'evidence path must be workspace-relative without traversal',
)

/**
 * A bounded, redacted assertion about a source file. Raw file excerpts and
 * sensitive source content are intentionally not part of the evidence model.
 */
const RedactedFact = z.string().trim().min(3).max(280).regex(/^[^\r\n]+$/, 'evidence fact must be one line')

export const EvidenceKind = z.enum(['manifest', 'lockfile', 'import', 'config', 'migration', 'script', 'git', 'filesystem'])
export type EvidenceKind = z.infer<typeof EvidenceKind>

export const ProjectEvidence = z.object({
  kind: EvidenceKind,
  path: WorkspaceRelativePath,
  fact: RedactedFact,
  excerptHash: z.string().regex(/^[a-f0-9]{64}$/, 'evidence excerpt hash must be lowercase hexadecimal'),
}).strict()

export type ProjectEvidence = z.infer<typeof ProjectEvidence>
