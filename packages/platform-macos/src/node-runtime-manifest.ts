import { z } from 'zod'

export const nodeArchitectureSchema = z.enum(['darwin-arm64', 'darwin-x64'])
export const nodeRuntimeManifestSchema = z.object({
  exactVersion: z.string().regex(/^\d+\.\d+\.\d+$/), architecture: nodeArchitectureSchema,
  url: z.string().url().startsWith('https://'), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(), license: z.literal('MIT'), source: z.string().min(1),
  status: z.enum(['supported', 'eol-existing-project-only']),
}).strict()
export type NodeRuntimeManifest = z.infer<typeof nodeRuntimeManifestSchema>
export const NodeRuntimeManifestSchema = nodeRuntimeManifestSchema
export type NodeArchitecture = z.infer<typeof nodeArchitectureSchema>
export const nvmManifestSchema = z.object({ exactVersion: z.string(), url: z.string().url().startsWith('https://'), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(), license: z.literal('MIT'), source: z.string().min(1), status: z.literal('supported') }).strict()
export type NvmManifest = z.infer<typeof nvmManifestSchema>
export const NvmManifestSchema = nvmManifestSchema
