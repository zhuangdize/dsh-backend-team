import { Global, Module } from '@nestjs/common'
export function resolveDatabaseCredentialReference(reference = process.env.DATABASE_CREDENTIAL_REF): string {
  if (reference === undefined || reference.trim() === '') throw new Error('DATABASE_CREDENTIAL_REF is required')
  if (!/^[A-Za-z0-9._:/-]+$/u.test(reference)) throw new Error('invalid database credential reference')
  return reference
}
@Global()
@Module({ providers: [{ provide: 'DATABASE_CREDENTIAL_REF', useFactory: () => resolveDatabaseCredentialReference() }], exports: ['DATABASE_CREDENTIAL_REF'] })
export class DatabaseModule {}
