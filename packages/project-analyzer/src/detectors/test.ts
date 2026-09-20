import type { DetectedValue } from '../project-profile.js'
import { dependencies, evidence, manifestEvidence } from './node.js'
import type { Detector, DetectorContext } from './node.js'

export type TestRunner = 'vitest' | 'jest' | 'node:test'

function add(results: DetectedValue<TestRunner>[], value: TestRunner, evidenceValue: DetectedValue<TestRunner>['evidence'][number]): void {
  if (!results.some((result) => result.value === value)) results.push({ value, confidence: 'high', evidence: [evidenceValue], conflicts: [] })
}

export class TestDetector implements Detector<TestRunner> {
  async collect(context: DetectorContext): Promise<readonly DetectedValue<TestRunner>[]> {
    const results: DetectedValue<TestRunner>[] = []
    for (const [path, manifest] of [...context.manifests].sort(([left], [right]) => left.localeCompare(right))) {
      const declared = dependencies(manifest)
      for (const [runner, dependency] of [['vitest', 'vitest'], ['jest', 'jest']] as const) {
        if (declared[dependency] !== undefined) add(results, runner, manifestEvidence(path, `declares the ${runner} test runner`, `dependency:${dependency}`))
      }
      if (Object.values(manifest.scripts ?? {}).some((script) => /(?:^|\s)node\s+--test(?:=|\s|$)/u.test(script))) add(results, 'node:test', manifestEvidence(path, 'declares a Node test runner script', 'node-test-script'))
    }
    for (const [path, text] of context.textFiles) {
      if (/(?:from\s*|require\()\s*["']node:test["']/u.test(text)) add(results, 'node:test', evidence('import', path, 'imports the Node test runner', 'node-test-import'))
    }
    return results
  }
}
