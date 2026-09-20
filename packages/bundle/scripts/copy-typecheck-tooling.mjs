import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const versions = {}
for (const name of ['typescript', '@types/node', 'undici-types']) {
  const source = dirname(require.resolve(`${name}/package.json`))
  const target = resolve(root, 'lib/tooling', name === 'typescript' ? name : 'types/' + name.replace('@types/', ''))
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, ...(name === 'typescript' ? { filter: path => path === source || path === resolve(source, 'lib') || /(?:package\.json|LICENSE\.txt|ThirdPartyNoticeText\.txt|tsc\.js|_tsc\.js|lib\.[^/]+\.d\.ts)$/u.test(path) } : {}) })
  versions[name] = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8')).version
}
await writeFile(resolve(root, 'lib/tooling/versions.json'), JSON.stringify(versions, null, 2) + '\n')
