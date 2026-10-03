# CUSTOMER AUTH FOUNDATION — PHASE 1 设计文档

> 状态：设计 + 只读验证已完成，Owner 已授权进入实施。
> 依据：Medusa 2.21.0 官方源码（`node_modules/@medusajs/*`）+ 本仓库现状 + 生产库只读查询。

---

## 0. 实施前两项只读检查结果（Owner 要求，2026-10-04）

### 0.1 nginx 需要代理的 customer auth endpoints（禁止放开整个 /auth/）

customer 完整 flow 触达的端点，逐一核对现有 nginx `location`：

| 端点 | 用途 | 现有 nginx | 需新增 |
|---|---|---|---|
| `POST /auth/customer/emailpass` | login | ❌（落到 `location /` → 404） | ✅ `location /auth/customer/` |
| `POST /auth/customer/emailpass/register` | register | ❌ | ✅ 同上 |
| `POST /auth/verification/request` | 发验证码 | ❌ | ✅ `location /auth/verification/` |
| `POST /auth/verification/confirm` | 验码 | ❌ | ✅ 同上 |
| `POST /auth/session` | JWT→cookie | ✅ `location = /auth/session`（exact，已共享 admin） | 无需 |
| `DELETE /auth/session` | logout | ✅ 同上（同一 exact 块） | 无需 |
| `POST /store/customers` | 建/claim customer | ✅ `location /store/` | 无需 |
| `GET /store/customers/me` | 本人身份 | ✅ `location /store/` | 无需 |

**结论**：只新增两个**前缀**块 `location /auth/customer/` 与 `location /auth/verification/`，**绝不放开整个 `/auth/`**（`/auth/user/*` 与 `/auth/mfa/*` 继续只由 admin 精确路由覆盖，mfa 无任何 customer 入口）。`/auth/session` 已由 exact-match 块覆盖，天然共享，无需新增也无需改。

### 0.2 normalized email 多 guest 检查（生产库只读）

- `SELECT LOWER(TRIM(email)) ... GROUP BY 1 HAVING count(*) > 1` → **空**，即当前**没有任何 normalized email 对应多个 customer**。
- 13 个 guest customer 的 normalized email 全部唯一，无一重复。

→ claim 分支当前只会命中 `0`（新建）或 `1`（claim 既有 guest）；`>1` 分支当前 0 例，但**仍必须实现为「stop/report，不自动 merge」**（防御未来脏数据）。

### 0.3 额外发现的框架默认约束（影响 claim 实现）

`customer` 表有框架默认唯一索引：

```sql
CREATE UNIQUE INDEX "IDX_customer_email_has_account_unique"
  ON customer (email, has_account) WHERE deleted_at IS NULL
```

- 含义：每 email 至多一条 `has_account=false` + 至多一条 `has_account=true`。
- 后果：claim 必须**更新既有 guest 行**（`has_account: false→true`），**不能新建**；否则会同时存在 `(email,false)` 与 `(email,true)` 两行（官方 stock workflow 正是这个 bug，会留下孤立的 guest customer）。
- 该索引是框架默认（`@medusajs/customer/models/customer.js`），生产已存在，**无需 migration**。

---

## 1. 结论速览

Medusa 2.21.0 **原生就具备完整的 customer auth 能力**，不需要自己 invent 第二套 auth framework。正确路径是「**走官方 auth 流程 + 补一块关键的 guest-claim 定制**」。

关键判断：

| 能力 | Medusa 2.21.0 现状 | 结论 |
|---|---|---|
| customer 注册 | `POST /auth/customer/emailpass/register` → 发 actorless token → `POST /store/customers` 绑 actor | ✅ 官方有，可用 |
| login | `POST /auth/customer/emailpass` → JWT | ✅ 官方有 |
| session | `POST /auth/session` → `connect.sid` cookie（session 存服务端） | ✅ 官方有 |
| logout | `DELETE /auth/session` | ✅ 官方有 |
| 本人身份 | `GET /store/customers/me`（`authenticate("customer")` 强制） | ✅ 官方有，匿名自动 401 |
| email 验证 | `POST /auth/verification/request` + `/confirm`（内置 `token` provider，2.16.0+） | ⚠️ 有「生成 token」，但**不投递**——需接现有 SMTP |
| **guest 订单 claim** | ❌ **官方 `createCustomerAccountWorkflow` 不复用已有 guest customer，会建重复** | 🔴 必须自定义，见 §5 |

### 必须做的定制（这是本阶段真正的难点）

