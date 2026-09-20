import { defineConfig } from 'tsup'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
const harnessCompatibilitySource = canonicalPath(resolve('../harness-adapter/src/compatibility.ts'))
const bundleCompatibilityLocator = canonicalPath(resolve('src/compatibility-locator.ts'))

export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts', 'src/production.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  // Node ESM output must support built-in requires from bundled CommonJS parsers.
  // The browser client is rebuilt separately by build-client-entry.mjs.
  banner: { js: "import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);" },
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: true,
  clean: true,
  minify: false,
  noExternal: [/^(?!react(?:-dom)?(?:\/|$)).*/u],
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  outDir: 'lib',
  esbuildPlugins: [{
    name: 'bundle-adjacent-compatibility',
    setup(build) {
      build.onResolve({ filter: /compatibility-locator\.js$/ }, (args) => {
        if (canonicalPath(args.importer) !== harnessCompatibilitySource) return
        return { path: bundleCompatibilityLocator }
      })
    },
  }],
  esbuildOptions(options) {
    options.alias = {
      '@dsh-backend-team/harness-adapter': resolve('../harness-adapter/src/index.ts'),
    }
  },
})
