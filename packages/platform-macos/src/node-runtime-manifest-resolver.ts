import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nodeRuntimeManifestSchema, nvmManifestSchema, type NodeArchitecture, type NodeRuntimeManifest, type NvmManifest } from './node-runtime-manifest.js'
import { z } from 'zod'

export interface RuntimeSelection { readonly exactVersion: string; readonly source: string }
export class NodeRuntimeManifestResolver {
  private readonly manifests: readonly NodeRuntimeManifest[]
  constructor(manifests?: readonly NodeRuntimeManifest[]) {
    this.manifests = manifests ?? loadCatalog()
  }
  resolve(selection: RuntimeSelection, architecture: NodeArchitecture): NodeRuntimeManifest {
    const found = this.manifests.find((m) => m.exactVersion === selection.exactVersion && m.architecture === architecture)
    if (found === undefined) throw new Error(`no reviewed runtime manifest for ${selection.exactVersion}/${architecture}`)
    return found
  }
  nvmManifest(): NvmManifest {
    const root = join(dirname(new URL(import.meta.url).pathname), '../../../runtime-manifests')
    const catalog = z.object({ manifests: z.array(z.string()), nvm: z.string().regex(/^nvm-\d+\.\d+\.\d+\.json$/u) }).strict().parse(JSON.parse(readFileSync(join(root, 'node-runtime-catalog.json'), 'utf8')))
    const manifest = nvmManifestSchema.parse(JSON.parse(readFileSync(join(root, catalog.nvm), 'utf8')))
    if (manifest.exactVersion !== '0.40.3') throw new Error('runtime catalog must pin NVM 0.40.3')
    return manifest
  }
}
function loadCatalog(): NodeRuntimeManifest[] {
  const root = join(dirname(new URL(import.meta.url).pathname), '../../../runtime-manifests')
  const catalog = z.object({ manifests: z.array(z.string().regex(/^node-\d+\.\d+\.\d+-darwin-(?:arm64|x64)\.json$/)).min(1), nvm: z.literal('nvm-0.40.3.json') }).strict().parse(JSON.parse(readFileSync(join(root, 'node-runtime-catalog.json'), 'utf8')))
  const unique = new Set(catalog.manifests); if (unique.size !== catalog.manifests.length) throw new Error('runtime catalog contains duplicate manifests')
  return catalog.manifests.map((file) => nodeRuntimeManifestSchema.parse(JSON.parse(readFileSync(join(root, file), 'utf8'))))
}