1. **注册时不建重复 customer**：官方 `validateCustomerAccountCreation` 在「存在 `has_account=false` 的 guest customer + 带 authIdentity」时**放行**，然后 `createCustomersStep` 会**新建一个 customer** 并把 auth identity 绑到新 customer，原来的 guest customer（挂着历史订单）被孤立。→ 需要一个自定义注册 workflow：email 已存在 guest customer 时，**把 auth identity 绑到那个既有 customer 并把 `has_account` 置真**，而不是新建。
2. **`authMethodsPerActor` 必须显式加 `customer: ['emailpass']`**：当前配置 `{ user: [...] }`，customer 缺省「全放行」是**偶然**行为；且 google 的 callback 硬编码 `/app/login`（admin），绝不能放给 customer。
3. **nginx 需要新增 `location /auth/customer/` 反代块**：当前只有 `/auth/user/`，customer 请求会落到 `location /` → 静态 404。
4. **email 验证投递**：内置 `token` provider 只生成/存哈希，不投递。要接 `pawshop-notification` 的 SMTP 通道发验证码邮件。

---

## 2. Auth Architecture（目标态）

```
浏览器（storefront，同源 https://pawlivora.com）
   │
   ├── POST /auth/customer/emailpass/register   → { token } (actorless JWT)
   │        └─ 触发 email 验证（request/confirm）→ 验证通过后：
   ├── POST /store/customers                    → 创建或【claim】customer + 绑 auth_identity
   │
   ├── POST /auth/customer/emailpass            → { token } (含 customer actor 的 JWT)
   ├── POST /auth/session                       → 用 Bearer JWT 换 connect.sid cookie
   ├── GET  /store/customers/me                 → 由 session cookie 解析 authenticated customer
   ├── GET  /store/customers/me/orders          → 【本阶段后续 My Orders 用】按 actor_id 过滤
   └── DELETE /auth/session                     → logout（销毁 session + clear cookie）
```

**信任链（安全核心）**：
- JWT（Bearer）只在「换 session」这一跳用；**业务读操作只认 session cookie**（服务端存储，`connect.sid`）。
- 授权来源 = **服务端 session 里解析出的 `auth_context.actor_id`**，前端**永不传 customer_id**。
- 与 Admin auth 完全隔离：Admin 走 `user` actor + emailpass/google + `/app`；Customer 走 `customer` actor + emailpass only。

**localStorage token 不是信任源**：前端只在注册/登录瞬间持有 actorless/bearer JWT 用于「换 session」，换完即弃；持久会话靠 `connect.sid`（httpOnly cookie，服务端 session）。不把 localStorage token 当持久身份。

---

## 3. API Contract

### 3.1 注册（含 email 验证 + guest claim）

```
POST /auth/customer/emailpass/register
  body: { email, password }
  → 200 { token }                          # actorless JWT，仅用于后续验证/建 actor

POST /auth/verification/request            # 用 actorless token (Bearer)
  body: { entity_id: email, entity_type: 'customer', code_provider: 'token' }
  → 201 { verification }                    # 投递 6 位验证码到 email（本阶段接 SMTP）

POST /auth/verification/confirm             # 用 actorless token (Bearer)
  body: { code, code_provider: 'token' }
  → 200 { entity_id, verified_at, ... }

POST /store/customers                       # 用 actorless token (Bearer)，验证通过后
  body: { first_name?, last_name?, email }
  → 200 { customer }
  # 定制点：email 命中 has_account=false 的 guest customer 时，
  #        绑到该 customer（has_account=true），不新建。
```

### 3.2 登录 / session / logout

```
POST /auth/customer/emailpass
  body: { email, password }
  → 200 { token }                          # 含 customer actor 的 JWT

POST /auth/session                          # Bearer: token
  → 200 { user: { ... } }                  # Set-Cookie: connect.sid

DELETE /auth/session                        # cookie 在场
  → 200 { success: true }                  # 销毁 session + clear cookie
```

### 3.3 本人身份（授权边界）

```
GET /store/customers/me                     # session cookie
  → 200 { customer }                        # 匿名 → 401
```

### 3.4 guest claim 专用端点（本阶段落地，供 My Orders 使用）

```
GET /store/customers/me/orders             # 后续 My Orders 阶段；本阶段只定契约
  → 200 { orders: [...] }                  # 按 session actor_id 过滤，前端零 customer_id
```

---

## 4. Guest Claim State Machine

