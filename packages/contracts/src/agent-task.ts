import { z } from 'zod'
import { AgentBudgetSchema } from './budget.js'

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'expected a lowercase SHA-256 digest')
const Identifier = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'identifier contains unsupported characters')
const WorkspacePath = z.string().trim().min(1).max(1024).refine(
  (path) => !/[\u0000-\u001F\u007F]/u.test(path) && !path.startsWith('/') && !path.includes('\\') && !/^[A-Za-z]:/u.test(path) && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
  'path must be workspace-relative without traversal',
)

export const TaskDepthSchema = z.union([z.literal(0), z.literal(1), z.literal(2)])
export type TaskDepth = z.infer<typeof TaskDepthSchema>

export const AgentRoleSchema = z.enum([
  'coordinator',
  'requirements',
  'project-analyzer',
  'backend-architect',
  'database-designer',
  'oss-researcher',
  'planner',
  'developer',
  'tester',
  'security-reviewer',
  'fixer',
  'worker',
])
export type AgentRole = z.infer<typeof AgentRoleSchema>

const NetworkHost = z.string().trim().min(1).max(253).toLowerCase().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, 'network host must be an exact hostname').refine((host) => !host.includes('*'), 'network host wildcards are forbidden')

/** All side-effect capabilities default to deny; an empty set authorizes no work. */
export const AgentCapabilitySetSchema = z.object({
  readProjectFiles: z.boolean().default(false),
  writeOwnedFiles: z.boolean().default(false),
  businessCodeWrite: z.boolean().default(false),
  testCodeWrite: z.boolean().default(false),
  configurationWrite: z.boolean().default(false),
  commandExecution: z.boolean().default(false),
  networkHosts: z.array(NetworkHost).max(32).default([]).superRefine((hosts, context) => {
    if (new Set(hosts).size !== hosts.length) context.addIssue({ code: 'custom', message: 'network hosts must be unique' })
  }),
  install: z.boolean().default(false),
  migration: z.boolean().default(false),
  canDelegate: z.boolean().default(false),
  canChangePhase: z.boolean().default(false),
  canApprove: z.boolean().default(false),
  canContactUser: z.boolean().default(false),
  canAnnounceCompletion: z.boolean().default(false),
}).strict()
export type AgentCapabilitySet = z.infer<typeof AgentCapabilitySetSchema>

export const ArtifactReferenceSchema = z.object({ path: WorkspacePath, sha256: Sha256 }).strict()
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>

export const VerificationInstructionSchema = z.object({
  id: Identifier,
  kind: z.enum(['command', 'inspection', 'test', 'typecheck', 'build', 'lint', 'manual']),
  instruction: z.string().trim().min(1).max(1_000),
  required: z.boolean(),
}).strict()
export type VerificationInstruction = z.infer<typeof VerificationInstructionSchema>

/** Self-contained task contract for coordinator, expert, and depth-two worker execution. */
export const AgentTaskSchema = z.object({
  id: Identifier,
  parentTaskId: Identifier.nullable(),
  depth: TaskDepthSchema,
  role: AgentRoleSchema,
  objective: z.string().trim().min(1).max(4_000),
  nonGoals: z.array(z.string().trim().min(1).max(1_000)).min(1),
  inputArtifacts: z.array(ArtifactReferenceSchema),
  readPaths: z.array(WorkspacePath),
  writePaths: z.array(WorkspacePath),
  capabilities: AgentCapabilitySetSchema.default(() => AgentCapabilitySetSchema.parse({})),
  budget: AgentBudgetSchema,
  doneWhen: z.array(z.string().trim().min(1).max(1_000)).min(1),
  verification: z.array(VerificationInstructionSchema).min(1),
  returnSchema: z.string().trim().min(1).max(256),
}).strict().superRefine((task, context) => {
  if (task.depth === 0 && task.parentTaskId !== null) context.addIssue({ code: 'custom', path: ['parentTaskId'], message: 'depth zero task cannot have a parent task' })
  if (task.depth === 0 && task.role !== 'coordinator') context.addIssue({ code: 'custom', path: ['role'], message: 'depth zero task must use the coordinator role' })
  if (task.depth === 1 && (task.role === 'coordinator' || task.role === 'worker')) context.addIssue({ code: 'custom', path: ['role'], message: 'depth one task must use an expert role' })
  if (task.depth === 1 && task.parentTaskId === null) context.addIssue({ code: 'custom', path: ['parentTaskId'], message: 'depth one task requires a parent task' })
  if (task.depth === 2 && task.parentTaskId === null) context.addIssue({ code: 'custom', path: ['parentTaskId'], message: 'depth two task requires a parent task' })
  if (task.depth === 2 && task.role !== 'worker') context.addIssue({ code: 'custom', path: ['role'], message: 'depth two task must use the worker role' })
  if (task.depth === 2 && task.capabilities.canDelegate) context.addIssue({ code: 'custom', path: ['capabilities', 'canDelegate'], message: 'depth two workers cannot delegate' })
  const artifactPaths = task.inputArtifacts.map((artifact) => artifact.path)
  if (new Set(artifactPaths).size !== artifactPaths.length) context.addIssue({ code: 'custom', path: ['inputArtifacts'], message: 'input artifact paths must be unique' })
  if (new Set(task.readPaths).size !== task.readPaths.length) context.addIssue({ code: 'custom', path: ['readPaths'], message: 'read paths must be unique' })
  if (new Set(task.writePaths).size !== task.writePaths.length) context.addIssue({ code: 'custom', path: ['writePaths'], message: 'write paths must be unique' })
  if (new Set(task.verification.map((item) => item.id)).size !== task.verification.length) context.addIssue({ code: 'custom', path: ['verification'], message: 'verification instruction IDs must be unique' })
})
export type AgentTask = z.infer<typeof AgentTaskSchema>
