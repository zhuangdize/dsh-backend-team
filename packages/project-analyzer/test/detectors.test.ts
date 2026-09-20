import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CommandDetector,
  DatabaseDetector,
  FrameworkDetector,
  ManifestReader,
  NodeRuntimeDetector,
  PackageManagerDetector,
  TestDetector,
  NodeDetector,
  DetectedNodeRuntime,
  createDetectorContext,
} from '../src/index.js'
import { CommandDetector as PlannedCommandDetector } from '../src/detectors/command-detector.js'
import { DatabaseDetector as PlannedDatabaseDetector } from '../src/detectors/database-detector.js'
import { FrameworkDetector as PlannedFrameworkDetector } from '../src/detectors/framework-detector.js'
import { NodeDetector as PlannedNodeDetector } from '../src/detectors/node-detector.js'
import { NodeRuntimeDetector as PlannedNodeRuntimeDetector } from '../src/detectors/node-version-detector.js'
import { PackageManagerDetector as PlannedPackageManagerDetector } from '../src/detectors/package-manager-detector.js'
import { TestDetector as PlannedTestDetector } from '../src/detectors/test-detector.js'

const fixturesRoot = resolve(import.meta.dirname, '../../../tests/fixtures/projects')

function fixtureContext(name: string) {
  const root = resolve(fixturesRoot, name)
  const reader = new ManifestReader(root)
  const packageResult = reader.readPackage('package.json')
  if (!packageResult.ok) throw new Error(packageResult.error.message)
  return createDetectorContext({
    paths: ['.nvmrc', 'package.json', ...(name === 'nest-drizzle-postgres' ? ['package-lock.json'] : [])],
    manifests: new Map([['package.json', packageResult.manifest]]),
    textFiles: new Map([['.nvmrc', readFileSync(resolve(root, '.nvmrc'), 'utf8')]]),
  })
}

