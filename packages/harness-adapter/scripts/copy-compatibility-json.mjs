import { copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../../../docs/compatibility/deepseek-harness.json', import.meta.url))
const target = fileURLToPath(new URL('../dist/deepseek-harness.json', import.meta.url))
await copyFile(source, target)
