/**
 * Browser client bundle for orchestra-dsh, mirroring the DeepSeek Harness
 * `clientBundle` protocol (packages/client/tsdown.client.ts):
 *
 * - CJS closure-factory artifact: `window.__ModuleLoader__.load({ id,
 *   factory: (require) => ... })`; externals resolve through the loader
 *   module table (platform seed entries + the runtime store exemption).
 * - Every other @deepseek-ai value import is a build error (purity gate).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type UserConfig } from 'tsdown'

/** Platform seed entries the browser module table answers (external). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Runtime store engine: documented exemption, external at runtime. */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/**
 * Module id this bundle registers under via `__ModuleLoader__.load`. The host
 * looks the bundle up by the plugin's package name, so this must BE the
 * package name — read from package.json rather than restating it.
 */
const PLUGIN_ID: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).name

const config: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'lib/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default config
