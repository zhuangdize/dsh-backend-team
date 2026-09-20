import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { backendTeamConversationDefinition, inject } from '../src/client.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('Bundle client entry', () => {
  it('declares the proven browser export without bundling a second runtime', async () => {
    const manifest = JSON.parse(await readFile(`${packageRoot}/package.json`, 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({
      exports: {
        '.': { types: './lib/index.d.ts', default: './lib/index.js' },
        './client': { types: './lib/client.d.ts', default: './lib/client.js' },
        './production': { types: './lib/production.d.ts', default: './lib/production.js' },
        './package.json': './package.json',
      },
      dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-layout'] } },
    })
    expect(manifest.peerDependencies).toEqual({
      '@deepseek-ai/dsh-client-runtime': '0.1.0-rc.6',
      '@deepseek-ai/dsh-client-ui-conversation': '0.1.0-rc.6',
      '@deepseek-ai/dsh-client-ui-layout': '0.1.0-rc.6',
      react: '^18.2.0',
      'react-dom': '^18.2.0',
    })
    expect(inject).toEqual(['slots', 'conversationEvents', 'layout'])
    expect(backendTeamConversationDefinition).toMatchObject({ kind: 'backend-team', target: 'chat' })
  })

  it('keeps package metadata resolvable for the rc.6 dsh.client scanner', () => {
    const resolved = createRequire(import.meta.url).resolve('@dsh-backend-team/bundle/package.json')
    expect(fileURLToPath(new URL('../package.json', import.meta.url))).toBe(resolved)
  })
})
