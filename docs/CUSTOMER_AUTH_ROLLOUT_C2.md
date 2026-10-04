# CUSTOMER AUTH FOUNDATION — Rollout C2 报告

> 日期：2026-10-04
> 范围：C-FIX commit `21cd027d6eb755e0ed0282c9a6ce7de38e2961f9`（在 `0eb7c4f` 之上修复 4 项 C-FIX 必修）
> 环境：隔离 loopback（scratch DB + 独立进程 127.0.0.1:9100），生产零接触
> 结论：**C2 未全绿 —— 发现 1 个 Rollout B 遗留缺陷（验证码限流的 60s cooldown 误伤首个请求）**。C-FIX 的 4 项全部 PASS。**停在 C，不进入 D。**

---

## 一、结论速览

| 项 | 结果 |
| --- | --- |
| C-FIX 4 项（create double-bind / claim PG access / email normalization / verified-email gate） | **全部 PASS** |
| 13 项 negative/security 矩阵 | **12 项 PASS，1 项 FAIL** |
| 失败项 | **验证码限流 60s cooldown 误伤首个请求**（Rollout B 遗留，非 C-FIX 引入） |
| 是否需新 migration / schema | **否**（纯代码缺陷，无 schema 变更） |
| 生产影响 | **零**（current=`9e8cfcc`、gate=0、服务 inactive、生产库行数一行未变） |

---

## 二、C-FIX 4 项验证结果（全部 PASS）

| # | C-FIX 项 | 证据 |
| --- | --- | --- |
| 1 | create 不再 double-bind | `0 guest → create success`（06a）：`POST /store/customers` 对无既有 customer 的邮箱返回 200，`has_account=true`。不再抛 `Key customer_id already exists`（500 已消失）。 |
| 2 | claim 用 service 的 `claimGuestCustomer`（正确 PG access） | `1 guest → claim success`（06b）：`has_account` false→true 翻转成功，无 `req.scope[PG_CONNECTION]` 的 `Cannot read properties of undefined` 500。 |
| 3 | email normalization（register 前 trim+lowercase） | `mixed-case/whitespace → canonical`（05）：`  C2MIXED...@Loopback.Test  ` 注册后 `provider_identity.entity_id` 存为 canonical，raw 形式 0 条。 |
| 4 | verified-email 强制 | `unverified → 403`（07）：`verified_at=null` 时 claim 返回 403 `type=unverified`，`has_account` 未翻转。 |

## 三、13 项矩阵逐条结果

| # | 项 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 01 | anonymous → 401 | **PASS** | status=401 |
| 02 | 非 customer bearer 拒绝 | **PASS** | 垃圾 token → 401 |
| 03a | register 返回 actorless token（actor_id 空） | **PASS** | actor_id 空 |
| 03b | token 携带 auth_identity_id | **PASS** | auth_identity_id 存在 |
| 04 | customer_id 注入被忽略 | **PASS** | 注入 victimId 后 victim.has_account 仍 =f |
| 05 | mixed-case/whitespace → canonical | **PASS** | stored=canonical, raw=0 |
| 06a | 0 guest → create success | **PASS** | 200 + has_account=true |
| 06b | 1 guest → claim success（verified） | **PASS** | 200 + has_account=t |
| 06c | >1 customer → 409 stop 不 merge | **PASS** | 409 + count=2 |
| 07 | unverified → 403 拒绝 | **PASS** | 403 type=unverified + has_account=f |
| 08 | existing account → 不重复 claim | **PASS** | 200 + count=1 |
| 09 | concurrent claim → 幂等 | **PASS** | r1=200 r2=200 audit=1 |
| 10a | verification cooldown | **FAIL** ⚠️ | **首个请求即 429**（见下） |
| 10b | verification_rate 记录 | **PASS** | ip + email 两行 |
| 11 | 不泄露账号存在 | **PASS** | exists/none 均 200 |
| 12 | audit 表只记必要字段 | **PASS** | 10 列，无 code/token/password/body |
| 13 | order/item snapshot 0 mutation | **PASS** | order 23→23, item 26→26 |

---

## 四、失败项根因（Rollout B 遗留，非 C-FIX）

**现象**：`POST /auth/verification/request` 对**全新邮箱、空限流表**的**第一个请求就返回 429**。

**根因**：`pawshop-customer-auth/service.ts` 的 `recordVerificationRequest` 把「插入请求行」放在「评估限流」**之前**，随后查询窗口内请求时把**当前这次请求自己的行**也算进 `times`。`evaluate` 的 cooldown 判定 `sinceLast = now - mostRecent = 0 < 60000` → 恒为「拒绝」。

**影响面**：
- **email scope**（`cooldownMs=60000`）—— 首请求即 429，**合法顾客永远无法请求验证码**（功能性阻塞）。
- **ip scope**（`cooldownMs=0`）—— 不受此 bug 影响，20/hour 上限正常。
- 反枚举不受影响（仍是统一 429，不泄露账号存在），但把「正常请求」也一并挡了。

**修复方向**（纯代码，无 schema 变更）：评估前排除当前请求自己的行，或先评估后插入。例如把查询过滤改为 `requested_at < now`（排除本次），或把 `insert` 移到 `evaluate` 之后。

**归属判定**：此逻辑在 Rollout B（customer auth foundation）即存在，C-FIX 的 4 项改动**未触及** `recordVerificationRequest`。属**新浮现的既有缺陷**，不在本轮 C-FIX 授权范围。

---

## 五、环境与清理

- scratch DB `pawshop_looptest`（从 pre-upgrade 备份 `pawshop_production_20261002T193735337Z` restore + 手工应用 `Migration20261004000000` 两表）。
- 候选 release `21cd027` 通过 `prepare-commerce-release.sh` 构建（`PREPARE_EXIT=0`），`systemd-run --unit=pawshop-looptest` 起于 127.0.0.1:9100（diag.env：DB→looptest、PORT=9100、gate=1、新 JWT/COOKIE、`InaccessiblePaths` 屏蔽 email 凭据→不真发邮件）。
- 测试后已停单元、删 scratch DB、删 diag.env 及全部临时文件。

## 六、生产零接触确认

| 指标 | 值 |
| --- | --- |
| commerce current | `9e8cfcc`（未变） |
| `PAWSHOP_MIGRATIONS_CONFIRMED` | `0`（fail-closed，未变） |
| commerce 服务 | inactive（未变） |
| 生产库 customer / auth_identity / claim_audit / order | 13 / 2 / 0 / 23（未变） |

---

## 七、下一步（需 Owner 决定）

1. **验证码 cooldown 缺陷**：是否在本轮一并修（一行代码，无 schema）？还是登记为 backlog、随后续发版修？
2. 修复后需**重新跑 Rollout C2**（本报告 13 项，尤其 10a 改为「首请求 200、60s 内重发 429」）。
3. **C2 全绿前**：继续禁止 nginx customer auth exposure、production browser auth、public activation（Rollout D/E 不启动）。
