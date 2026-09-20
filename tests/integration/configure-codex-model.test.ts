import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import YAML from 'yaml'

it('enables and disables only the Codex Profile section while preserving other configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-profile-config-'))
  const home = join(root, 'dsh-home')
  const profile = join(home, 'profiles/web')
  const script = resolve('scripts/configure-codex-model.mjs')
  const run = async (action: string, extra: string[] = []) => promisify(execFile)(process.execPath, [script, action, '--workspace', root, '--dsh-home', home, ...extra])
  try {
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: unrelated\n  config:\n    keep: true\n- id: backend-team\n  config:\n    retained: 7\n')
    expect(JSON.parse((await run('enable', ['--command', process.execPath])).stdout).enabled).toBe(true)
    let entries = YAML.parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'))
    expect(entries[0]).toEqual({ id: 'unrelated', config: { keep: true } })
    expect(entries[1].config.retained).toBe(7)
    expect(entries[1].config.codexAppServer.enabled).toBe(true)
    const before = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    await run('status')
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(before)
    await run('disable')
    entries = YAML.parse(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'))
    expect(entries[1].config.codexAppServer).toEqual({ enabled: false })
    expect(entries[1].config.retained).toBe(7)
  } finally { await rm(root, { recursive: true, force: true }) }
})
