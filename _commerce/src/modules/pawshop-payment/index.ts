import { withPaymentSessionLock } from '../../lib/payment-session-lock'
const { ModulesSdkUtils, toMikroOrmEntities, Modules } = require('@medusajs/framework/utils')
const { dirname, join } = require('node:path')
const paymentRoot = dirname(require.resolve('@medusajs/payment'))
const models = require(join(paymentRoot, 'models'))
const services = require(join(paymentRoot, 'services'))
const entities = toMikroOrmEntities(Object.values(models))
const connectionLoader = ModulesSdkUtils.mikroOrmConnectionLoaderFactory({ moduleName: Modules.PAYMENT, moduleModels: entities, migrationsPath: join(paymentRoot, 'migrations') })
const containerLoader = ModulesSdkUtils.moduleContainerLoaderFactory({ moduleModels: Object.fromEntries(entities.map((m: any) => [m.name, m])), moduleServices: services, moduleRepositories: {} })
const isolation = require('../../lib/paypal-environment.cjs')
const standard = require('@medusajs/payment').default
// Retain Medusa's models, provider loader, links and transaction boundaries.
// Serialize the complete official operation, including its initial session read.
class PawShopPaymentService extends standard.service {
  private async assertCollectionEnvironment(id: string, environment: string, sharedContext?: any) {
    const sessions = await this.listPaymentSessions({payment_collection_id:id}, {take:1000}, sharedContext)
    const payments = await this.listPayments({payment_collection_id:id}, {take:1000}, sharedContext)
    if(sessions.length>=1000 || payments.length>=1000)throw Error('paypal_environment_relation_ambiguous')
    const rows=[...sessions,...payments]
    if(rows.some((r:any)=>r.provider_id!=='pp_paypal_paypal'))throw Error('paypal_environment_mixed_provider')
    if(rows.length && isolation.sameEnvironment(...rows.map((r:any)=>r.data))!==environment)throw Error('paypal_environment_mixed')
  }
  async createPaymentSession(collectionId: string, input: any, sharedContext?: any) {
    if(input.provider_id==='pp_paypal_paypal') {
      const provider=this.paymentProviderService_.retrieveProvider(input.provider_id)
      await this.assertCollectionEnvironment(collectionId, provider.activeEnvironment(), sharedContext)
    }
    return super.createPaymentSession(collectionId,input,sharedContext)
  }
  async getWebhookActionAndData(eventData: any, sharedContext?: any) {
    const result = await super.getWebhookActionAndData(eventData, sharedContext)
    if (result.action !== 'not_supported') {
      const session = await this.retrievePaymentSession(result.data.session_id)
      if (session.provider_id !== 'pp_paypal_paypal' || isolation.environmentOf(session.data) !== result.data.paypal_environment) {
        throw Error('paypal_webhook_environment_mismatch')
      }
    }
    return result
  }
  async updatePaymentSession(input: any, sharedContext?: any) {
    const session = await this.retrievePaymentSession(input.id)
    if (session.provider_id === 'pp_paypal_paypal') isolation.sameEnvironment(session.data, input.data)
    return super.updatePaymentSession(input, sharedContext)
  }
  async updatePayment(input: any, sharedContext?: any) {
    if(input.data) {
      const payment=await this.retrievePayment(input.id,{},sharedContext)
      if(payment.provider_id==='pp_paypal_paypal')isolation.sameEnvironment(payment.data,input.data)
    }
    return super.updatePayment(input,sharedContext)
  }
  private async assertPaymentEnvironment(id: string, sharedContext?: any) {
    const payment = await this.retrievePayment(id, {}, sharedContext)
    if (payment.provider_id !== 'pp_paypal_paypal') return
    const session = await this.retrievePaymentSession(payment.payment_session_id, {}, sharedContext)
    const environment=isolation.sameEnvironment(session.data, payment.data)
    await this.assertCollectionEnvironment(payment.payment_collection_id, environment, sharedContext)
  }
  async capturePayment(input: any, sharedContext?: any) {
    await this.assertPaymentEnvironment(input.payment_id, sharedContext)
    return super.capturePayment(input, sharedContext)
  }
  async refundPayment(input: any, sharedContext?: any) {
    await this.assertPaymentEnvironment(input.payment_id, sharedContext)
    return super.refundPayment(input, sharedContext)
  }
  async cancelPayment(id: string, sharedContext?: any) {
    await this.assertPaymentEnvironment(id, sharedContext)
    return super.cancelPayment(id, sharedContext)
  }
  async inspectPayPalSession(id: string) {
    const session = await this.retrievePaymentSession(id)
    if (session.provider_id !== 'pp_paypal_paypal' || session.data?.auto_capture_policy !== 'pawshop-auto-capture-v1') return false
    const result = await this.paymentProviderService_.retrieveProvider(session.provider_id).retrievePayment({ data: session.data })
    return ['APPROVED', 'AUTHORIZED', 'CAPTURED', 'PENDING_CAPTURE'].includes(result.data?.status)
  }
  async authorizePaymentSession(id: string, context: any, sharedContext?: any) {
    return withPaymentSessionLock(id, async () => {
      const before = await this.retrievePaymentSession(id, { relations: ['payment'] })
      if (before.provider_id === 'pp_paypal_paypal') {
        const environment=isolation.environmentOf(before.data)
        await this.assertCollectionEnvironment(before.payment_collection_id, environment, sharedContext)
        if (before.payment) isolation.sameEnvironment(before.data, before.payment.data)
      }
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
