import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('loads built production code without workspace node_modules or a CommonJS caller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'standalone-production-'))
  try {
    await cp(resolve(import.meta.dirname, '../lib'), join(root, 'lib'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', "const m=await import('./lib/production.js'); if(await m.createConfiguredWorkflowHost({},undefined)!==undefined)throw Error('unexpected host'); console.log('loaded');"], { cwd: root, env: {}, timeout: 10000 })
    expect(stdout.trim()).toBe('loaded')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform !== 'darwin')('runs the registered typecheck tool from an isolated installed bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'standalone-typecheck-'))
  try {
    await cp(resolve(import.meta.dirname, '../lib'), join(root, 'lib'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'verify.mjs'), `
      import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
      import {join} from 'node:path'; import {tmpdir} from 'node:os';
      import {createProductionAgentToolSetup} from './lib/production.js';
      const workspace = await realpath(await mkdtemp(join(tmpdir(),'typecheck-workspace-')));
      try {
        await mkdir(join(workspace,'src'));
        await writeFile(join(workspace,'src/app.ts'),'const answer: number = 42;');
        const owner = {}; const tools = new Map();
        const setup = createProductionAgentToolSetup({workspaceRoot:workspace,recoveryToken:'standalone-typecheck-token',readPhase:async()=> 'BUILD',verifyCurrentApproval:async()=>{},policyEngine:{authorize:async()=>({effect:'allow',ruleId:'fixture',reason:'fixture'})}});
        const task={id:'typed-task',parentTaskId:'coordinator',depth:1,role:'developer',objective:'Check source',nonGoals:['No business changes'],inputArtifacts:[],readPaths:['src/app.ts'],writePaths:[],capabilities:{readProjectFiles:true,commandExecution:true},budget:{maxTokens:1000,maxWallMs:15000,maxToolCalls:10,maxRetries:0,maxChildren:0},doneWhen:['Checked'],verification:[{id:'typecheck',kind:'inspection',instruction:'Check declared file types',required:true}],returnSchema:'AgentResult'};
        await setup({agent:owner,tools:{presentAs:()=>()=>{},guard:()=>()=>{},register:definition=>{tools.set(definition.name,definition);return()=>{}}}}, {role:'developer',task:'Check source',context:{},agentTask:task});
        const execution={name:'backend_team_typecheck',agent:owner,signal:new AbortController().signal};
        const first=await tools.get('backend_team_typecheck').execute({files:['src/app.ts']},execution);
        if(first.exitCode!==0) throw Error(first.stdout+first.stderr);
        await writeFile(join(workspace,'src/app.ts'), 'const answer: number = "wrong";');
        const second=await tools.get('backend_team_typecheck').execute({files:['src/app.ts']},execution);
        if(second.exitCode===0||!second.stdout.includes('TS2322')) throw Error('missing actual diagnostic');
        console.log('typecheck-tool-passed');
      } finally {await rm(workspace,{recursive:true,force:true})}
    `)
    const { stdout } = await promisify(execFile)(process.execPath, ['verify.mjs'], { cwd: root, env: {}, timeout: 20000 })
    expect(stdout.trim()).toBe('typecheck-tool-passed')
  } finally { await rm(root, { recursive: true, force: true }) }
})
