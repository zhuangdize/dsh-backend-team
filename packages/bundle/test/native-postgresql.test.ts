import { expect, it } from 'vitest'
import { realpath } from 'node:fs/promises'
import { createNativePostgresql } from '../src/native-postgresql.js'

it('rejects a runtime outside the owned workspace runtime directory', async () => {
  await expect(createNativePostgresql(await realpath(process.cwd()), await realpath('/tmp'))).rejects.toThrow(/workspace runtime|macOS/)
})

it.skipIf(process.env.DSH_NATIVE_DATABASE_ACCEPTANCE !== '1')('starts and stops the actual configured native database', async () => {
  const native = await createNativePostgresql(await realpath(process.cwd()), await realpath('.backend-team/runtime/pg-gui/postgresql-18.6-arm64'))
  try {
    await native.port.start()
    expect(native.feed.snapshot().runtime).toBe('ready')
  } finally { await native.port.stop() }
  expect(native.feed.snapshot().runtime).toBe('stopped')
}, 60000)

it.skipIf(process.env.DSH_NATIVE_DBGATE_ACCEPTANCE !== '1')('opens an owned DbGate design database and consumes login once', async () => {
  const root = await realpath(process.cwd())
  const native = await createNativePostgresql(root, await realpath('.backend-team/runtime/pg-gui/postgresql-18.6-arm64'), { runtimeRoot: `${root}/.backend-team/runtime/dbgate`, port: 3081 }, `${root}/packages/database/dist/dbgate-loopback-preload.cjs`)
  try {
    expect(native.feed.snapshot().guiAvailable).toBe(true)
    const navigation = await native.port.openGui('native-dbgate-acceptance-session')
    expect(navigation.url).toBe('http://127.0.0.1:3081/')
    expect(native.feed.snapshot().runtime).toBe('ready')
    expect(native.port.consumeGuiLogin?.('native-dbgate-acceptance-session')).toMatchObject({ url: navigation.url })
    expect(() => native.port.consumeGuiLogin?.('native-dbgate-acceptance-session')).toThrow('unavailable')
  } finally { await native.port.stop() }
  expect(native.feed.snapshot().runtime).toBe('stopped')
}, 60000)
