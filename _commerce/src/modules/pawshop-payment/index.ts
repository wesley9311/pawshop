import { withPaymentSessionLock } from '../../lib/payment-session-lock'
const { ModulesSdkUtils, toMikroOrmEntities, Modules } = require('@medusajs/framework/utils')
const { dirname, join } = require('node:path')
const paymentRoot = dirname(require.resolve('@medusajs/payment'))
const models = require(join(paymentRoot, 'models'))
const services = require(join(paymentRoot, 'services'))
const entities = toMikroOrmEntities(Object.values(models))
const connectionLoader = ModulesSdkUtils.mikroOrmConnectionLoaderFactory({ moduleName: Modules.PAYMENT, moduleModels: entities, migrationsPath: join(paymentRoot, 'migrations') })
const containerLoader = ModulesSdkUtils.moduleContainerLoaderFactory({ moduleModels: Object.fromEntries(entities.map((m: any) => [m.name, m])), moduleServices: services, moduleRepositories: {} })
const standard = require('@medusajs/payment').default
// Retain Medusa's models, provider loader, links and transaction boundaries.
// Serialize the complete official operation, including its initial session read.
class PawShopPaymentService extends standard.service {
  async inspectPayPalSession(id: string) {
    const session = await this.retrievePaymentSession(id)
    if (session.provider_id !== 'pp_paypal_paypal' || session.data?.auto_capture_policy !== 'pawshop-auto-capture-v1') return false
    const result = await this.paymentProviderService_.retrieveProvider(session.provider_id).retrievePayment({ data: session.data })
    return ['APPROVED', 'AUTHORIZED', 'CAPTURED', 'PENDING_CAPTURE'].includes(result.data?.status)
  }
  async authorizePaymentSession(id: string, context: any, sharedContext?: any) {
    return withPaymentSessionLock(id, async () => {
      let result = await super.authorizePaymentSession(id, context, sharedContext)
      // The official idempotent early return skips this aggregate update. A
      // crash after capture commit must still repair the collection aggregate.
      const session = await this.retrievePaymentSession(id)
      if (result && !result.captured_at && session.provider_id === 'pp_paypal_paypal' &&
          session.data?.auto_capture_policy === 'pawshop-auto-capture-v1') {
        // Repair a committed authorization without a trusted capture through
        // the official provider-aware capture service, never a direct DB write.
        result = await this.capturePayment({ payment_id: result.id })
      }
      await this.maybeUpdatePaymentCollection_(session.payment_collection_id, sharedContext)
      return result
    })
  }
}

// Use the installed Medusa migration history without copying or generating a
// replacement schema for this service-only extension.
const migrationOptions = { moduleName: Modules.PAYMENT, models: entities, pathToMigrations: join(paymentRoot, 'migrations') }
export const runMigrations = ModulesSdkUtils.buildMigrationScript(migrationOptions)
export const revertMigration = ModulesSdkUtils.buildRevertMigrationScript(migrationOptions)
export const generateMigration = ModulesSdkUtils.buildGenerateMigrationScript(migrationOptions)

export default { ...standard, service: PawShopPaymentService, loaders: [connectionLoader, containerLoader, ...standard.loaders], runMigrations, revertMigration, generateMigration }
