import { build } from 'esbuild'
import { readFile,writeFile,mkdir } from 'node:fs/promises'
const out='.backend-team/artifacts/ui-fidelity'
await mkdir(out,{recursive:true})
await build({entryPoints:['tests/fixtures/ui-fidelity/client.ts'],outfile:out+'/qa-body.cjs',bundle:true,minify:true,format:'cjs',platform:'browser',external:['react','react-dom','@deepseek-ai/dsh-client-ui-primitives'],logLevel:'error'})
const body=await readFile(out+'/qa-body.cjs','utf8')
const theme=await readFile('packages/bundle/lib/team-theme.css','utf8')
await writeFile(out+'/qa-client.js',`window.__ModuleLoader__.load({id:'@dsh-backend-team/bundle',factory:(require)=>{const style=document.createElement('style');style.textContent=${JSON.stringify(theme)};document.head.appendChild(style);const module={exports:{}};const exports=module.exports;${body};return module.exports;}});`)
