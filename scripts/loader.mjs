/**
 * Standalone Cordis loader for local development / CI without a harness:
 *
 *   npm run dev     (node --import tsx scripts/loader.mjs)
 *
 * Mounts ./cordis.yml (config-list dialect) and exits 0 once the plugins
 * report ready. The harness install format is cordis.patch.yml instead;
 * `dsh web --patch ./cordis.patch.yml` is the harness way to run this plugin.
 */

import { Context } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@deepseek-ai/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})

// The plugin logs its own load line; report success and exit cleanly.
console.log('[loader] cordis.yml mounted OK')
process.exit(0)
