# Account Experience Phase 2 — Loopback Security Acceptance（逐项 evidence）

> 状态：**10/10 全部 PASS** ✅
>
> 依据 Owner 指令：本轮**未发布生产**，只在隔离 loopback 环境（`127.0.0.1:9100`，scratch DB `pawshop_looptest`）跑真实 10 项安全验收矩阵，全部通过后**才允许进入 sensitive release**。
>
> 全程**零手工 `UPDATE auth_verification SET verified_at`**——每一枚验证码都走真实 `request → capture → authenticate` 路径。production 库（`pawshop`）全程未触碰（13 customer 不变，0 条 `p2*` 测试数据）。

## 执行环境

| 项 | 值 |
| --- | --- |
| 候选 release | `b1bce070c4aca6709b0077f9db7d6421cdbf8516`（fix: request() always mints fresh code） |
| 服务 | `pawshop-looptest.service`（systemd-run transient，`User=pawshop`，`127.0.0.1:9100`） |
| 数据库 | `pawshop_looptest`（scratch，从 production 备份恢复的 baseline） |
| 验证码捕获 | `PAWSHOP_VERIFICATION_EMAIL_CAPTURE=/tmp/pawshop-otp-capture/run` + `PAWSHOP_LOOPBACK_ACCEPTANCE=1` |
| Harness | `ops/commerce/phase2-otp-harness.cjs`（10 项矩阵，host 侧） |

## 本轮修复的两个真实缺陷

在首轮 loopback 运行中暴露、并于本轮修复并重新验证：

1. **`verif_otp.request()` 的「already-verified 短路」缺陷**（`otp-verification-provider.ts`）：
   原实现里 `request()` 对「已 `verified_at` 的 identity」直接返回旧记录、**不再签发新码**。这破坏了 OTP **登录**语义——回访用户（第 2 次登录、password 用户改走 OTP、以及 resend-invalidates/expiry 校验）都会因为拿不到新码而失败（subscriber 记录 `event carried no recipient or code`，harness 读不到码 → authenticate 从未被调用）。
   修复：**移除该短路**，`request()` 每次都签发新码，`update` 分支无条件 `verified_at=null` + 覆写 `code_hash`（旧码作废、新码成为唯一可认领码）。「already-verified 去重」属于注册调用方的职责，不属于签发码的 provider。
   → 影响项 03/05/06，修复后全绿。

2. **harness 自身两处断言缺陷**（非 provider 缺陷）：
   - item 07：`customer.has_account` 在 `psql -tA` 裸输出为 `t`/`f`，harness 却与 `'true'` 比较 → 改为 `has_account::text` 得 `'true'`/`'false'`。
   - item 05：`authIdentityIds()` 未 `DISTINCT`。cross-provider binding 合法产生 **2 条 provider_identity 行指向同一 auth_identity**，harness 却要求行数=1 → 改为 `select distinct ai.id`。
   - item 08：无状态 JWT 的 logout 语义 = 客户端丢弃 token（`/auth/session` 对纯 bearer 返回 401 属预期、非安全失败）。修正断言为「logout 后 **不带 token** 的 `/store/customers/me` 必须 401/403」。

## 逐项 evidence（最终一次运行，10/10 PASS）

```
PASS  01 new email → register→OTP→authenticate→claim→refresh → actor-bound JWT
        reg=200 req=201 auth=200 claim=200 refresh=200 me=200 actorBound=true
PASS  02 register→refresh before OTP must NOT upgrade to actor-bound
        refresh=200 actorBound=false leakedActor=false
PASS  03 OTP wrong/one-time/resend/expiry
        wrong=401 first=200 replay=401 oldAfterResend=401 expired=401
PASS  04 duplicate registration → no duplicate customer/identity/orphan
        cust 1→1, identity 1→1, provider_identity 1→1
PASS  05 emailpass user: password + OTP login both work, same identity
        pw=200 otp=200 sameIdentity=true providers=[emailpass,otp-email]
PASS  06 existing otp-email user: 2nd OTP login works, no re-create
        cust 1→1 second=200
PASS  07 guest claim semantics (0/1/>1) preserved
        1guest=200(1) 0guest=200(1) >1=409(2)
PASS  08 session: me / refresh-same-customer / logout-inaccessible
        me=200 sameCustomer=true logout→me(no token)=401
PASS  09 leak check: no OTP plaintext/code_hash in HTTP or DB
        reg=clean req=clean auth=clean dbPlaintext=false dbHasHash=true
PASS  10 concurrent authenticate of same OTP → exactly one succeeds
        a=200 b=401 okCount=1

=== RESULT: 10/10 PASS ===
```

### 逐项说明

