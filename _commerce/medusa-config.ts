import { defineConfig } from '@medusajs/framework/utils'
import { validateLocalEnvironment } from './src/lib/local-policy.cjs'
import { validateProductionEnvironment } from './src/lib/production-policy.cjs'

// Production receives secrets from the host's secret manager; no env-file fallback.
const projectConfig = process.env.PAWSHOP_MODE === 'production-admin-only'
  ? validateProductionEnvironment(process.env)
  : validateLocalEnvironment(process.env)

module.exports = defineConfig({
  projectConfig,
  ...(process.env.PAWSHOP_MODE === 'production-admin-only'
    ? { admin: { backendUrl: projectConfig.http.adminCors } }
    : {}),
})