```
guest customer (has_account=false, 挂历史订单)
  │
  ├─ 顾客注册 email（未验证）
  │     └─ [email 未验证] → 拒绝 claim，要求先验证
  │
  ├─ 顾客完成 email 验证（auth_identity 已带 email 的 provider_identity）
  │     └─ POST /store/customers
  │           ├─ email 命中「has_account=false 的 guest customer」
  │           │     → 绑 auth_identity ↔ 该 customer，has_account=true
  │           │       历史订单天然归属（order.customer_id 不变）
  │           │       （claim 幂等：再次注册同 email → 已 has_account → 拒绝）
  │           │
  │           ├─ email 命中「has_account=true 的 customer」
  │           │     → 已归属 → 拒绝（不重复、不覆盖）
  │           │
  │           └─ email 未命中任何 customer
  │                 → 新建 customer（has_account=true）+ 绑 auth_identity
  │
  └─ audit：每次 claim 写一条 audit 记录（见 §6）
```

**claim 不可变约束**：
- 只动 `customer.has_account` 与 `auth_identity.app_metadata.customer_id`；**绝不改 `order` 任何行**。
- 历史订单 item snapshot（title/quantity/price）**不动**。
- 已归属其他 authenticated customer 的订单（`order.customer_id` 指向别的 has_account=true customer）**不可 claim**——因为 claim 是按「email 匹配的 guest customer」定位，不存在跨 customer 抢单路径；但仍要在实现里显式校验 `order.customer_id` 未指向另一个 has_account=true 的 customer。

---

## 5. 数据影响 & schema 影响

### 5.1 生产现状（已只读确认）

| 表 | 现状 |
|---|---|
| `customer` | 13 行，`has_account=false` **13/13**（全部 guest） |
| `order` | 23 行，`customer_id` 23/23 非空（都指向上述 guest customer） |
| `auth_identity` | 2 行，`app_metadata.user_id` **都指向店主** `user_01M2Q720G75E4DC1BY360593H2`（admin emailpass + google） |
| `provider_identity` | 仅 admin 的两条 provider 记录 |
| `auth_verification` | 0 行（从未用过） |

### 5.2 新 auth 流程写入的表（均 Medusa 框架自带，无自定义 migration）

- `auth_identity`（新行：customer 的 identity）
- `provider_identity`（新行：`entity_id=email, provider=emailpass`）
- `auth_verification`（验证码 token hash，验证后 `verified_at` 置真）
- `customer`（已有行 `has_account` 置真，或新行）

### 5.3 自定义 schema 影响

- **需新增一张 audit 表**（见 §6）——这是唯一真正需要 migration 的地方。
- 其余全走框架现有表，**零手写 migration**（auth 模块迁移已内置）。

### 5.4 既有 13 guest customers 兼容策略

- **不迁移、不清库、不重建**。13 个 guest customer 原地保留。
- 当某 email 的顾客注册并验证后，**原地升级**该 guest customer 为 `has_account=true`（claim），其历史订单自动可见。
- 未注册的 guest customer 维持现状，仍可用 guest lookup（order_number + email）。

---

## 6. Guest Claim Audit（自定义，需 migration）

新增一张表 `pawshop_customer_claim_audit`：

| 列 | 说明 |
|---|---|
| `id` | 主键 |
| `customer_id` | 被 claim 的 customer |
| `auth_identity_id` | 绑定的 auth identity |
| `email` | claim 时的 email（冗余，便于审计检索） |
| `claim_kind` | `new`（新建）\| `guest_claim`（升级 guest） |
| `claimed_at` | 时间戳 |
| `claimed_by` | `customer-registration`（固定，无人工入口） |

- 仅追加（append-only），无更新/删除。
- 触发：仅在「验证通过后的 `POST /store/customers`」成功路径写。
- 幂等：以 `auth_identity_id` 唯一约束保证同 identity 只 claim 一次。

---

## 7. Security Risks & Mitigations

| 风险 | 缓解 |
|---|---|
| 前端传 customer_id 授权 | 端点只从 `req.auth_context.actor_id` 取身份，忽略一切 body/query 里的 customer_id |
| 匿名访问他人订单 | `/store/customers/me*` 统一 `authenticate("customer")`，匿名 401 |
| 越权：猜 email 注册抢占他人 guest 订单 | email 验证是硬门槛；验证码 15 分钟 TTL、一次性、服务端哈希存储 |
| 注册撞库/枚举 | 沿用 admin 登录限速思路，`/auth/customer/*` 挂独立 `pawshop_customer_login` 限速区 |
| token 泄露 | Bearer JWT 仅短寿命用于换 session；持久态走 httpOnly `connect.sid` |
| localStorage 被 XSS 读 | 持久身份不依赖 localStorage token |
| google provider 误开放给 customer | `authMethodsPerActor` 显式 `customer: ['emailpass']`；google callback 已锁 `/app/login`，customer 不可用 |
| 密码爆破 | scrypt（logN=15）已由 emailpass provider 内建；登录限速兜底 |
| claim 抢单 | claim 只按「email 匹配的 guest customer」定位 + 幂等 + 已归属拒绝 |

---

