import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import OtpEmailAuthProvider from './otp-email-auth-provider'

// Registration wrapper for the passwordless "email + 6-digit OTP" auth provider.
//
// `ModuleProvider(Modules.AUTH, { services: [...] })` produces the
// `{ module, services }` shape `moduleProviderLoader` expects; the auth loader's
// `registrationFn` instantiates `OtpEmailAuthProvider` as a singleton under
// `au_otp-email` and adds `otp-email` to the auth identifiers.
//
// The provider is registered through `AuthModuleOptions.providers` (NOT
// `verification.providers`), so it is reachable as an authentication provider at
// `POST /auth/customer/otp-email` and `POST /auth/customer/otp-email/register`.
export default ModuleProvider(Modules.AUTH, {
  services: [OtpEmailAuthProvider],
})
