# ACCOUNT EXPERIENCE — PHASE 2: FAST SIGN-UP 审计报告

> 状态：**审计完成，待 Owner 决策后再实施**。  
> 依据：Medusa 2.21.0 官方源码（`_commerce/node_modules/@medusajs/*`）+ 本仓库现状 + 生产库只读查询。  
> 目标：回答 Owner 的三个问题——(1) OTP verified 后能否直接形成 customer authenticated session；(2) 是否需要单独 passwordless provider；(3) 能否后续在账户设置里设 emailpass 密码。

---

## 0. 结论速览

| Owner 问题                                             | 结论                                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OTP verified 后能否直接形成 customer authenticated session？ | **不能靠现有 emailpass provider 实现**。emailpass 的 `authenticate()` 强制要求 `password`；OTP 验证走的是独立的 verification provider（`verif_otp`），它只负责「证明邮箱归属」，**不参与 session 签发**。                          |
| 是否需要单独 passwordless provider？                        | **需要**。必须新增一个 `IAuthProvider` 实现（credentials flow），其 `authenticate()` 用「邮箱 + 6 位 OTP」校验后返回 `success: true + authIdentity`，由 auth 路由签发 JWT。                                             |
| 能否后续在账户设置里设 emailpass 密码？                            | **能，且是官方正路**。emailpass 的 `update()` 已实现「无密码时 `success: true`（跳过）、有密码时写入 scrypt 哈希」。一个 OTP 注册的 auth identity 可以先无密码存在，之后通过 `updateProvider('emailpass', { entity_id, password })` 补设密码。 |

**一句话**：原生 emailpass **无法**安全支持「先 OTP、后设密码」——它的 `register()`/`authenticate()` 都硬性要求密码。正确的、正规的实现是**新增一个最小 passwordless OTP provider**，而不是绕现有 emailpass（临时随机密码、OTP 当长期密码、直接改 DB 都是禁止项）。

---

## 1. 现状：当前注册流程其实已经是「注册即设密码」

`ops/commerce/owner-acceptance.cjs` 的实测流程（第 187–203 行）：

```
POST /auth/customer/emailpass/register   body: { email, password }   ← 密码在此步就设了
POST /auth/verification/request          body: { entity_id, code_provider: 'otp' }
POST /auth/verification/confirm          body: { code, code_provider: 'otp' }
POST /store/customers                    body: { email }             ← 建/claim customer
POST /auth/customer/emailpass            body: { email, password }   ← 登录用同一密码
```

关键事实：**当前 OTP 的定位是「邮箱验证」（证明你拥有这个邮箱），不是「身份认证」**。身份认证始终靠 emailpass 的密码。前端 `store-api.js` 目前也只有 `login(email, password)`，**没有 register 方法**——OTP 注册只在 acceptance harness 里跑过，storefront UI 尚未暴露注册入口。

---

## 2. emailpass provider 源码事实（为什么它做不到 passwordless）

`node_modules/@medusajs/auth-emailpass/dist/services/emailpass.js`：

```js
async register(userData, authIdentityService) {
  const { email, password } = userData.body ?? {};
  if (!password || !isString(password)) {
    return { success: false, error: "Password should be a string" };  // ← 无密码直接失败
  }
  ...
}
async authenticate(userData, authIdentityService) {
  const { email, password } = userData.body ?? {};
  if (!password || !isString(password)) {
    return { success: false, error: "Password should be a string" };  // ← 无密码直接失败
  }
  ... // 用 scrypt-kdf verify(password)
}
async update(data, authIdentityService) {
  const { password, entity_id } = data ?? {};
  if (!entity_id) return { success: false, ... };
  if (!password || !isString(password)) return { success: true };      // ← 无密码 = 跳过（正路！）
  ... // 有密码则写 scrypt 哈希
}
```

三个关键结论：

1. **`register` 无密码必失败** → 不能用 emailpass 做「先 OTP 注册、暂不设密码」。
2. **`authenticate` 无密码必失败** → 不能用 emailpass 做「OTP 登录」。
3. **`update` 无密码返回 `success: true`（跳过）** → 这是「后续补设密码」的正规入口，`updateProvider('emailpass', { entity_id, password })` 会写 scrypt 哈希。

---

## 3. OTP verification provider 的真实边界

`src/modules/pawshop-otp-verification/otp-verification-provider.ts` 是一个 **verification provider**（注册在 `AuthModuleOptions.verification.providers`，前缀 `verif_`），不是 **auth provider**（前缀 `au_`）。

