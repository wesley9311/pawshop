import { defineConfig } from '@medusajs/framework/utils'
import { validateLocalEnvironment } from './src/lib/local-policy.cjs'

// No fallback passwords or production environment loading.
module.exports = defineConfig({
  projectConfig: validateLocalEnvironment(process.env),
})