describe('Node backend stack detectors', () => {
  it('keeps planned detector module paths as public compatibility entries', () => {
    expect([
      PlannedCommandDetector,
      PlannedDatabaseDetector,
      PlannedFrameworkDetector,
      PlannedNodeDetector,
      PlannedNodeRuntimeDetector,
      PlannedPackageManagerDetector,
      PlannedTestDetector,
    ].every((detector) => typeof detector === 'function')).toBe(true)
  })

  it.each([
    ['nest-drizzle-postgres', 'nest', 'drizzle', 'postgresql', 'npm', '24.19.0'],
    ['express-prisma-mysql', 'express', 'prisma', 'mysql', 'npm', '20.20.0'],
  ] as const)('detects %s without replacing its existing stack', async (fixture, framework, orm, database, packageManager, nodeVersion) => {
    const context = fixtureContext(fixture)
    const [frameworks, databaseResult, packageManagers, runtime] = await Promise.all([
      new FrameworkDetector().collect(context),
      new DatabaseDetector().collect(context),
      new PackageManagerDetector().collect(context),
      new NodeRuntimeDetector().collect(context),
    ])

    expect(frameworks[0]?.value).toBe(framework)
    expect(databaseResult.orms[0]?.value).toBe(orm)
    expect(databaseResult.databases[0]?.value).toBe(database)
    expect(packageManagers[0]?.value).toBe(packageManager)
    expect(runtime).toMatchObject({ status: 'selected', exactVersion: nodeVersion, selectionSource: '.nvmrc' })
  })

  it('does not execute target scripts, imports, configs, environment files, or database clients', async () => {
    const sentinel = '__DETECTOR_MUST_NOT_EXECUTE__'
    const context = createDetectorContext({
      paths: ['.env', 'dangerous.config.ts', 'package.json', 'src/app.ts'],
      manifests: new Map([['package.json', {
        dependencies: { express: '5.1.0', mysql2: '3.14.3', prisma: '6.14.0' },
        scripts: { test: `node -e "throw new Error('${sentinel}')"` },
      }]]),
      textFiles: new Map([
        ['.env', `DATABASE_URL=${sentinel}`],
        ['dangerous.config.ts', `throw new Error('${sentinel}')`],
        ['src/app.ts', `import '${sentinel}'`],
      ]),
    })

    await expect(Promise.all([
      new FrameworkDetector().collect(context),
      new DatabaseDetector().collect(context),
      new CommandDetector().collect(context),
    ])).resolves.toBeDefined()
  })

  it('requires clarification instead of defaulting an existing project to Node 24', async () => {
    const runtime = await new NodeRuntimeDetector().collect(createDetectorContext({
      paths: ['package.json'],
      manifests: new Map([['package.json', { dependencies: { express: '5.1.0' } }]]),
    }))

    expect(runtime).toEqual({ declarations: [], conflicts: [], status: 'needs-clarification' })
  })

  it('requires clarification and preserves conflicts for incompatible trusted Node declarations', async () => {
    const runtime = await new NodeRuntimeDetector().collect(createDetectorContext({
      paths: ['.nvmrc', 'package.json'],
      manifests: new Map([['package.json', { engines: { node: '20.20.0' } }]]),
      textFiles: new Map([['.nvmrc', '24.19.0\n']]),
    }))

    expect(runtime.status).toBe('needs-clarification')
    expect(runtime.conflicts).toHaveLength(2)
    expect(runtime.exactVersion).toBeUndefined()
  })

  it('selects an exact Node version from an inert devEngines runtime declaration', async () => {
    const runtime = await new NodeRuntimeDetector().collect(createDetectorContext({
      paths: ['package.json'],
      manifests: new Map([['package.json', { devEngines: { runtime: { name: 'node', version: '22.12.0' } } }]]),
    }))

    expect(runtime).toMatchObject({ status: 'selected', exactVersion: '22.12.0', selectionSource: 'package.json#devEngines.runtime' })
  })

  it('maps only declared scripts to unverified command candidates', async () => {
    const context = createDetectorContext({
      paths: ['package.json'],
      manifests: new Map([['package.json', {
        packageManager: 'npm@11.6.2',
        scripts: { typecheck: 'tsc --noEmit', 'test:integration': 'vitest run integration', start: 'node server.js' },
      }]]),
    })

    const commands = await new CommandDetector().collect(context)

    expect(commands).toEqual([
      expect.objectContaining({ script: 'start', purpose: 'start', status: 'unverified' }),
      expect.objectContaining({ script: 'test:integration', purpose: 'integration', status: 'unverified' }),
      expect.objectContaining({ script: 'typecheck', purpose: 'typecheck', status: 'unverified' }),
    ])
    expect(commands.map((command) => command.script)).not.toContain('build')
  })

  it('records evidence conflicts for incompatible package manager declarations', async () => {
    const managers = await new PackageManagerDetector().collect(createDetectorContext({
      paths: ['package-lock.json', 'package.json'],
      manifests: new Map([['package.json', { packageManager: 'pnpm@10.0.0' }]]),
    }))

    expect(managers.map((manager) => manager.value)).toEqual(['pnpm', 'npm'])
    expect(managers.every((manager) => manager.conflicts.length === 1)).toBe(true)
  })

  it('does not select a package manager for conflicting evidence and preserves unknown scripts as blocked candidates', async () => {
    const context = createDetectorContext({
      paths: ['package-lock.json', 'package.json'],
      manifests: new Map([['package.json', { packageManager: 'pnpm@10.0.0', scripts: { deploy: 'target-command' } }]]),
    })

    const commands = await new CommandDetector().collect(context)

    expect(commands).toEqual([
      expect.objectContaining({ script: 'deploy', purpose: 'unknown', status: 'unverified', argv: [] }),
    ])
    expect(commands[0]?.conflicts).toHaveLength(2)
  })

  it('rejects Windows-absolute and SecretFilter-sensitive paths before any detector can create evidence', async () => {
    const context = createDetectorContext({
      paths: ['C:/work/package.json', 'credentials/package.json', 'keys/server.pem', 'secrets/.nvmrc'],
      manifests: new Map([
        ['C:/work/package.json', { dependencies: { express: '5.1.0' } }],
        ['credentials/package.json', { dependencies: { express: '5.1.0' } }],
      ]),
      textFiles: new Map([['secrets/.nvmrc', '24.19.0'], ['keys/server.pem', 'private']]),
    })

    expect(context.paths).toEqual([])
    await expect(new NodeDetector().collect(context)).resolves.toEqual([])
    await expect(new NodeRuntimeDetector().collect(context)).resolves.toEqual({ declarations: [], conflicts: [], status: 'needs-clarification' })
  })

  it('drops source text beneath sensitive ancestor directories before framework evidence can be produced', async () => {
    const context = createDetectorContext({
      paths: ['src/.env/server.ts'],
      manifests: new Map(),
      textFiles: new Map([['src/.env/server.ts', "import { NestFactory } from '@nestjs/core'"]]),
    })

    expect(context.paths).toEqual([])
    await expect(new FrameworkDetector().collect(context)).resolves.toEqual([])
  })

  it('normalizes an nvm v-prefix and collects compatible Volta declarations from sanitized package data', async () => {
    const runtime = await new NodeRuntimeDetector().collect(createDetectorContext({
      paths: ['.nvmrc', 'package.json'],
      manifests: new Map([['package.json', { engines: { node: '>=20 <21' }, volta: { node: '20.20.0' } }]]),
      textFiles: new Map([['.nvmrc', 'v20.20.0\n']]),
    }))

    expect(runtime).toMatchObject({ status: 'selected', exactVersion: '20.20.0', selectionSource: '.nvmrc' })
    expect(runtime.declarations.map((declaration) => declaration.source)).toEqual(['.nvmrc', 'package.json#engines.node', 'package.json#volta.node'])
  })

  it('keeps the declared v-prefix while producing a schema-valid selection across an OR range', async () => {
    const runtime = await new NodeRuntimeDetector().collect(createDetectorContext({
      paths: ['.nvmrc', 'package.json'],
      manifests: new Map([['package.json', { engines: { node: '>=20 <21 || >=22 <23' } }]]),
      textFiles: new Map([['.nvmrc', 'v20.20.0\n']]),
    }))

    expect(runtime.declarations[0]).toMatchObject({ source: '.nvmrc', range: 'v20.20.0' })
    expect(DetectedNodeRuntime.safeParse(runtime).success).toBe(true)
  })

  it('records lockfile-only Node compatibility as requiring clarification instead of inventing a runtime', async () => {
    const runtime = await new NodeRuntimeDetector().collect(createDetectorContext({
      paths: ['package-lock.json'],
      manifests: new Map(),
    }))

    expect(runtime).toMatchObject({ declarations: [], status: 'needs-clarification', conflicts: [expect.objectContaining({ kind: 'lockfile', path: 'package-lock.json' })] })
  })

  it('detects test runners from inert dependency declarations', async () => {
    const tests = await new TestDetector().collect(createDetectorContext({
      paths: ['package.json'],
      manifests: new Map([['package.json', { devDependencies: { vitest: '4.1.11', jest: '30.0.0' } }]]),
    }))

    expect(tests.map((runner) => runner.value)).toEqual(['vitest', 'jest'])
  })

  it('detects database config and import facts without evaluating them', async () => {
    const context = createDetectorContext({
      paths: ['database.config.ts', 'package.json', 'src/db.ts', 'tsconfig.json'],
      manifests: new Map([['package.json', {}]]),
      textFiles: new Map([
        ['database.config.ts', "export const database = { dialect: 'sqlite' }"],
        ['src/db.ts', "import { createPool } from 'mariadb'"],
        ['tsconfig.json', '{ "compilerOptions": { "strict": true } }'],
      ]),
    })

    const [stack, node] = await Promise.all([new DatabaseDetector().collect(context), new NodeDetector().collect(context)])

    expect(stack.databases.map((database) => database.value)).toEqual(['sqlite', 'mariadb'])
    expect(node.map((technology) => technology.value)).toContain('typescript-strict')
  })

  it('detects framework and ORM facts from inert source imports and config values', async () => {
    const context = createDetectorContext({
      paths: ['config/app.ts', 'config/database.ts', 'src/main.ts', 'src/models.ts'],
      manifests: new Map(),
      textFiles: new Map([
        ['config/app.ts', "export const framework = 'koa'"],
        ['config/database.ts', "export const orm = 'sequelize'"],
        ['src/main.ts', "import { NestFactory } from '@nestjs/core'"],
        ['src/models.ts', "import { drizzle } from 'drizzle-orm'"],
      ]),
    })

    const [frameworks, database] = await Promise.all([new FrameworkDetector().collect(context), new DatabaseDetector().collect(context)])

    expect(frameworks.map((framework) => framework.value)).toEqual(['koa', 'nest'])
    expect(database.orms.map((orm) => orm.value)).toEqual(['sequelize', 'drizzle'])
  })

  it('detects node:test imports and node --test= scripts as inert runner facts', async () => {
    const context = createDetectorContext({
      paths: ['package.json', 'src/spec.ts'],
      manifests: new Map([['package.json', { scripts: { test: 'node --test=tests/*.test.js' } }]]),
      textFiles: new Map([['src/spec.ts', "import { test } from 'node:test'"]]),
    })

    const runners = await new TestDetector().collect(context)

    expect(runners.map((runner) => runner.value)).toEqual(['node:test'])
    expect(runners[0]?.evidence).toHaveLength(1)
  })

  it('infers Prisma ORM from an inert Prisma schema provider without a dependency declaration', async () => {
    const stack = await new DatabaseDetector().collect(createDetectorContext({
      paths: ['prisma/schema.prisma'],
      manifests: new Map(),
      textFiles: new Map([['prisma/schema.prisma', 'datasource db { provider = "mysql" }']]),
    }))

    expect(stack.orms.map((orm) => orm.value)).toEqual(['prisma'])
    expect(stack.databases.map((database) => database.value)).toEqual(['mysql'])
  })

  it('infers Prisma ORM even when an inert schema has an unsupported provider', async () => {
    const stack = await new DatabaseDetector().collect(createDetectorContext({
      paths: ['prisma/schema.prisma'],
      manifests: new Map(),
      textFiles: new Map([['prisma/schema.prisma', 'datasource db { provider = "cockroachdb" }']]),
    }))

    expect(stack.orms.map((orm) => orm.value)).toEqual(['prisma'])
    expect(stack.databases).toEqual([])
  })
})
