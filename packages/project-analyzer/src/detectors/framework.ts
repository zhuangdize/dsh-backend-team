import type { DetectedValue } from '../project-profile.js'
import { dependencies, evidence, manifestEvidence } from './node.js'
import type { Detector, DetectorContext } from './node.js'

export type Framework = 'nest' | 'express' | 'fastify' | 'koa' | 'hapi'

const frameworkDependencies: readonly (readonly [Framework, string])[] = [
  ['nest', '@nestjs/core'], ['express', 'express'], ['fastify', 'fastify'], ['koa', 'koa'], ['hapi', '@hapi/hapi'],
]

const frameworkByPackage = new Map<string, Framework>(frameworkDependencies.map(([framework, dependency]) => [dependency, framework]))

function add(results: DetectedValue<Framework>[], value: Framework, evidenceValue: DetectedValue<Framework>['evidence'][number]): void {
  if (!results.some((result) => result.value === value)) results.push({ value, confidence: 'high', evidence: [evidenceValue], conflicts: [] })
}

export class FrameworkDetector implements Detector<Framework> {
  async collect(context: DetectorContext): Promise<readonly DetectedValue<Framework>[]> {
    const results: DetectedValue<Framework>[] = []
    for (const [path, manifest] of [...context.manifests].sort(([left], [right]) => left.localeCompare(right))) {
      const declared = dependencies(manifest)
      for (const [framework, dependency] of frameworkDependencies) {
        if (declared[dependency] !== undefined) add(results, framework, manifestEvidence(path, `declares the ${framework} framework dependency`, `dependency:${dependency}`))
      }
    }
    for (const [path, text] of context.textFiles) {
      const configured = /(?:framework|adapter|server)\s*[:=]\s*["'](nest|express|fastify|koa|hapi)["']/u.exec(text)?.[1] as Framework | undefined
      if (configured) add(results, configured, evidence('config', path, `declares the ${configured} framework configuration`, `framework-config:${configured}`))
      for (const matched of text.matchAll(/(?:from\s*|require\()\s*["']([^"']+)["']/gu)) {
        const framework = frameworkByPackage.get(matched[1] ?? '')
        if (framework) add(results, framework, evidence('import', path, `imports the ${framework} framework package`, `framework-import:${framework}`))
      }
    }
    return results
  }
}
