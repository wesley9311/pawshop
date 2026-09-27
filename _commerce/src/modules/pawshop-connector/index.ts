import { Module } from '@medusajs/framework/utils'
import PawshopConnectorService from './service'

// PawShop's own persistence for the CloudGull Connector V1.1.
//
// It owns four tables and nothing else. It has no relations into the commerce
// models, so the migration below only ever ADDS tables: no core commerce table
// is altered, and dropping this module can never touch commerce data.
//
// CloudGull has no database access to any of this. The only thing it ever sees
// is the JSON produced by the connector's HTTP layer.
export const PAWSHOP_CONNECTOR_MODULE = 'pawshopConnector'

export default Module(PAWSHOP_CONNECTOR_MODULE, {
  service: PawshopConnectorService,
})
