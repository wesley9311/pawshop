import type { ExecArgs } from '@medusajs/framework/types'
import { linkSalesChannelsToStockLocationWorkflow } from '@medusajs/core-flows'

// One-time, operator-invoked link between a stock location and a sales channel.
//
// The Store API surfaces a cart's shipping options by walking
//   sales_channel -> stock_location -> fulfillment_set -> service_zone -> shipping_option
// If the sales_channel_stock_location link is missing, the walk dead-ends and
// `GET /store/shipping-options?cart_id=...` returns an empty list even though the
// shipping option, service zone, fulfillment set and price all exist. This was the
// exact symptom observed on 2026-09-22: Standard Shipping (USD 9.90) was fully
// configured but never offered to a real cart.
//
// This script writes the link through the official workflow (never a raw SQL
// insert), so the join table and any Medusa-side invariants stay authoritative.
//
// Invocation:
//   STOCK_LOCATION_ID=<sloc_id> SALES_CHANNEL_ID=<sc_id> \
//     npx medusa exec ./src/scripts/link-stock-location-sales-channel.ts

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

export default async function linkStockLocationSalesChannel({ container }: ExecArgs) {
  const stockLocationId = requiredEnv('STOCK_LOCATION_ID')
  const salesChannelId = requiredEnv('SALES_CHANNEL_ID')

  const workflow = linkSalesChannelsToStockLocationWorkflow(container)
  await workflow.run({
    input: {
      id: stockLocationId,
      add: [salesChannelId],
      remove: [],
    },
  })

  console.log(
    `Linked stock location ${stockLocationId} -> sales channel ${salesChannelId}.`,
  )
}
