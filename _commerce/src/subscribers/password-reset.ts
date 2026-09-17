import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { deliverPasswordReset, passwordResetRecipient, readEmailCredentials } from '../lib/email-channel.cjs'

// Medusa generates the reset token and emits `auth.password_reset`; delivering it
// is the application's job. Without this handler the admin's "forgot password"
// form answers 201 and nothing whatsoever happens - the same class of silent
// success that let the alert channel drop every message while monitoring stayed
// green. Every branch below therefore logs the outcome it reached, including the
// ones where no mail is sent.
export default async function passwordResetHandler({ event, container }: SubscriberArgs<Record<string, unknown>>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const projectConfig = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig
  const recipient = passwordResetRecipient({ event, adminOrigin: projectConfig?.http?.adminCors })

  if (!recipient.supported) {
    logger.warn(`password reset: no email sent - ${recipient.reason}`)
    return
  }

  let credentials
  try {
    credentials = readEmailCredentials(undefined, { serviceGid: typeof process.getgid === 'function' ? process.getgid() : null })
  } catch (error) {
    logger.error(`password reset: no email sent - the email credentials are unusable (${error.message})`)
    return
  }

  const result = await deliverPasswordReset({ recipient, credentials })
  if (!result.delivered) {
    logger.error(`password reset: no email sent to ${recipient.to} - ${result.reason}`)
    return
  }
  // The address is the account's own mailbox and the token is never logged: the
  // link is a single-use credential and the journal is not a secret store.
  logger.info(`password reset: reset email delivered to ${result.to}`)
}

export const config: SubscriberConfig = {
  event: 'auth.password_reset',
}
