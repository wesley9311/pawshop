import { createHash } from 'node:crypto'
const { Pool } = require('pg')
let pool: any
// Session-scoped PostgreSQL advisory locks are shared by all instances and
// released by PostgreSQL on connection/process death. No stale TTL row to fix.
export async function withPaymentSessionLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (!id || !/^payses_[A-Za-z0-9]+$/.test(id)) throw Error('payment_session_lock_invalid')
  pool ||= new Pool({ connectionString: process.env.DATABASE_URL, max: 4,
    connectionTimeoutMillis: 5000, query_timeout: 5000, allowExitOnIdle: true,
    keepAlive: true, keepAliveInitialDelayMillis: 1000 })
  const client = await pool.connect()
  const key = createHash('sha256').update('pawshop-payment-session:' + id).digest().readBigInt64BE().toString()
  let locked = false, broken = false
  const onError = () => { broken = true }
  client.on('error', onError)
  try {
    const deadline = Date.now() + 15000
    while (!locked) {
      if (broken) throw Error('payment_session_lock_connection_lost')
      locked = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key])).rows[0].locked
      if (!locked) {
        if (Date.now() >= deadline) throw Error('payment_session_lock_busy')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    const result = await work()
    if (broken) throw Error('payment_session_lock_connection_lost')
    return result
  } finally {
    if (locked && !broken) {
      try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]) } catch { broken = true }
    }
    client.removeListener('error', onError)
    client.release(broken)
  }
}
