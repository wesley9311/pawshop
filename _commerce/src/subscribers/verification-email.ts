import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { deliverVerificationEmail } from '../lib/verification-email.cjs'
import { readEmailCredentials } from '../lib/email-channel.cjs'

// auth.verification_requested → deliver the code.
//
// The auth module generates the code and emits this event; nothing in the
// framework delivers it. This subscriber renders the code into an email and hands
// it to the same SMTP relay the transactional emails use. It logs only a coarse
// outcome — the code and the recipient email never reach the journal.

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }

export default async function verificationEmailHandler({ event, container }: SubscriberArgs<Record<string, unknown>>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const payload = event.data || {}

  // Only the `token` provider carries a numeric code to deliver. Other providers
  // (e.g. a future SMS provider) would carry their own channel and must not be
  // force-routed through email.
  const codeProvider = typeof payload.code_provider === 'string' ? payload.code_provider : ''
  if (codeProvider !== 'token') {
    logger.info(`verification email: no email for code_provider=${codeProvider || 'none'}`)
    return
  }

  // entity_id is the email address being verified (the register flow passes the
  // email as entity_id). Only a real email address is deliverable.
  const to = typeof payload.entity_id === 'string' ? payload.entity_id.trim() : ''
  const code = typeof payload.code === 'string' ? payload.code : ''
  if (!to || !code) {
    logger.warn('verification email: event carried no recipient or code - not sending')
    return
  }

  let credentials
  try {
    credentials = readEmailCredentials(undefined, {
      serviceGid: typeof process.getgid === 'function' ? process.getgid() : null,
    })
  } catch (error) {
    logger.error(`verification email: credentials unusable (${(error as Error).message})`)
    return
  }

  const result = await deliverVerificationEmail({ to, code, credentials })
  if (result.sent) {
    logger.info('verification email: code delivered')
  } else {
    logger.warn(`verification email: not sent - ${result.reason}`)
  }
}

export const config: SubscriberConfig = {
  event: 'auth.verification_requested',
}
