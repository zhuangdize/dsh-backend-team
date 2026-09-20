import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

function isDirectSourceCompatibilityModule(modulePath: string): boolean {
  const moduleName = basename(modulePath)
  const sourceDirectory = dirname(modulePath)
  const packageDirectory = dirname(sourceDirectory)
  return basename(sourceDirectory) === 'src' && basename(packageDirectory) === 'harness-adapter' && (
    moduleName === 'compatibility-locator.ts' || moduleName === 'compatibility-locator.js'
  )
}

/**
 * Resolve the trusted matrix for the adapter's source or compiled package.
 * Bundle builds replace this tiny locator with an adjacent-only resolver.
 */
export function trustedCompatibilityDocumentUrl(moduleUrl: string | URL = import.meta.url): URL {
  const modulePath = fileURLToPath(moduleUrl)
  if (isDirectSourceCompatibilityModule(modulePath)) return new URL('../../../docs/compatibility/deepseek-harness.json', moduleUrl)
  return new URL('./deepseek-harness.json', moduleUrl)
}