## 8. Rollout / Rollback Plan

### Rollout（分 4 步，每步可独立验收）

1. **服务端 auth 基建**：`authMethodsPerActor` 加 `customer: ['emailpass']`；新增自定义 claim workflow + `/store/customers` 定制 + audit 表 migration。→ 本地验收。
2. **验证码投递**：复用 `email-channel.cjs` + SMTP，接 `auth.verification_requested` 事件（或自定义 code provider）投递验证码。
3. **nginx**：新增 `location /auth/customer/` + 独立限速区。→ `nginx -t` + reload。
4. **前端**：storefront 加注册/登录/登出/「我的账户」入口 + `store-api.js` 加 customer auth 方法。→ 真实浏览器验收。

### Rollback

- **服务端**：升级路径（§11.2 铁律，不清库）。auth 基建改动是纯增量（加 provider 白名单、加 workflow、加表），回滚 = 切回前任 commit；新表不删（audit 只增不减）。
- **nginx**：`location /auth/customer/` 块是纯增量，回滚 = 移除该块 + reload。
- **前端**：展示站 §2 static deploy 原子切换，回滚 = `current` 指回前任。
- **数据**：claim 只改 `customer.has_account` + `auth_identity.app_metadata`，**不改 order**；如需撤销某次 claim，手工把 `has_account` 置回 false 并清 `app_metadata.customer_id`（audit 保留为凭）。

---

## 9. 明确不做 / 不碰（按任务禁止项）

- ❌ 不复用 Admin auth（`user` actor 的 emailpass/google）给 customer。
- ❌ 不给 customer auth 在 nginx 套 Basic Auth。
- ❌ 不自建第二套 auth framework（全部走 Medusa 官方 auth module + provider）。
- ❌ 不用 localStorage token 作唯一信任源。
- ❌ 不改 PayPal / fulfillment / notification / CloudGull。
- ❌ 不做 loyalty/points/wishlist/subscriptions/address book/social login/SSO/avatar/marketing prefs。

---

## 10. 待 Owner 决策 / 需报告后方执行的事项

按任务要求「若需要 migration 或生产 auth 数据变更，先报告再执行」，以下在执行前需 Owner 确认：

1. **audit 表 migration**（新增 `pawshop_customer_claim_audit`）——本阶段唯一新表。
2. **生产 env 是否已有 `JWT_SECRET` / `COOKIE_SECRET`**（customer session 与 admin 共用同一套 secret，`production-policy.cjs` 已引用 `env.JWT_SECRET`/`env.COOKIE_SECRET`，说明已存在，无需新增，但需确认其值不因加 customer 而变）。
3. **验证码邮件投递的 from/to 与限频**（复用 QQ SMTP `from`，验证码邮件模板文案）。
4. **是否现在就开放 `/auth/customer/*` 的公网入口**（nginx 块），还是先只在回环验收。

---

## 11. 已只读验证过的官方源码事实（供追溯）

- `POST /auth/{actor}/{provider}` → `authService.authenticate` → `generateJwtTokenWithChecks`（`dist/api/auth/[actor_type]/[auth_provider]/route.js`）。
- `POST /auth/{actor}/{provider}/register` → actorless token（`register/route.js`）。
- `POST /store/customers` → `createCustomerAccountWorkflow`（`store/customers/route.js`），`authIdentityId = req.auth_context.auth_identity_id`。
- `createCustomerAccountWorkflow`：`validateCustomerAccountCreation` → `createCustomersWorkflow`（**无去重，会建重复**）→ `setAuthAppMetadataStep`（`core-flows/dist/customer/workflows/create-customer-account.js`）。
- emailpass `register()`：`entity_id` 已存在且 `app_metadata` 空 → 更新（claimable），否则「已存在」；不存在 → 创建（`auth-emailpass/dist/services/emailpass.js`）。
- 验证：内置 `token` provider 自动注册（`auth/dist/loaders/providers.js`），`request` 生成 token 存哈希、`confirm` 校验；**不投递**（`auth/dist/providers/verification/token.js`）。
- session：`POST /auth/session` 把 `req.auth_context` 写 `req.session.auth_context`，cookie 名默认 `connect.sid`（`api/auth/session/route.js`）。
- `/store/customers/me*` 强制 `authenticate("customer", ["session","bearer"])`（`api/store/customers/middlewares.js`）。
- `authMethodsPerActor` 当前为 `{ user: [...] }`，customer 缺省全放行（偶然）（`production-policy.cjs:163` + `api/auth/utils/auth-methods-per-actor.js`）。
- `auth_identity.entity_id` 实际落在 `provider_identity`（`[entity_id, provider]` 唯一索引）（`auth/dist/models/provider-identity.js`）。
