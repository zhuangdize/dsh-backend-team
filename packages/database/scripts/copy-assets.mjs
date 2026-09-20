import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(packageRoot, 'src/dbgate-loopback-preload.cjs')
const destination = resolve(packageRoot, 'dist/dbgate-loopback-preload.cjs')
await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
await copyFile(source, destination)
await chmod(destination, 0o644)
