import { DrizzleMigrationAdapter, type DrizzleMigrationRunner } from './drizzle-migration-adapter.js'
/** Uses a project's existing migration CLI; it never translates another ORM into Drizzle. */
export class ExistingMigrationAdapter extends DrizzleMigrationAdapter { constructor(runner: DrizzleMigrationRunner) { super(runner) } }
