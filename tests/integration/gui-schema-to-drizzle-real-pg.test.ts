import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { createNativePostgresql } from '../../packages/bundle/src/native-postgresql.js'
import { DrizzleKitGenerator, FileCredentialStore, type LocalDatabaseEndpoint } from '../../packages/database/src/index.js'
import { ControlMediatedApprovalPort } from '../../packages/core/src/control-mediated-approval-port.js'

/** Opt-in, temporary local UI acceptance. The Chrome operator approves this test's generated SQL. */
it.skipIf(process.env.DSH_GUI_MIGRATION !== '1')('requires a browser approval before applying a real generated migration', async () => {
  const root = await realpath(process.cwd())
  const tooling = join(root, '.backend-team/runtime/migration-acceptance')
  const require = createRequire(join(tooling, 'package.json'))
  const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => { connect(): Promise<void>; query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>; end(): Promise<void> } }
  const native = await createNativePostgresql(root, join(root, '.backend-team/runtime/pg-gui/postgresql-18.6-arm64'))
  const names = ['base', 'design', 'verify'].map(suffix => `migui_${randomBytes(6).toString('hex')}_${suffix}`)
  const clients: Array<InstanceType<typeof Client>> = []
  const approvals = new ControlMediatedApprovalPort(tooling)
  const cookie = randomBytes(24).toString('hex')
  let admin: InstanceType<typeof Client> | undefined
  let server: ReturnType<typeof createServer> | undefined
  let decisionRun: Promise<void> | undefined
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  let state = '等待审批'
  let failure: unknown
  try {
    const endpoint = await native.port.start() as LocalDatabaseEndpoint
    const secret = await new FileCredentialStore(join(root, '.backend-team/runtime/workflow-postgresql/credentials')).get(endpoint.credentialRef)
    if (secret === undefined) throw new Error('local credential unavailable')
    const url = (name: string): string => { const value = new URL(`postgresql://127.0.0.1:${endpoint.port}/${name}`); value.username = endpoint.user; value.password = Buffer.from(secret).toString('utf8'); return value.href }
    admin = new Client({ connectionString: url('postgres') }); await admin.connect()
    for (const name of names) await admin.query(`CREATE DATABASE ${name}`)
    for (const name of names) { const client = new Client({ connectionString: url(name) }); clients.push(client); await client.connect() }
    const [baseline, design, verify] = clients
    await design!.query('CREATE TABLE migration_demo(id integer PRIMARY KEY, title text NOT NULL);')
    const generated = await new DrizzleKitGenerator({ workspaceRoot: root, toolingRoot: tooling, nodeExecutable: process.execPath }).generate(url(names[0]!), url(names[1]!))
    const tableCount = async (client: InstanceType<typeof Client>): Promise<number> => Number((await client.query("SELECT count(*) FROM pg_tables WHERE schemaname='public'")).rows[0]!.count)
    await verify!.query(generated.preview.sql)
    expect(await tableCount(verify!)).toBe(1)
    expect(await tableCount(baseline!)).toBe(0)
    const request = { kind: 'migration' as const, summary: '将 migration_demo 测试表应用到独立验收库', artifactHashes: { [generated.preview.migrationId]: generated.preview.sqlSha256 } }
    const decision = approvals.requestApproval(request)
    decisionRun = decision.then(async answer => {
      if (answer.effect !== 'approve') { state = '已拒绝，数据库未修改'; return }
      expect(await tableCount(baseline!)).toBe(0)
      await baseline!.query(generated.preview.sql)
      expect(await tableCount(baseline!)).toBe(1)
      state = '已应用，验收库中有 1 张表'
      await writeFile(join(root, '.backend-team/artifacts/migration-browser-evidence.json'), JSON.stringify({ sqlSha256: generated.preview.sqlSha256, generatedBy: 'drizzle-kit@0.31.10', beforeApprovalTables: 0, verificationTables: 1, afterApprovalTables: 1, migrationPath: generated.migrationPath }, null, 2))
    }).catch(error => { failure = error; state = '执行失败' })
    server = createServer(async (req, res) => {
      res.setHeader('cache-control', 'no-store')
      const remote = req.socket.remoteAddress
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remote ?? '') || req.headers.host !== '127.0.0.1:3091') { res.writeHead(403).end(); return }
      if (req.method === 'GET' && req.url === '/') {
        res.setHeader('set-cookie', `migration_acceptance=${cookie}; HttpOnly; SameSite=Strict; Path=/`)
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(page); return
      }
      const authenticated = req.headers.cookie?.split(';').some(part => part.trim() === `migration_acceptance=${cookie}`)
      if (!authenticated) { res.writeHead(401).end(); return }
      if (req.method === 'GET' && req.url === '/state') {
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ state, sql: generated.preview.sql, hash: generated.preview.sqlSha256, approvalId: approvals.listPending()[0]?.id, tables: await tableCount(baseline!) })); return
      }
      if (req.method !== 'POST' || req.headers.origin !== 'http://127.0.0.1:3091' || !String(req.headers['content-type']).startsWith('application/json')) { res.writeHead(403).end(); return }
      try {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error('request too large') }
        if (req.url === '/decision') {
          const input = JSON.parse(body) as { id: string; hash: string; decision: string }
          if (input.decision !== 'approve' && input.decision !== 'reject') throw new Error('invalid decision')
          approvals.decide(input.id, { effect: input.decision, reason: 'Chrome acceptance operator decision' }, input.hash, 0)
          await decisionRun
          res.end('{}'); return
        }
        if (req.url === '/finish' && state.startsWith('已应用')) { res.end('{}'); finish(); return }
        res.writeHead(409).end()
      } catch { res.writeHead(409).end() }
    })
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(3091, '127.0.0.1', resolve) })
    console.log('Migration browser acceptance ready at http://127.0.0.1:3091/')
    await Promise.race([finished, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Chrome approval acceptance timed out')), 300000); timer.unref() })])
    if (failure !== undefined) throw failure
    expect(state).toBe('已应用，验收库中有 1 张表')
  } finally {
    if (server !== undefined) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    await approvals.closeAndDrain()
    await decisionRun
    for (const client of clients) await client.end()
    if (admin !== undefined) { for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end() }
    await native.port.stop()
  }
}, 330000)

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>数据库迁移验收</title><style>body{font:16px system-ui;max-width:860px;margin:48px auto;padding:24px}pre{padding:20px;background:#f3f5f7;white-space:pre-wrap}button{padding:10px 18px;margin-right:12px}small{color:#555}</style><h1>数据库迁移验收</h1><p>独立测试数据库，不修改现有 /health 项目。以下 SQL 由 Drizzle 生成，已在验证库执行通过。</p><h2 id="state">加载中</h2><p id="tables"></p><pre id="sql"></pre><small id="hash"></small><p><button id="approve">批准并应用</button><button id="reject">拒绝</button><button id="finish" hidden>完成验收并清理</button></p><script>let current;async function refresh(){current=await(await fetch('/state')).json();document.getElementById('state').textContent=current.state;document.getElementById('tables').textContent='验收库当前表数量：'+current.tables;document.getElementById('sql').textContent=current.sql;document.getElementById('hash').textContent='SQL SHA-256：'+current.hash;for(const id of ['approve','reject'])document.getElementById(id).disabled=!current.approvalId;document.getElementById('finish').hidden=!current.state.startsWith('已应用')}for(const [id,decision] of [['approve','approve'],['reject','reject']])document.getElementById(id).onclick=async()=>{const response=await fetch('/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:current.approvalId,hash:current.hash,decision})});if(!response.ok)alert('审批失败，请刷新后重试');await refresh()};document.getElementById('finish').onclick=async()=>{await fetch('/finish',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});document.getElementById('state').textContent='验收结束，测试数据库已安排清理';document.getElementById('finish').disabled=true};refresh()</script></html>`
