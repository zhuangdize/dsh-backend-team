import type { DetectedValue } from '../project-profile.js'
import { dependencies, evidence, manifestEvidence } from './node.js'
import type { DetectorContext } from './node.js'

export type Orm = 'drizzle' | 'prisma' | 'typeorm' | 'sequelize' | 'knex'
export type Database = 'postgresql' | 'mysql' | 'mariadb' | 'sqlite'

export interface DetectedDatabaseStack {
  readonly orms: readonly DetectedValue<Orm>[]
  readonly databases: readonly DetectedValue<Database>[]
}

const ormDependencies: readonly (readonly [Orm, string])[] = [
  ['drizzle', 'drizzle-orm'], ['prisma', 'prisma'], ['prisma', '@prisma/client'], ['typeorm', 'typeorm'], ['sequelize', 'sequelize'], ['knex', 'knex'],
]
const databaseDependencies: readonly (readonly [Database, string])[] = [
  ['postgresql', 'pg'], ['postgresql', 'postgres'], ['postgresql', '@neondatabase/serverless'], ['mysql', 'mysql'], ['mysql', 'mysql2'], ['mariadb', 'mariadb'], ['sqlite', 'sqlite3'], ['sqlite', 'better-sqlite3'], ['sqlite', '@libsql/client'],
]

const driverDatabase = new Map<string, Database>(databaseDependencies.map(([database, dependency]) => [dependency, database]))
const ormByPackage = new Map<string, Orm>(ormDependencies.map(([orm, dependency]) => [dependency, orm]))

function add<T extends string>(target: DetectedValue<T>[], value: T, evidenceValue: DetectedValue<T>['evidence'][number]): void {
  if (!target.some((item) => item.value === value)) target.push({ value, confidence: 'high', evidence: [evidenceValue], conflicts: [] })
}

export class DatabaseDetector {
  async collect(context: DetectorContext): Promise<DetectedDatabaseStack> {
    const orms: DetectedValue<Orm>[] = []
    const databases: DetectedValue<Database>[] = []
    for (const [path, manifest] of [...context.manifests].sort(([left], [right]) => left.localeCompare(right))) {
      const declared = dependencies(manifest)
      for (const [orm, dependency] of ormDependencies) if (declared[dependency] !== undefined) add(orms, orm, manifestEvidence(path, `declares the ${orm} ORM dependency`, `dependency:${dependency}`))
      for (const [database, dependency] of databaseDependencies) if (declared[dependency] !== undefined) add(databases, database, manifestEvidence(path, `declares the ${database} database driver dependency`, `dependency:${dependency}`))
    }
    for (const [path, text] of context.textFiles) {
      if (path.endsWith('.prisma')) {
        add(orms, 'prisma', evidence('config', path, 'declares a Prisma schema', 'prisma-schema'))
        const provider = /provider\s*=\s*["'](postgresql|mysql|mariadb|sqlite)["']/u.exec(text)?.[1] as Database | undefined
        if (provider) add(databases, provider, evidence('config', path, `declares the ${provider} Prisma datasource provider`, `prisma-provider:${provider}`))
        continue
      }
      const configuredOrm = /(?:orm|querybuilder|query-builder)\s*[:=]\s*["'](drizzle|prisma|typeorm|sequelize|knex)["']/u.exec(text)?.[1] as Orm | undefined
      if (configuredOrm) add(orms, configuredOrm, evidence('config', path, `declares the ${configuredOrm} ORM configuration`, `orm-config:${configuredOrm}`))
      const configured = /(?:dialect|client|provider|type)\s*[:=]\s*["'](postgres|postgresql|mysql|mariadb|sqlite)["']/u.exec(text)?.[1]
      const database = configured === 'postgres' ? 'postgresql' : configured as Database | undefined
      if (database) add(databases, database, evidence('config', path, `declares the ${database} database configuration`, `database-config:${database}`))
      for (const moduleName of text.matchAll(/(?:from\s*|require\()\s*["']([^"']+)["']/gu)) {
        const packageName = moduleName[1] ?? ''
        const importedOrm = ormByPackage.get(packageName)
        if (importedOrm) add(orms, importedOrm, evidence('import', path, `imports the ${importedOrm} ORM package`, `orm-import:${importedOrm}`))
        const imported = driverDatabase.get(packageName)
        if (imported) add(databases, imported, evidence('import', path, `imports the ${imported} database driver`, `database-import:${imported}`))
      }
    }
    return { orms, databases }
  }
}
