import { expect, it } from 'vitest'
import { DrizzleKitGenerator } from '../src/drizzle-kit-generator.js'

it('refuses remote or non-PostgreSQL sources before reading tooling or spawning a process', async () => {
  const generator = new DrizzleKitGenerator({ workspaceRoot: '/nonexistent', toolingRoot: '/nonexistent', nodeExecutable: '/nonexistent' })
  for (const source of ['postgresql://example.com:5432/db', 'https://127.0.0.1:5432/db', 'postgresql://127.0.0.1/db']) {
    await expect(generator.generate(source, 'postgresql://127.0.0.1:5432/design')).rejects.toThrow('local PostgreSQL')
    await expect(generator.generate('postgresql://127.0.0.1:5432/base', source)).rejects.toThrow('local PostgreSQL')
  }
})
