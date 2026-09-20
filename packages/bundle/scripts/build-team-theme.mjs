import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve('../..')
const output = resolve('lib/team-theme.css')
mkdirSync(resolve('lib'), { recursive: true })
execFileSync(process.execPath, [resolve(root, 'node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', resolve(root, 'packages/web/src/ui/theme.css'), '-o', output, '--minify'], { cwd: root, stdio: 'inherit' })
writeFileSync(resolve('lib/team-theme.json'), JSON.stringify(readFileSync(output, 'utf8')))
