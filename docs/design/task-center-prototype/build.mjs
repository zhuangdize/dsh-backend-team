import { build } from 'esbuild'
import { copyFile } from 'node:fs/promises'
await build({entryPoints:['docs/design/task-center-prototype/client.tsx'],outfile:'.backend-team/artifacts/task-center-prototype/client.js',bundle:true,minify:true,platform:'browser'})
for(const name of ['index.html','style.css']) await copyFile('docs/design/task-center-prototype/'+name,'.backend-team/artifacts/task-center-prototype/'+name)
await copyFile('packages/bundle/lib/team-theme.css','.backend-team/artifacts/task-center-prototype/theme.css')
