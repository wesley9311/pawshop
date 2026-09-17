import { defineConfig } from '@medusajs/framework/utils'
import { validateLocalEnvironment } from './src/lib/local-policy.cjs'
import { validateProductionEnvironment } from './src/lib/production-policy.cjs'
import { productionModules } from './src/lib/production-modules.cjs'
import { isProductionMode } from './src/lib/production-modes.cjs'

// Production receives secrets from the host's secret manager; no env-file fallback.
// Both production profiles share this branch; only the middleware and the runtime
// marker differ, so opening the storefront never means a different module graph.
const productionMode = isProductionMode(process.env.PAWSHOP_MODE)
const projectConfig = productionMode
  ? validateProductionEnvironment(process.env)
  : validateLocalEnvironment(process.env)

module.exports = defineConfig({
  projectConfig,
  ...(productionMode
    ? {
        admin: { backendUrl: projectConfig.http.adminCors },
        featureFlags: { caching: true },
        modules: productionModules({ redisUrl: projectConfig.redisUrl, fileStorage: projectConfig.fileStorage }),
      }
    : {}),
})