- verification provider 只实现 `request()` / `confirm()`，**没有 `authenticate()`**。
- 它的职责边界：`/auth/verification/request` 发码、`/auth/verification/confirm` 验码并置 `auth_verification.verified_at`。
- **它永远不产生 JWT、不产生 session**。JWT 由 `POST /auth/{actor}/{provider}` 路由在 auth provider 的 `authenticate()` 返回 `success: true + authIdentity` 之后签发（`generateJwtTokenWithChecks`）。

→ 所以「OTP verified 后直接形成 authenticated session」这个诉求，**必须落到一个 auth provider 的 `authenticate()` 里**，verification provider 帮不上。

---

## 4. 最小 passwordless provider 方案（推荐，正规实现）

### 4.1 契约

新增一个 auth provider（credentials flow），`id = 'emailpass'` 之外的独立标识，建议 `id = 'passwordless'` / 内部 `identifier = 'otp-email'`。它实现 `IAuthProvider`：

- **`register()`**：不需要（OTP 注册的「注册」动作 = 发码 + 验码 + `/store/customers` 建 actor，不需要 auth provider 的 register）。
- **`authenticate(data, authIdentityService)`**：
  - 读 `data.body.email` + `data.body.code`；
  - 复用现有 `otp-code.cjs` 的 HMAC 校验逻辑（与 `pawshop-otp-verification` 同一套 keyed HMAC，`deriveHmacKey(JWT_SECRET)`）验证 6 位码；
  - 码有效且未过期且 `verified_at` 未置 → 原子置 `verified_at`（复用现有 atomic claim 思路）；
  - 用 `authIdentityService.retrieve({ entity_id: email })` 拿到 auth identity；
  - 返回 `{ success: true, authIdentity: sanitize(authIdentity) }` → 路由据此签发 JWT。
- **`update()`**：可选，透传（本阶段不需要）。
- **`validateCallback()`**：不实现（credentials flow，非 redirect）。

### 4.2 关键安全不变量（对齐现有 OTP provider）

- 6 位码 CSPRNG 生成，keyed HMAC 存储（`code_hash`），**明文码只进邮件、不落库、不进日志、不进 HTTP 响应**。
- 一次性：确认即原子置 `verified_at`，二次使用拒绝（复用现有 `nativeUpdate WHERE verified_at IS NULL` 模式）。
- TTL 15 分钟，resend 使旧码失效。
- 限速沿用 `verification_rate` 表 + `pawshop_customer_login` nginx zone。
- **OTP 仅用于「本次登录/注册」的短期凭证，绝不作为长期身份**——它验证的是「此刻拥有该邮箱」，一旦签发 JWT，后续身份由 JWT + `customer_id` actor 绑定承载，与密码无关。

### 4.3 与「后续设密码」的衔接（正规、零绕过）

- OTP 注册：`request` → `confirm`（`verif_otp`）→ `POST /store/customers` 建/claim customer + 绑 auth identity。
  - 此时 auth identity **可以有、也可以没有 emailpass 密码**——关键：**OTP 注册路径根本不调 emailpass 的 register/authenticate**，所以不产生任何「伪造 emailpass 身份」。
- 后续设密码：账户设置里调 `updateProvider('emailpass', { entity_id: email, password })`，emailpass 的 `update()` 会写 scrypt 哈希。**这一步之后**，该 email 才具备 emailpass 密码，可用 `POST /auth/customer/emailpass` 登录。
- **禁止项全部避开**：无临时随机密码、OTP 不当长期密码、不绕过 auth_identity/provider 约束、不直接改 DB。

### 4.4 需要确认的一个设计点（涉及 auth identity 的 provider 归属）

OTP 注册创建 auth identity 时，**哪个 provider 拥有 `provider_identity`？**

- 方案 A（推荐）：passwordless provider 拥有该 identity（`provider_identity.provider = 'otp-email'`），emailpass 密码**完全不存在**，直到用户主动设密码时才由 `updateProvider('emailpass')` 建 emailpass 的 provider_identity。
- 方案 B：仍由 emailpass 拥有 identity，但 emailpass 的 `register()` 无密码会失败，所以 B 不可行。

