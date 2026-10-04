# CUSTOMER AUTH FOUNDATION — Rollout C2 报告（第二轮 · 全绿）

> 日期：2026-10-04
> 范围：`abe7e24`（验证码限流修复）→ `e59b097`（`already_claimed` 幂等修复），在 `0eb7c4f`（foundation）+ `21cd027`（C-FIX）之上
> 环境：隔离 loopback（scratch DB `pawshop_looptest` + 独立进程 127.0.0.1:9100），生产零接触
> 结论：**C2 全绿 —— 17/17 PASS，可进入 Rollout D（nginx 精确开放 customer auth endpoints）。**

---

## 一、结论速览

| 项 | 结果 |
| --- | --- |
| C-FIX 4 项（create double-bind / claim PG access / email normalization / verified-email gate） | **全部 PASS** |
| 13 项 negative/security 矩阵 | **全部 PASS（含 2 项回归修复后的重新验证）** |
| 验证码限流（10a）回归 | **PASS**：首请求 201、60s 内重发 429（`abe7e24` 修复生效） |
| `already_claimed` 幂等（08）回归 | **PASS**：create=200、replay=200（`e59b097` 修复生效） |
| 是否需新 migration / schema | **否**（两个缺陷都是纯代码，无 schema 变更） |
| 生产影响 | **零**（current=`9e8cfcc`、gate=1、服务 active、生产库 13/3/0/23 一行未变） |

---

## 二、第二轮新发现并修复的缺陷（Rollout B 遗留，非 C-FIX 引入）

### 缺陷 2：`already_claimed` 路径非幂等（replay 500）

**现象**：同一 actorless 注册 token 重放 `POST /store/customers`（前端超时后的合法重试）返回 **500** `{"code":"unknown_error"}`。

**根因**：`src/api/store/customers/route.ts` 的 `already_claimed` 分支复用了 `claimKind='guest_claim'`，被路由进 `setAuthAppMetadataWorkflow`。该 step（`core-flows/dist/auth/steps/set-auth-app-metadata.js` 第 45-47 行）在 `app_metadata.customer_id` 已存在时抛 `Key customer_id already exists` —— 不管新值是否与旧值相同。

**归属**：此逻辑在 `0eb7c4f`（Rollout B foundation）即存在（当时的 `try { ... } catch { throw error }` 是空 catch、照样 re-throw）。C-FIX 4 项未触及 `already_claimed` 分支。**与验证码限流同属「Rollout B 遗留缺陷」**。

**修复（`e59b097`，纯代码）**：`already_claimed` 改为独立 kind，跳过绑定（身份已绑）与 audit（原 claim 已记），直接返回既有 customer。补 1 个静态断言测试锁定。

### 缺陷 1（上一轮 C2 发现，本轮确认修复）：验证码限流误伤首个请求

`recordVerificationRequest` 先 insert 再 evaluate，把当前请求算进 60s cooldown → 首请求即 429。修复 `abe7e24`（查询加 `requested_at < now` 排除本次）。本轮 10a 重跑 **PASS**（首请求 201、60s 内重发 429）。

---

## 三、13 项矩阵逐条结果（`e59b097`，全 PASS）

| # | 项 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 01 | anonymous → 401 | **PASS** | status=401 |
| 02 | 非 customer bearer 拒绝 | **PASS** | 垃圾 token → 401 |
| 03a | register 返回 actorless token | **PASS** | status=200 + token |
| 03b | token 携带 auth_identity_id | **PASS** | auth_identity_id 存在 |
| 04 | customer_id 注入被忽略 | **PASS** | 注入 victimId 后 victim.has_account 仍 =false |
| 05 | mixed-case/whitespace → canonical | **PASS** | canon=1, raw=0 |
| 06a | 0 guest → create success | **PASS** | 200 + has_account=true |
| 06b | 1 guest → claim success（verified） | **PASS** | 200 + has_account=true |
| 06c | >1 customer → 409 stop 不 merge | **PASS** | 409 + count=2 |
| 07 | unverified → 403 拒绝 | **PASS** | 403 type=unverified + has_account=false |
| 08 | existing account → 幂等 replay | **PASS** | create=200 + replay=200 + count=1 |
| 09 | concurrent claim → 幂等 | **PASS** | r1=200 r2=200 audit=1 acct=1 |
| 10a | verification cooldown（回归） | **PASS** | 首请求 201 + 60s 内重发 429 |
| 10b | verification_rate 记录 | **PASS** | email=1 + ip 行存在 |
| 11 | 不泄露账号存在 | **PASS** | exists/none 均 404 |
| 12 | audit 表只记必要字段 | **PASS** | 10 列，无 code/token/password/body |
| 13 | order/item snapshot 0 mutation | **PASS** | order 23→23, item 64→64 |

---

## 四、环境与清理

- scratch DB `pawshop_looptest`（从 pre-upgrade 备份 `pawshop_production_20261002T193735337Z` restore + 手工应用 `Migration20261004000000` 两表 + re-own 到 pawshop）。
- 候选 release 通过 `prepare-commerce-release.sh` 构建（`PREPARE_EXIT=0`），`systemd-run --unit=pawshop-looptest` 起于 127.0.0.1:9100（diag.env：DB→looptest、PORT=9100、gate=1、新 JWT/COOKIE、`InaccessiblePaths` 屏蔽 `/etc/pawshop/email-credentials.json` → 不真发邮件）。
- 测试后已停单元、删 scratch DB、删 diag.env 及全部临时文件。
- 复用了两个新落库的运维脚本：`ops/commerce/build-scratch-db.sh`（隔离 scratch DB 构建）+ `ops/commerce/c2-harness.cjs`（13 项矩阵 + 2 回归）。

---

## 五、生产零接触确认

| 指标 | 值 |
| --- | --- |
| commerce current | `9e8cfcc`（未变） |
| `PAWSHOP_MIGRATIONS_CONFIRMED` | `1`（未变） |
| commerce 服务 | active（未变） |
| 生产库 customer / auth_identity / claim_audit / order | 13 / 3 / 0 / 23（未变） |

> 注：`auth_identity=3`（此前为 2）是 COMMERCE SERVICE RECOVERY（消息 C，~22:15 重启）时产生的一条**未绑定任何 actor 的空 identity**（`app_metadata` 无 user_id 也无 customer_id），早于本轮 C2 工作（~22:35 起），非本轮 loopback 引入（loopback 全程只用 `pawshop_looptest`）。属良性空行，已记录备查，不需处置。

---

## 六、下一步

1. **C2 全绿**，按 Owner 消息 D 的授权顺序，进入 **Rollout D：nginx 精确开放 customer auth endpoints**（仅 `location /auth/customer/` 与 `location /auth/verification/`，绝不放开整个 `/auth/`）。
2. D 完成后进入 **Rollout E：production browser acceptance**。
3. 两个收尾已处理：CODE-ONLY MIGRATION GATE RECOVERY PATH 已登记为 A14 TODO（待补 RUNBOOK）；`/root/commerce.env.bak-recovery-20261004T221413Z` 已确认权限（root:pawshop 640）后安全删除。
4. 仍未标记 OWNER VERIFIED —— 待店主验收。
