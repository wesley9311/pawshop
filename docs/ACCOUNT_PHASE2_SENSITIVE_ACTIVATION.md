# Account Experience Phase 2 — Sensitive Production Activation 报告

> 状态：**已激活成功** ✅
>
> 候选：`7d7e1ad483edf1b89242940c90d694334c2109e6`
> 前任：`9a2efb4366a5a80078a1eb547f66d6da7941df65`
>
> 路径：标准 sensitive release（非 code-only，因改动落在 `_commerce/src/modules/`）。

## 1. 候选确认（Owner 要求 #1）

- 初始候选 `b1bce07`，其后 `560996e`（harness DISTINCT 断言）与 `d3b6795`（验收报告）**均为 harness/report，无生产 runtime code**——`_commerce` 树、`store-api.js`、`PawShop.html` 三者 tree hash 与 `b1bce07` 完全一致。
- **但首轮迁移暴露一个真实 build 缺陷**，需追加 `7d7e1ad`（见 §2），最终候选升级为 `7d7e1ad`。
- `7d7e1ad` 相对 `b1bce07` 仅新增 `seed-module-migration-directories.mjs`（build 工具，+21 行），`_commerce/src` 树 / `store-api.js` / `PawShop.html` 仍零漂移。

## 2. 首轮迁移失败与修复（真实缺陷）

**首轮 `db:migrate`（候选 `b1bce07`）EACCES 失败**：
```
EACCES: permission denied, mkdir '.../.medusa/server/src/modules/pawshop-otp-email-auth/migrations'
```
根因：Phase 2 新增 `pawshop-otp-email-auth` 是自定义 **auth provider**（经 `AuthModuleOptions.providers` 注册），Medusa 迁移器会把它当 module 做 `ensureDir(migrations目录)`；但该模块无 migration，且 tsc 不复制空 `migrations/` 目录，导致 sealed 只读 release 上 `mkdir` EACCES。`pawshop-otp-verification`（verification provider）不受影响——验证 provider 不被迁移器当 module 扫描。

**fail-closed 生效**：EACCES 发生在任何 schema 写入之前，所有模块 "Skipped. Database is up-to-date"，DB 零变化（154 relations / 185 migrations 不变）。gate 停在 0、service 停。

**修复**（`7d7e1ad`）：`seed-module-migration-directories.mjs` 增加第二遍扫描，给 `.medusa/server/src/modules/*` 下缺 migrations 目录的编译后自定义模块补种空目录（build 后、seal 前）。build/tooling-only，不改 runtime/迁移。

**恢复**：DB 未变、`current` 仍 `9a2efb4`，安全将 gate 合回 1 + 重启 service（`9a2efb4` active / NRestarts=0 / health=200），清理失败迁移残留的 before 快照，再走完整流程。

## 3. 迁移证据（Owner 要求 #2）

- **no-op 确认**：relations **154 → 154**；migration_rows **185 → 185**（最后一条仍 `Migration20261004000000`，无新增）。**无 unexpected migration → 未 STOP**。
- 数据零变化：order 23、customer 13、auth_identity 5、provider_identity 5、user 1 全不变。
- Pre-upgrade restore point：`pawshop_production_20261008T041054933Z.manifest.json`；迁移后备份 + 隔离恢复演练（offsite read-back + isolated restore）通过。
- gate 1→0（open-upgrade）→ 迁移 → 0→1（enable，evidence 链完整绑定）。

## 4. 激活前后基线对照（Owner 要求 #3）

| 项 | 激活前 `9a2efb4` | 激活后 `7d7e1ad` |
| --- | --- | --- |
| current release | 9a2efb4 | **7d7e1ad** |
| relations | 154 | 154（不变）|
| migration rows | 185 | 185（不变）|
| order | 23 | 23（不变）|
| customer | 13 | 13（不变）|
| auth_identity | 5 | 5（不变）|
| provider_identity | 5 | 5（不变）|
| user | 1 | 1（不变）|

## 5. 激活后验证（Owner 要求 #4）

- commerce active ✓
- NRestarts = 0 ✓
- `/health` = 200 ✓
- storefront：裸域首页 `https://pawlivora.com/` = 200 ✓（SPA 入口，`<meta refresh>` 跳 PawShop.html）
- `/store/` 直连 curl = 400（`Publishable API key required`）——这是 Medusa Store API 反代的**预期行为**，前台 SPA 通过 JS 带真实 publishable key 调用，非缺陷。
- PAWSHOP_MODE = `production-storefront` ✓
- error 日志无新增异常 ✓

## 6. 生产无副作用 negative checks（Owner 要求 #5）

| 检查 | 结果 | 副作用 |
| --- | --- | --- |
| anonymous `GET /store/customers/me`（真实 publishable key）| **401** `{"message":"Unauthorized"}` | 无 |
| emailpass 路径存在（假邮箱登录）| **401** `Invalid email or password`（非 404）| 无（登录失败不写库）|
| otp-email 路径存在（假邮箱 authenticate）| **401**（非 404）| 无 |

- 「未验证 otp-email identity 不得通过 refresh 获得 actor-bound JWT」：核心不变量已在 **loopback item 02 用真实流程严格验证**（`actorBound=false, leakedActor=false`）。生产上不实际 register（会创建 auth_identity，违反 #6），故不在生产复现，引用 loopback evidence。
- **生产零污染**：auth_identity 5、customer 13、provider_identity 5、auth_verification 无 example.com 残留。

## 7. 安全项统一表述（Owner 要求 #8）

> **OTP plaintext absent from DB/log/HTTP; keyed code_hash may exist internally in DB but must never leak through HTTP/logs.**

- 生产 auth_verification 明文 6 位码 = 0；code_hash 仅存于 DB 内部 `provider_metadata`（keyed HMAC），不通过 HTTP/logs 外泄（loopback item 09 已实证：reg/req/auth 三响应均 clean、dbPlaintext=false、dbHasHash=true）。

## 8. 未触碰（Owner 要求 #9）

PayPal / fulfillment / notification / CloudGull / connector / 既有 3 个 order-lookup test baseline failures —— **全部未动**。

## 9. 待 Owner 亲测（Owner 要求 #7）

生产已激活 `7d7e1ad`（含 otp-email provider + request() 修复 + build seed 修复）。请 Owner 用**真实邮箱**在浏览器亲测：
1. 验证码登录 / 快速注册
2. 自动进入账户
3. refresh 保持
4. logout 失效
5. 已有密码登录仍正常
