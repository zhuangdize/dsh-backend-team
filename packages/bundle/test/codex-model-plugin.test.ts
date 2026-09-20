import { expect, it } from 'vitest'
import { registerCodexModel } from '../src/codex-model-plugin.js'

it('keeps disabled profiles process-free and registers an explicitly enabled model route', async () => {
  registerCodexModel({}, undefined)
  let routes: string[] = []
  let dispose: (() => Promise<void>) | undefined
  let released = false
  registerCodexModel({ llm: { registerAdapter: (names: string[]) => { routes = names; return () => { released = true } } }, on: (_event, fn) => { dispose = fn } }, { enabled: true, command: '/usr/local/bin/codex' })
  expect(routes).toEqual(['codex-app-server'])
  await dispose!()
  expect(released).toBe(true)
})
it('rejects unsafe configuration and unavailable host lifecycle', () => {
  expect(() => registerCodexModel({}, { enabled: true, command: 'codex; injected' })).toThrow('absolute')
  expect(() => registerCodexModel({}, { enabled: true, command: '/bin/codex' })).toThrow('llm')
  expect(() => registerCodexModel({}, { enabled: true, apiKey: 'unwanted' })).toThrow()
})
