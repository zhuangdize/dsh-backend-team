import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentResultSchema } from '@dsh-backend-team/contracts'
import { ManagedTestEvidence } from '../src/managed-test-evidence.js'
import { runManagedNodeTests } from '../src/managed-node-tests.js'

it.skipIf(process.platform !== 'darwin').each(['temporary', 'workspace'])('runs declared tests in %s with real exit codes while denying undeclared reads, writes, child processes and remote network', async (location) => {
  const root = await realpath(await mkdtemp(join(location === 'workspace' ? process.cwd() : tmpdir(), 'managed-test-')))
  try {
    await mkdir(join(root, 'test'))
    await writeFile(join(root, 'secret.txt'), 'not an input')
    await writeFile(join(root, 'test/health.test.mjs'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; import http from 'node:http';
      test('permission boundaries',()=>{ assert.throws(()=>fs.readFileSync('secret.txt')); assert.throws(()=>fs.writeFileSync('new.txt','no')); assert.throws(()=>execFileSync(process.execPath,['-e','0'])); });
      test('loopback HTTP',async()=>{const server=http.createServer((req,res)=>res.end('ok')); await new Promise(r=>server.listen(0,'127.0.0.1',r)); try { const response=await fetch('http://127.0.0.1:'+server.address().port); assert.equal(await response.text(),'ok'); } finally { await new Promise(r=>server.close(r)); }});
      test('remote blocked',async()=>{await assert.rejects(fetch('http://192.0.2.1/',{signal:AbortSignal.timeout(500)}));});`)
    const options = {workspaceRoot: root, files: ['test/health.test.mjs'], readPaths: ['test/health.test.mjs'], signal: new AbortController().signal, maxWallMs: 10000}
    const ledger = new ManagedTestEvidence()
    const claim = AgentResultSchema.parse({ taskId: 'task-1', status: 'passed', summary: 'tested', changedPaths: [], commands: [{ argv: ['invented'], exitCode: 0 }], evidencePaths: [], risks: [], unresolvedItems: [], childResultIds: [], consumedBudget: {tokens: 0, wallMs: 0, toolCalls: 0, retries: 0, children: 0}, verification: {status: 'passed', verifiedBy: 'fixture', verifiedAt: '2026-09-07T00:00:00.000Z', records: [{instructionId: "slice-tests", outcome: "passed", evidencePaths: []}]} })
    expect(() => ledger.verify(claim)).toThrow('real successful test')
    const result = await ledger.run('task-1', options)
    expect(ledger.verify(claim).commands).toEqual([{argv: result.argv, exitCode: 0}])
    ledger.invalidate('task-1')
    expect(() => ledger.verify(claim)).toThrow('after the last edit')
    expect(result.exitCode, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('tests 3')
    await writeFile(join(root,'test/health.test.mjs'), `import assert from 'node:assert/strict'; assert.equal(1,2);`)
    expect((await runManagedNodeTests(options)).exitCode).not.toBe(0)
    await writeFile(join(root,'test/health.test.mjs'), 'console.log("no tests")')
    await expect(runManagedNodeTests(options)).rejects.toThrow('no test cases')
    await expect(runManagedNodeTests({...options, files: ['secret.txt']})).rejects.toThrow()
    await expect(runManagedNodeTests({...options, readPaths: []})).rejects.toThrow()
  } finally {await rm(root,{recursive:true,force:true})}
})

it.skipIf(process.platform !== 'darwin').each(['ts', 'mts', 'cts'])('runs real %s tests in both developer and final modes with unchanged permissions', async extension => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-typescript-')))
  try {
    await mkdir(join(root, 'test'))
    await mkdir(join(root, 'src'))
    const file = `test/greeting.test.${extension}`
    const source = `src/greeting.${extension}`
    const commonjs = extension === 'cts'
    await writeFile(join(root, source), commonjs
      ? 'function greet(name: string): string { return `Hello ${name}` }; module.exports = { greet };'
      : 'export function greet(name: string): string { return `Hello ${name}` }')
    await writeFile(join(root, 'secret.txt'), 'not declared')
    const imports = commonjs
      ? `const { test } = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const {execFileSync} = require('node:child_process'); const {greet} = require('../${source}');`
      : `import {test} from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; import {greet} from '../${source}';`
    await writeFile(join(root, file), imports + `
      const name: string = 'visitor';
      test('typed behavior', () => assert.equal(greet(name), 'Hello visitor'));
      test('boundaries', () => { assert.throws(() => fs.readFileSync('secret.txt')); assert.throws(() => fs.writeFileSync('unexpected.txt','x')); assert.throws(() => execFileSync(process.execPath,['-e','0'])); });`)
    const options = { workspaceRoot: root, files: [file], readPaths: [file, source], signal: new AbortController().signal, maxWallMs: 10000 }
    for (const testCli of [false, true]) {
      const result = await runManagedNodeTests({ ...options, testCli })
      expect(result.exitCode, result.stderr + result.stdout).toBe(0)
      expect(result.stdout).toContain('tests 2')
    }
    await writeFile(join(root, file), imports + ` test('failure', () => assert.equal(greet('visitor'), 'wrong'));`)
    expect((await runManagedNodeTests(options)).exitCode).not.toBe(0)
    await writeFile(join(root, file), imports + ` enum Invalid { One }; test('not runnable', () => assert.ok(Invalid.One === 0));`)
    expect((await runManagedNodeTests(options)).exitCode).not.toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
