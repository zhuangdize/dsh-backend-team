import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { TaskPlanParser } from './task-plan-parser.js'
import type { DevelopmentPlan } from './vertical-slice.js'

export interface DevelopmentArtifactRegistry {
  snapshot(): { readonly featureDirectory: string; readonly artifacts: readonly { readonly path: string; readonly sha256: string }[] } | Promise<{ readonly featureDirectory: string; readonly artifacts: readonly { readonly path: string; readonly sha256: string }[] }>
}
const required = ['tasks.md', 'spec.md', 'architecture.md', 'data-model.md', 'contracts/openapi.yaml', 'test-plan.md'] as const

/** Loads the active feature's exact files; no caller-constructed executable plan is needed. */
export class FileDevelopmentPlanLoader {
  constructor(private readonly workspaceRoot: string, private readonly registry: DevelopmentArtifactRegistry) {}
  async load(): Promise<DevelopmentPlan> {
    const root = await realpath(this.workspaceRoot)
    const before = await this.registry.snapshot()
    const directory = await realpath(before.featureDirectory)
    const relativeDirectory = relative(root, directory)
    if (isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith('..' + sep) || directory !== resolve(before.featureDirectory)) throw new Error('feature directory must remain inside the workspace without symlinks')
    const hashes = hashesFor(before.artifacts)
    const contents: Record<string, string> = {}
    for (const name of required) {
      if (hashes[name] === undefined) throw new Error(`development artifact is missing: ${name}`)
      const path = resolve(directory, name)
      if (await realpath(dirname(path)) !== dirname(path)) throw new Error('development artifact parent must not be a symlink')
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error(`unsafe development artifact: ${name}`)
        const bytes = await handle.readFile()
        if (createHash('sha256').update(bytes).digest('hex') !== hashes[name]) throw new Error(`development artifact changed: ${name}`)
        contents[name] = bytes.toString('utf8')
      } finally { await handle.close() }
    }
    const parsed = await new TaskPlanParser().parse({ tasks: contents['tasks.md']!, spec: contents['spec.md']!, architecture: contents['architecture.md']!, 'data-model.md': contents['data-model.md']!, 'openapi.yaml': contents['contracts/openapi.yaml']!, 'test-plan.md': contents['test-plan.md']! })
    const after = await this.registry.snapshot()
    if (after.featureDirectory !== before.featureDirectory || JSON.stringify(hashesFor(after.artifacts)) !== JSON.stringify(hashes)) throw new Error('development artifacts changed while loading the plan')
    const artifactReadPaths = Object.freeze(required.map(name => relative(root, resolve(directory, name)).split(sep).join('/')))
    return Object.freeze({ ...parsed, artifactReadPaths, artifactHashes: hashes, slices: Object.freeze(parsed.slices.map(slice => Object.freeze({ ...slice, inputs: hashes }))) })
  }
}

function hashesFor(artifacts: readonly { readonly path: string; readonly sha256: string }[]): Readonly<Record<string, string>> {
  if (new Set(artifacts.map(item => item.path)).size !== artifacts.length || artifacts.some(item => !item.path || !/^[a-f0-9]{64}$/u.test(item.sha256))) throw new Error('development artifact registry is invalid')
  return Object.freeze(Object.fromEntries([...artifacts].sort((a, b) => a.path.localeCompare(b.path)).map(item => [item.path, item.sha256])))
}