→ **方案 A** 是唯一不绕约束的正规路径。需确认 Medusa 是否允许同一 auth_identity 挂多个 provider_identity（`provider_identity` 唯一索引是 `[entity_id, provider]`，允许同 email 挂 `otp-email` 与 `emailpass` 两条），**这是允许的**——与现有 admin 同时挂 emailpass + google 是同构的（admin 就挂了 `504533680@qq.com|emailpass` 和 `...|google` 两条）。

---

## 5. 数据 / schema 影响

| 项                   | 影响                                                                               |
| ------------------- | -------------------------------------------------------------------------------- |
| 新 auth provider     | 无新 migration（复用 `auth_identity` / `provider_identity` / `auth_verification` 框架表） |
| `auth_verification` | 继续由 `verif_otp` 使用；passwordless provider 的 `authenticate` 读同一套 `code_hash`       |
| `provider_identity` | 新注册会产生 `provider='otp-email'` 的行（非 `emailpass`）；设密码后追加 `emailpass` 行             |
| 新表                  | **无**（不新增 audit 表；现有 `pawshop_customer_auth` 的 claim/rate 表复用）                   |
| 生产数据                | 已存在的 emailpass 用户（含 376692953、店主）**完全不受影响**，继续邮箱+密码登录                            |

---

## 6. UI 优化清单（对应 Owner 目标体验）

| 项             | 说明                                                                                 |
| ------------- | ---------------------------------------------------------------------------------- |
| 登录 / 快速注册入口分清 | 账户 modal 顶部分「登录（已有账号）」与「快速注册（新用户）」两个 tab                                           |
| 验证码 6 位输入     | 6 个单字符 input，自动聚焦/跳格/退格；只收数字                                                       |
| resend 倒计时    | 60s 倒计时，期间禁用；走 `/auth/verification/request`                                        |
| 错码/过期/限流提示    | 复用 `unwrapResponse` 的 `type`（`not_allowed`/`invalid_data`）映射到文案；限流 429 → 明确「请稍后再试」 |
| 注册成功自动进「我的账户」 | OTP confirm + `/store/customers` 成功后，直接用 OTP 登录拿 JWT → 进入账户态                       |
| 已有邮箱不重复注册     | 复用现有 `decideClaim`：已 `has_account=true` → 引导去登录，不进入死路                              |

---

## 7. 明确不做 / 不碰（对齐 Owner 禁止项）

- ❌ 临时随机密码。
- ❌ 把 OTP 当长期密码（OTP 只用于当次登录/注册，用完即弃）。
- ❌ 绕过 `auth_identity` / `provider_identity` 约束（不直接 INSERT/UPDATE 这两张表伪造身份）。
- ❌ 为追求 UX 直接改 DB。
- ❌ 改 PayPal / fulfillment / notification / CloudGull。
- ❌ 复用 admin（`user` actor）auth 给 customer。

---

## 8. 待 Owner 决策（执行前需确认）

1. **是否采纳方案 A**（新增 `passwordless` auth provider，`otp-email` 拥有新身份，emailpass 密码后补）。
2. **「后续设密码」放哪个阶段**：本阶段（Phase 2）就做，还是放到账户设置的后续阶段。
3. **「已有邮箱但未设密码的用户」如何登录**：每次都用 OTP（passwordless 登录），直到他们主动设密码？还是注册成功即引导设密码（可选）？
4. nginx 是否需要为 passwordless 的登录端点新增路由块（若复用 `/auth/customer/` 前缀，则无需新增）。

---

## 9. 源码事实索引（供追溯）

- `auth-emailpass/dist/services/emailpass.js`：`register`/`authenticate` 强制 password；`update` 无密码跳过。
- `types/dist/auth/common/provider.d.ts`：`IAuthProvider` 五方法（authenticate/register/validateCallback/update）。
- `types/dist/auth/common/auth-identity.d.ts`：`provider_identity` 唯一索引 `[entity_id, provider]`，同 email 可挂多 provider。
- `types/dist/auth/service.d.ts`：`authenticate(provider, input) → AuthenticationResponse { success, authIdentity }`，`updateProvider(provider, data)`。
- `types/dist/auth/common/provider.d.ts`：`AuthenticationResponse.success + authIdentity` 是签发 JWT 的依据。
- 本仓库 `src/modules/pawshop-otp-verification/`：现有 keyed-HMAC OTP verification provider（`verif_otp`），可复用其 `otp-code.cjs` 的 `deriveHmacKey`/`generateOtpCode`/`digestCode`。
- 本仓库 `src/lib/customer-claim.cjs`：`decideClaim`（create/claim/already_claimed/conflict），Phase 2 复用。
