/** Bundle-only resolver: published code can read its adjacent matrix only. */
export function trustedCompatibilityDocumentUrl(moduleUrl: string | URL = import.meta.url): URL {
  return new URL('./deepseek-harness.json', moduleUrl)
}
