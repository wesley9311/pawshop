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
        // The admin UI and the API it calls are always served from the same
        // origin (the host nginx in front of this process), so the admin SDK has
        // to stay same-origin. An empty backendUrl is Medusa's own default and
        // makes @medusajs/js-sdk resolve window.location.origin at runtime, which
        // is correct both through the tunnel (http://127.0.0.1:9000) and through
        // the public entry (https://pawlivora.com/app/).
        //
        // This used to be `projectConfig.http.adminCors`, which baked
        // http://127.0.0.1:9000 into the admin bundle at build time: the UI then
        // called the *visitor's own* loopback address, so it only ever worked
        // while an SSH tunnel happened to be listening on that port, and every
        // other browser got an empty provider list ("register an authentication
        // provider") instead of the login form (2026-09-19).
        //
        // adminCors/authCors deliberately keep their loopback value: they are the
        // server-side CORS allowlist (no effect on same-origin requests) and the
        // origin password-reset.js builds its links from.
        admin: { backendUrl: '' },
        featureFlags: { caching: true },
        modules: productionModules({ redisUrl: projectConfig.redisUrl, fileStorage: projectConfig.fileStorage }),
      }
    : {}),
})
