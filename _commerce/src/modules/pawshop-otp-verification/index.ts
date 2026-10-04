import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import OtpVerificationProvider from './otp-verification-provider'

// Registration wrapper for the 6-digit OTP verification provider.
//
// `ModuleProvider(Modules.AUTH, { services: [...] })` produces the
// `{ module, services }` shape `moduleProviderLoader` expects; the auth loader's
// `verificationRegistrationFn` then instantiates `OtpVerificationProvider` as a
// singleton under `verif_otp` and adds `otp` to the verification identifiers.
//
// The provider is registered through `AuthModuleOptions.verification.providers`
// (not `providers`), so it is reachable by `code_provider: 'otp'` from
// `/auth/verification/request` and `/auth/verification/confirm`.
export default ModuleProvider(Modules.AUTH, {
  services: [OtpVerificationProvider],
})
