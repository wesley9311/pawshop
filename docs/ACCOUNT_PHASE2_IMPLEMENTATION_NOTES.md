# ACCOUNT EXPERIENCE — PHASE 2: FAST SIGN-UP 实施笔记（含安全关键发现）

> 状态：provider 骨架已实现并类型检查通过；发现两个必须妥善处理的架构/安全点，正在闭环。
> 关联：`docs/ACCOUNT_PHASE2_FAST_SIGNUP_AUDIT.md`（审计结论）。

---

## 1. 已实现的骨架

- `src/modules/pawshop-otp-email-auth/otp-email-auth-provider.ts`：`otp-email` auth provider（credentials flow），`register()` = 幂等 get-or-create 且**返回 actorless**（剥离 `app_metadata.customer_id`），`authenticate({email, code})` = 复用 keyed HMAC + 原子一次性 claim 校验 OTP。
- `src/modules/pawshop-otp-email-auth/index.ts`：`ModuleProvider(Modules.AUTH, { services: [OtpEmailAuthProvider] })`。
- `production-modules.cjs`：auth.providers 增加 `otp-email`（options.hmac_secret = jwtSecret，无新 env key）。
- `production-policy.cjs`：`authMethodsPerActor.customer` 增加 `'otp-email'`。

`npm run check:types` 通过。

---

## 2. 安全关键发现 #1：register→refresh 可导致账户接管（必须修）

**链路**：`register()` 返回 actorless token（`actor_id=""`，但 `auth_identity_id` 已绑定）→ `POST /auth/token/refresh` 的 else 分支调用 `validateAuthIdentity(auth_identity_id)` **从 DB 重读完整 identity（含真实 `app_metadata.customer_id`）** → `generateJwtTokenWithChecks` 因当前**未配置 `authVerificationsPerActor`**（`requiresVerification=false`）直接签发 **actor-bound JWT**。

**后果**：任何人 `register(victim@email)` 拿到 actorless token 后调 `refresh`，即可**无 OTP 登录任意已存在 customer**。

**修复**：配置 `http.authVerificationsPerActor.customer = [{ entity_type: 'email', auth_provider: 'otp-email' }]`。这样 `refresh`/`authenticate` 都会走 `validateVerification`，未 `verified_at` 时只返回 actorless token，**堵死绕过 OTP 的升级路径**。注意 `entity_type` 用 `'email'`（框架文档约定），不是 acceptance 脚本里 `verif_otp` 用的 `'customer'`——两者需对齐（见 §4）。

---

## 3. 安全关键发现 #2：emailpass 用户 OTP 登录的跨 provider 绑定

**框架事实**：provider 拿到的 `authIdentityService` 是 **provider-scoped**（`getAuthIdentityProviderService(provider)` 的 `retrieve/create/update` 都按 `provider_identities.provider === 'otp-email'` 过滤）。因此：

- emailpass 用户的 identity 只有 `provider='emailpass'`，`otp-email` 的 `retrieve({entity_id})` 会 NOT_FOUND。
- `otp-email` 的 `create({entity_id})` 会**新建一个独立 auth_identity**（provider='otp-email'），与既有 emailpass identity **分离** → 若直接这样会得到「无 customer_id 的孤儿 identity」，OTP 登录后无法命中原 customer。

**Owner 要求 #8**（emailpass 用户也可 OTP 登录）要求：给既有 auth_identity **追加**一条 `provider='otp-email'` 的 provider_identity（同 identity、同 customer），而不是新建 identity。

**可行路径**：provider 构造函数拿到的 cradle 含 **unscoped `providerIdentityService`**（`auth-module.js` 构造函数注入 `providerIdentityService`），可 `list`/`create` 任意 provider 的 provider_identity。因此 `register()` 可：
1. 用 unscoped `authIdentityService`/`providerIdentityService` 查 email 下是否已有 identity；
2. 已有 identity 且无 otp-email provider → 追加 `provider='otp-email'` 的 provider_identity 到**同一 auth_identity**（不新建 identity、不改 customer_id）；
3. 已有 otp-email provider → 幂等返回；
4. 无 identity → 走 provider-scoped `create` 新建。

---

## 4. entity_type 对齐（必须核实）

- `verif_otp` 的 `request/confirm` 在 acceptance 里用 `entity_type='customer'`。
- 框架 `validateVerification`（`authVerificationsPerActor` 触发）用 `entity_type` 去 `listAuthVerifications({ auth_identity_id, entity_id, entity_type })` 匹配 verification 行。
- 若两者不一致，`authVerificationsPerActor` 的 `entity_type='email'` 会查不到 `entity_type='customer'` 的 verification 行 → 永远 `requiresVerification` 且 `verification` 为 undefined → 死锁。

**必须在实现时统一**：要么 verification 全程用 `'email'`，要么 `authVerificationsPerActor` 用 `'customer'`。需要读生产库 `auth_verification` 现有行的 `entity_type` 实际值再定。

---

## 5. 已闭环的关键决策（截至 10-08）

1. **`entity_type` 对齐**：`verif_otp` 在 production 用 `entity_type='customer'`（`ops/commerce/owner-acceptance.cjs:193` 实证）。`authVerificationsPerActor.customer` 已用 `'customer'`，与 `validateVerification` 的 `entity_type` 匹配一致 —— 不存在死锁。§2/§4 里提到的 `'email'` 是早期不确定表述，已废弃。
2. **`authVerificationsPerActor` 已加**（堵 register→refresh 账户接管），见 `production-policy.cjs`。
3. **`register()` 跨 provider 绑定已完成**（unscoped `providerIdentityService`），满足 Owner #8（emailpass 用户也可 OTP 登录，且不产生孤儿 identity）。
4. **统一登录/注册流程已确定**（`authenticate()` 即「验码 + 一次性消费 + 返回 identity」，**无需**单独 `/auth/verification/confirm`）：
   ```
   ① POST /auth/customer/otp-email/register  {email}         → actorless token（幂等，新老用户通用）
   ② POST /auth/verification/request       {entity_id:email, entity_type:'customer', code_provider:'otp'}  + Bearer → 发码（邮件）
   ③ POST /auth/customer/otp-email          {email, code}     → authenticate 验码+原子消费 → JWT
      · 新用户：identity 无 customer_id → 仍 actorless token（但已 verified）
      · 老用户：identity 已绑 customer_id → actor-bound JWT（直接登录）
   ④ （仅新用户）POST /store/customers      {email} + Bearer  → 建/claim customer + 绑定
   ⑤ （仅新用户）POST /auth/token/refresh    + Bearer          → 升级为 actor-bound JWT
   ```
   注意：③ 的 `authenticate()` 复用 `verif_otp` 请求的 `code_hash`，但**它自己完成 `verified_at` 原子置位**，因此 OTP 登录流程里**不要**再调 `/auth/verification/confirm`（否则 confirm 已消费码，authenticate 再验会「already used」）。

---

## 6. 下一步

1. 前端 `store-api.js` 加 OTP 方法 + `PawShop.html` UI（§9）。
2. loopback 验证矩阵（9 项 acceptance）。
3. sensitive release。
