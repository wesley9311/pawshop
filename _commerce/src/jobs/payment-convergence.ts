import { convergePayPalSessions } from '../lib/payment-convergence'
export default async function (container: any) { await convergePayPalSessions(container) }
export const config = { name: 'pawshop-payment-convergence', schedule: { interval: 60 * 1000, concurrency: 'forbid' } }
