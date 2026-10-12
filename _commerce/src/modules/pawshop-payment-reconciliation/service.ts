import { MedusaService } from '@medusajs/framework/utils'
import { PaymentReconciliation } from './models/payment-reconciliation'

class PawshopPaymentReconciliationService extends MedusaService({ PaymentReconciliation }) {}

export default PawshopPaymentReconciliationService