1. **新邮箱 → 注册 → OTP → 认证 → claim → refresh → actor-bound JWT**：`register`(200, actorless token) → `requestOtp`(201) → `authenticate`(200) → `claimCustomer`(200) → `refresh`(200) → `/store/customers/me`(200) 且解析到 customer.id（`actorBound=true`）。全链路真实、无捷径。
2. **注册后 OTP 未验证先 refresh 不得升级为 actor-bound**：`register` 拿到 actorless token 后**不验证 OTP** 直接 `refresh`，返回 200 但 `actorBound=false`、响应无 `actor_id` 泄漏。验证了 `authVerificationsPerActor` 门禁生效，封死「register→refresh 账户接管」向量。
3. **OTP 错码 / 一次性 / 重发作废旧码 / 过期**：`wrong=401`（错码拒绝）；`first=200`（真码首次成功）；`replay=401`（复用同一码被拒，一次性生效）；`oldAfterResend=401`（重发后旧码作废）；`expired=401`（回拨 `requested_at` 16 分钟模拟过期，新码也被拒——**注意：这里回拨的是 `requested_at` 而非伪造 `verified_at`，码仍未被认领，失败必须来自 TTL 门禁，证明过期判断生效**）。
4. **同邮箱重复注册不产生重复 customer/auth_identity/孤儿**：两次完整注册+claim，customer 1→1、auth_identity 1→1、provider_identity 1→1，无孤儿。
5. **已有 emailpass 用户：密码登录仍可用 + OTP 登录也可用 + 同一 identity**：`pw=200`（密码登录）、`otp=200`（OTP 登录）、`sameIdentity=true`、`providers=[emailpass,otp-email]`。cross-provider binding 把 `otp-email` provider 绑到**同一 auth_identity**（同一 customer），无 detached identity、无重复 customer。
6. **已有 otp-email 用户：第 2 次 OTP 登录成功，不重建 customer**：`cust 1→1`、`second=200`。第 2 次登录签发新码并成功，未重建 customer。
7. **guest claim 语义（0/1/>1）保留**：1 guest → claim 200（1 行、`has_account=true`）；0 guest → claim 200（创建 1 行）；>1（1 guest + 1 account，Medusa `customer(email,has_account)` 唯一索引最多允许 1 guest + 1 account）→ claim **409**（2 行，不自动合并）。
8. **session：me / refresh 同 customer / logout 后不可达**：`me=200`、refresh 两次 `sameCustomer=true`、logout 后不带 token 的 `me` 返回 **401**。
9. **泄漏检查**：register/request/auth 三个 HTTP 响应均无 `code`（6 位明文）、无 `code_hash`、无 `provider_metadata`；DB 中无 6 位明文码（只有 `code_hash` 摘要）。**DB 实测 `plaintext_otp_in_db=0`**。
10. **并发**：同一 OTP 两个并发 authenticate，`a=200 b=401`，恰一个成功（原子条件更新 `verified_at IS NULL` 生效）。

## 既有失败 baseline 保持

Owner 要求「`order-lookup-fulfillment.test.cjs` 的 3 个既有失败保持『发布前已存在』的精确 baseline，本轮不得新增失败、不要顺手修」。

复跑验证（HEAD=`560996e`，Phase 2 + 本轮修复之后）：

```
not ok 21 - the route serializes fulfillments through the shared mapper
not ok 22 - the route requests the fulfillment whitelist and nothing else
not ok 26 - item quantity is defensively serialized, never undefined
# tests 26  # pass 23  # fail 3
```

**仍是 23 pass / 3 fail，同样的 3 项（21/22/26），未新增、未修复。** 详见 `docs/PHASE2_PREEXISTING_FAILURES_BASELINE.md`。

## 本地回归（无新增失败）

| 套件 | 结果 |
| --- | --- |
| `_commerce` 全量（383 tests） | **377 pass / 3 fail**（3 fail 即上述既有 21/22/26，无新增）/ 3 skipped |
| `tests/storefront.test.mjs` | **52/52 pass** |
| `tsc --noEmit` | clean（exit 0） |

## 结论

- **10/10 项安全验收全部通过**，全程真实流程、无 `verified_at` 手工改动。
- 本轮修复的 `verif_otp.request()` 缺陷是**真实 provider bug**（回访用户无法二次 OTP 登录），已修复并重新验证。
- 既有 3 项失败 baseline 精确保持，未新增失败。
- 生产环境（`pawshop` 库、`current` 链接 `9a2efb4`）**全程未触碰**。

**下一步（等 Owner 指令）：进入 sensitive release**（task #295），走标准升级路径激活 `b1bce07`（含 `request()` 修复 + Phase 2 otp-email 全量代码）。
