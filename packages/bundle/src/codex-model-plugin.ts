import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { CodexLlmAdapter } from '../../harness-adapter/src/codex-llm-adapter.js'

const configSchema = z.object({ enabled: z.boolean().default(false), command: z.string().min(1).optional(), cwd: z.string().min(1).optional(), timeoutMs: z.number().int().min(1000).max(600000).default(120000) }).strict()
export interface CodexModelHost {
  get?(name: string): unknown
  readonly llm?: unknown
  on?(event: 'dispose', callback: () => Promise<void>): unknown
}
/** Optional profile configuration; off by default and does not inspect credentials. */
export function registerCodexModel(context: CodexModelHost, input: unknown): void {
  const config = configSchema.parse(input ?? {})
  if (!config.enabled) return
  if (config.command === undefined || !isAbsolute(config.command)) throw new Error('codexAppServer.command must be an absolute local Codex executable path')
  if (config.cwd !== undefined && !isAbsolute(config.cwd)) throw new Error('codexAppServer.cwd must be absolute')
  const llm = context.llm ?? context.get?.('llm')
  if (typeof llm !== 'object' || llm === null || typeof Reflect.get(llm, 'registerAdapter') !== 'function') throw new Error('codexAppServer requires the DSH llm service')
  if (typeof context.on !== 'function') throw new Error('codexAppServer requires host disposal lifecycle')
  const adapter = new CodexLlmAdapter({ command: config.command, cwd: config.cwd ?? process.cwd(), timeoutMs: config.timeoutMs })
  const registration = Reflect.get(llm, 'registerAdapter').call(llm, ['codex-app-server'], adapter) as unknown
  context.on('dispose', async () => {
    if (typeof registration === 'function') registration()
    await adapter.dispose()
  })
}
