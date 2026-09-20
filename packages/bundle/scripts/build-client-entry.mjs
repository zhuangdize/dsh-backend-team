import { build } from 'esbuild'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(packageRoot, 'src/client.ts')
const output = join(packageRoot, 'lib/client.js')
const temporary = join(packageRoot, 'lib/client.cjs')
const pluginId = '@dsh-backend-team/bundle'

/**
 * DeepSeek Harness loads browser entries as classic scripts. Its module table
 * expects each script to register a lazy CJS factory; a normal ESM file would
 * execute outside that table and fail before Cordis can inject the plugin.
 */
await build({
  entryPoints: [source],
  outfile: temporary,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  external: ['react', 'react-dom'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
})

const body = await readFile(temporary, 'utf8')
const theme = JSON.parse(await readFile(join(packageRoot, 'lib/team-theme.json'), 'utf8'))
if (!body.includes('module.exports')) throw new Error('client CJS build did not expose module.exports')
const wrapped = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pluginId)},\n\tfactory: (require) => {\n\t\tvar style = document.getElementById('backend-team-shadcn-theme');\n\t\tif (!style) { style = document.createElement('style'); style.id = 'backend-team-shadcn-theme'; document.head.appendChild(style); }\n\t\tstyle.textContent = ${JSON.stringify(theme)};\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${body}\n\t\treturn module.exports;\n\t}\n});\n`
await writeFile(output, wrapped, 'utf8')
await rm(temporary, { force: true })
