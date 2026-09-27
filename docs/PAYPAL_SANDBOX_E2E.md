# PayPal Sandbox E2E 验收手册

> 状态：代码与反代就绪，**等待 Owner 提供 PayPal Sandbox 凭据后执行**。
> 目标：把「Checkout → PayPal approval → webhook → authorized → complete cart → order created → success page → guest lookup」以及 capture / refund / partial refund / webhook retry 逐项跑通。
> 铁律：任一步失败立即停止，按文末格式上报精确阻塞。**绝不 fake payment、绝不 fake order、绝不加 pp_system_default。**

---

## 本轮已修复的两个 P0（发布前必读）

1. **Webhook 无签名验证**：Medusa 内置 `POST /hooks/payment/:provider` 只转发原始 body+headers、不验签，任何人能伪造 `CHECKOUT.ORDER.APPROVED` 触发订单创建。已补：`getWebhookActionAndData` 先调 PayPal `/v1/notifications/verify-webhook-signature` 验签，失败即 `not_supported`（框架忽略、不建单）。**这是暴露 webhook 反代的前提。**
2. **authorize 只 GET 不授权**：PayPal `intent=AUTHORIZE` 的订单，买家 approve 后停在 `APPROVED`、`payments.authorizations` 为空，**商户必须主动调 `POST /v2/checkout/orders/{id}/authorize`** 才产生 authorization。已补：`authorizePayment` 在 `APPROVED` 时主动调 `/authorize` 并读回 authorization_id。否则 Medusa 侧标记 authorized 建单、PayPal 侧却无可捕获的授权，capture 必失败。

### 本轮补充的第三条硬事实：webhook 的 URL 段不是自由文本

Medusa 从 URL 最后一段反查 provider：路由把 `provider` 交给 payment module，module 拼 `pp_${provider}`，于是**只有 `paypal_paypal` 能解析成功**。

- 注册键：`@medusajs/payment .../loaders/providers.js` → `` `pp_${identifier}${id ? `_${id}` : ''}` ``；本项目 `identifier='paypal'`、`id='paypal'` ⇒ `pp_paypal_paypal`。
- 解析键：`@medusajs/medusa .../api/hooks/payment/[provider]/route.js` → payment module `` `pp_${provider}` ``。
- 失败态：POST `/hooks/payment/paypal` → `AwilixResolutionError: Could not resolve 'pp_paypal'`，事件被丢弃、**没有任何订单产生**（静默失败，最难查）。

因此：**PayPal Dashboard 里填的 `https://pawlivora.com/hooks/payment/paypal` 靠 nginx 精确别名桥接到 `/hooks/payment/paypal_paypal`**（见 §2）。两个地址都能投递成功，但只有后者是 Medusa 的原生键。

---

## 0. 前置条件（全部满足才能开始）

| # | 条件 | 来源 | 未满足时 |
| --- | --- | --- | --- |
| 0.1 | PayPal **Sandbox** App 的 Client ID / Secret | Owner 在 developer.paypal.com 创建 App | 停止，等凭据 |
| 0.2 | Sandbox Webhook ID（Dashboard 显示的是一串数字 ID，**不一定以 `WH-` 开头**——按拿到什么就填什么，别按格式猜） | 同一 App 的 Webhooks 页 | 停止，等凭据 |
| 0.3 | 六个 `PAYPAL_*` 环境变量写入生产 **`/etc/pawshop/paypal.env`**（**不是 `commerce.env`**，原因见 §1 的红线） | 见 §1 | 停止，等写入 |
| 0.4 | Nginx `/hooks/payment/` 反代已部署并 reload，**且含 `location = /hooks/payment/paypal` 别名**（Dashboard 用的是短地址） | 见 §2 | 停止，先部署反代 |
| 0.5 | 新 commerce release 已构建、升级迁移、合闸、激活，**且单元已含 `EnvironmentFile=-/etc/pawshop/paypal.env`**（改过单元 ⇒ 必须手工装单元 + `cmp` 收敛 + `daemon-reload`，见 §1.1） | 走标准升级路径（RUNBOOK §11.2） | 停止，先发版 |
| 0.6 | PayPal Sandbox 买家测试账号（personal，有余额） | 同一开发者账号下创建 | 停止，等账号 |

> 凭据铁律：Client ID / Secret / Webhook ID **只写进主机的 `/etc/pawshop/paypal.env`（0600 root:root）**，绝不进命令行、聊天、Git、commit message。读含凭据文件必须用 `redact-values.cjs`。**它落在独立文件、不是 `commerce.env` —— 见 §1 红线。**

---

## 1. 生产环境变量（六键，落在**独立文件** `/etc/pawshop/paypal.env`）

> ⛔ **红线：绝不要把 `PAYPAL_*` 写进 `/etc/pawshop/commerce.env`。**
>
> 那个文件是**键集合逐字相等**的封闭 20 键契约（`_commerce/scripts/production-env-file.cjs` 第 24 行），而单元的启动门 `ExecStartPre=/usr/bin/node scripts/preflight-production-host.mjs` 在启动时就解析它。**2026-09-27 在生产上只读实证**（跑解析器，未落盘）：
>
> ```
> 现状(无 PAYPAL 键):  PASS
> 追加 1 个 PAYPAL 键:  FAIL -> Production environment file fields do not match the approved contract.
> ```
>
> ⇒ **服务拒绝启动 ⇒ 全店 `/store/*` 一起挂**（同一进程既服务店铺 API 又服务后台）。同一条路径还会炸掉迁移合闸（`write-production-migration-gate.mjs`）、升级证据、备份演练证据与四个店主账号脚本 —— **整条升级发版链 fail-closed**。
>
> Google OAuth 与 CloudGull Connector 的凭据**同样**因这条契约而各自另开文件，见 `ops/commerce/pawshop-commerce.service` 里的注释与 `ops/commerce/{connector,paypal}.env.example`。

文件（**root:root `0600`**，与 `google-oauth.env` 同款；服务用户不需要读它）：

```
PAYPAL_CLIENT_ID=...          # Sandbox App 的 Client ID
PAYPAL_CLIENT_SECRET=...      # Sandbox App 的 Secret
PAYPAL_SANDBOX=true           # 必须是字符串 "true"（Sandbox 阶段）
PAYPAL_WEBHOOK_ID=WH-...      # Sandbox Webhook ID
PAYPAL_RETURN_URL=https://pawlivora.com/PawShop.html
PAYPAL_CANCEL_URL=https://pawlivora.com/PawShop.html
```

契约（`production-policy.cjs` 强制）：
- 六键**要么全有、要么全无**；部分配置会直接让启动失败（fail-closed）。
- `PAYPAL_SANDBOX` 只能是 `"true"` 或 `"false"`。
- `PAYPAL_RETURN_URL` 必须是 https 且落在 `STOREFRONT_ORIGIN`（`https://pawlivora.com`）下。

> ⚠️ **return_url / cancel_url 必须是纯路径、不带 `#` hash**。PayPal 批准后会往 return_url 追加 `?token=...&PayerID=...` 查询参数，`handlePayPalReturn()` 靠 `window.location.search` 检测这些参数。若带 `#anchor`，`?` 会落在 hash 之后，`location.search` 为空、回跳检测失效。

**写入后验证**（主机 root）：
```bash
ls -l /etc/pawshop/paypal.env                 # 期望 -rw------- root root
stat -c '%a %U %G' /etc/pawshop/paypal.env    # 期望 600 root root
grep -c '^PAYPAL_' /etc/pawshop/paypal.env    # 期望 6

# 顺带备份 commerce.env（本轮不碰它），并确认契约仍然成立：
cp -a /etc/pawshop/commerce.env /root/pawshop-commerce.env.bak-paypal-$(date +%Y%m%dT%H%M%SZ)
```

### 1.1 单元的独立 EnvironmentFile（**发版时必须就位**）

`ops/commerce/pawshop-commerce.service` 现在是：

```ini
EnvironmentFile=/etc/pawshop/commerce.env      # 20 键封闭契约
EnvironmentFile=/etc/pawshop/google-oauth.env  # 必需
EnvironmentFile=-/etc/pawshop/connector.env    # 可选（前导 `-`）
EnvironmentFile=-/etc/pawshop/paypal.env       # ← 本轮新增，可选（前导 `-`）
```

前导 `-` 表示**可选**：非可选的 `EnvironmentFile` 文件不存在会让 systemd **拒绝启动整个单元**。PayPal 缺席时模块根本不注册（`production-modules.cjs` 仅在凭据存在时追加 payment 模块）→ 保持 framework 默认、**不暴露任何 provider**，这正是"未配置不能拖垮店铺"的要求。

**改过单元 ⇒ `deploy-commerce.sh` 会在切 `current` 之前逐字节 `cmp` 已安装单元与候选 release，不一致即 fail-closed 停。** 所以激活前必须手工装单元（RUNBOOK §11.2 的「1.6」）：

```bash
REL=/srv/pawshop-commerce/releases/<SHA>
cp -a /etc/systemd/system/pawshop-commerce.service /root/pawshop-commerce.service.bak-$(date +%Y%m%dT%H%M%SZ)
install -o root -g root -m 0644 "$REL/ops/commerce/pawshop-commerce.service" /etc/systemd/system/pawshop-commerce.service
systemctl daemon-reload
systemd-analyze verify pawshop-commerce.service
cmp -s "$REL/ops/commerce/pawshop-commerce.service" /etc/systemd/system/pawshop-commerce.service && echo UNIT_MATCH
```

---

## 2. Nginx webhook 反代部署

canonical 已在 repo（`ops/nginx/sites-available/pawshop` + `ops/nginx/conf.d/pawshop-store-ratelimit.conf`）。主机侧 root：

```bash
# 1) 备份现行配置
cp -a /etc/nginx/sites-available/pawshop /root/pawshop-nginx-pawshop.bak-paypal-$(date +%Y%m%dT%H%M%SZ)
cp -a /etc/nginx/conf.d/pawshop-store-ratelimit.conf /root/pawshop-store-ratelimit.bak-paypal-$(date +%Y%m%dT%H%M%SZ)

# 2) scp repo canonical 到主机（在 Agent 机器上）
scp -i ~/.ssh/pawshop_aliyun_ed25519 ops/nginx/sites-available/pawshop root@47.254.26.124:/etc/nginx/sites-available/pawshop
scp -i ~/.ssh/pawshop_aliyun_ed25519 ops/nginx/conf.d/pawshop-store-ratelimit.conf root@47.254.26.124:/etc/nginx/conf.d/pawshop-store-ratelimit.conf

# 3) 校验 + reload（主机）
nginx -t && systemctl reload nginx

# 4) 验证反代生效（公网，不带签名，应得到 Medusa 的 400「Webhook Error」或 200，而非 nginx 404）
#    短地址（= PayPal Dashboard 里配的那个，经别名桥接）
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://pawlivora.com/hooks/payment/paypal -H 'content-type: application/json' -d '{}'
#    长地址（= Medusa 原生 provider 键，不依赖别名）
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://pawlivora.com/hooks/payment/paypal_paypal -H 'content-type: application/json' -d '{}'
#   期望：两者都不是 404。可能是 400（无签名/无 provider 处理异常）或 200（空事件被忽略）。404 说明反代没生效。
#   注意：200 只代表「路由层收下了」，不代表 provider 解析成功 —— 见下面的日志判据。
```

**路由可达 ≠ provider 可解析**。200 之后事件走事件总线（`PaymentWebhookEvents.WebhookReceived`，delay 5000ms、attempts 3），由 `payment-webhook` subscriber 反查 provider。必须看日志才能确认哪一步失败：

```bash
journalctl -u pawshop-commerce --since '2 min ago' | grep -iE 'paypal|webhook'
```
- 出现 `Could not resolve 'pp_paypal'` / `Unable to retrieve the payment provider with id: pp_paypal` ⇒ **路径段写错了**，事件被丢弃、不会建单。
- 出现 `PayPal webhook rejected: signature verification failed.` ⇒ provider 已解析、走到了我们的验签代码（伪造请求的正常结局）。
- 出现 `PayPal webhook signature verification failed: PayPal POST /v1/notifications/verify-webhook-signature failed (...)` ⇒ 验签调用本身出错（PayPal 侧非 2xx）。
- 什么 PayPal 行都没有 ⇒ 事件被总线延迟/重试中，或 subscriber 未注册（换 `--since` 再查一次）。

> **签名验证能工作的前提**：`/hooks/payment/:provider` 必须拿到**原始字节**。Medusa 内置中间件 `@medusajs/medusa/dist/api/hooks/middlewares.js` 已为该 matcher 设了 `bodyParser: { preserveRawBody: true }`（POST），所以 `req.rawBody` 有值；subscriber 还会把事件总线 JSON 化后的 `{type:'Buffer',data:[…]}` 还原成 Buffer。**不要**在 `_commerce/src/api/middlewares.ts` 里再给同一 matcher 加规则去覆盖它。

> 只加 `location /hooks/payment/` + `location = /hooks/payment/paypal` 这两处反代；**不改其他任何 route，不碰 Media/Auth/CDN/CloudGull。**

---

## 3. 发版（标准升级路径，不清库）

沿 RUNBOOK §11.2 走。关键点：
- 发版前先 `write-production-migration-gate.mjs ... enable` 合闸（gate 0→1）。
- `run-release-build.mjs` 的 `buildEnv` 里 `ADMIN_AUTH_TYPE=jwt` 必须显式设（否则 logout 走错流程）。
- deploy 后 `readlink current` 确认新 release，别信 `| tail`。

发版后先验（主机）：
```bash
# commerce 起来且无 NRestarts
systemctl is-active pawshop-commerce && journalctl -u pawshop-commerce -n 20 --no-pager | grep -i restart
# payment 模块已注册（日志或 API）
```

---

## 4. 完整 E2E 主链路（必须全绿）

> 每一步都用真实浏览器（`chrome-dom-dump.sh` 是唯一入口，打不开带 Basic 的页）。Sandbox 买家账号登录 PayPal 时用其 test credentials。

### 4.1 Checkout 发起支付
1. 打开 `https://pawlivora.com/PawShop.html`，加购 → 结账 → 填邮箱/地址 → 选 Standard Shipping。
2. 点「Place order」。
3. **期望**：页面跳转到 `https://www.sandbox.paypal.com/...`（PayPal 授权页）。
4. **失败即停**：若停在「Checkout is almost ready」边界，说明 provider 没启用——查 `PAYPAL_*` 六键是否写全、release 是否带 payment 模块。

### 4.2 PayPal 授权
5. 用 Sandbox buyer 账号登录并授权（approve）。
6. **期望**：PayPal 回跳 `PawShop.html?token=...&PayerID=...`。

### 4.3 Webhook → authorized → 订单创建
7. PayPal 回跳后，前台 `handlePayPalReturn()` 开始轮询（每 2s，最多 20 次）。
8. **期望**：Order Modal 从「正在确认订单」变成「下单成功」，显示订单号。
9. 后台侧验证订单已创建（真实存在，非前端伪造）：
```bash
# 主机 root，查最近订单（display_id + status + payment_status）
psql "$(sed -n 's/^DATABASE_URL=//p' /etc/pawshop/commerce.env)" -c "SELECT id, display_id, status, payment_status, fulfillment_status, total FROM \"order\" ORDER BY created_at DESC LIMIT 3;"
```
10. **期望**：`status=pending`（或 `completed` 视 workflow）、`payment_status=authorized`。

### 4.4 Guest Order Lookup
11. 用订单号 + 下单邮箱查单（footer「Track an order」）。
12. **期望**：返回该订单摘要（订单号/状态/金额/商品/收货地）。
13. **反枚举**：错邮箱 → 统一「未找到」；错订单号 → 同样「未找到」，无信息泄露。

---

## 5. Capture（真扣款）

前置：主链路订单已 `payment_status=authorized`（授权未捕获）。

1. 后台对该订单的 payment 执行 capture（Medusa Admin → order → capture payment）。
2. **期望**：`payment_status=captured`，PayPal 侧 capture 完成。
3. 验证（主机，可复用 provider 逻辑手动验，或看后台状态）：
```bash
psql ... -c "SELECT id, payment_status FROM \"order\" WHERE display_id = <N>;"
```
4. **失败即停**：记录 capture 报错原文。

---

## 6. Refund / Partial Refund

前置：订单已 captured。

1. 后台对该订单执行全额退款。
2. **期望**：`payment_status` 回到 refund 状态，PayPal 侧 refund 完成。
3. 再来一单，执行**部分退款**（金额 < 全额）。
4. **期望**：部分退款成功，剩余金额状态正确。

---

## 7. Webhook Retry / 签名拒绝

1. **正常重试**：用 PayPal Developer 的 Webhook 模拟器（或真实事件）重发一条已处理事件，期望幂等、不重复建单。
2. **伪造拒绝（关键安全验证）**：
```bash
# 不带签名头直接 POST 一个伪造的 CHECKOUT.ORDER.APPROVED，期望被签名验证拒绝、不建单
curl -s -X POST https://pawlivora.com/hooks/payment/paypal_paypal \
  -H 'content-type: application/json' \
  -d '{"event_type":"CHECKOUT.ORDER.APPROVED","resource":{"purchase_units":[{"custom_id":"payses_fake"}]}}'
# 期望：200（路由层照收）但 provider 侧 `verifyWebhookSignature` 失败 → 返回 not_supported → 无订单创建。
# 验证：查库，确认没有新的、状态异常的订单。
```
3. **期望**：伪造事件被拒，库中无新订单。

### 7.1 已实测的判据（2026-09-27，可复现）

伪造请求会走 `verifyWebhookSignature` 的**三条 return false 分支之一**，必须能区分，否则「拒绝了」可能只是因为原始字节没拿到（那真实事件也会一起被拒）：

| 分支 | 触发条件 | 日志特征 |
| --- | --- | --- |
| A 缺头 | 五个 `paypal-*` 头缺任一 | 只有 `PayPal webhook rejected: signature verification failed.`，**且无任何外连** |
| B 无原始体 | `payload.rawData` 空 ⇒ `eventBody` 为空 | 同上，**且无任何外连** |
| C 真验签失败 | 调了 PayPal，回 `verification_status != SUCCESS` | 同上；**但能看到一条到 PayPal 的出连** |

**关键：PayPal 的验签接口对伪造签名返回 HTTP 200 + `{"verification_status":"FAILURE"}`**（不是 4xx），所以分支 C 不会触发 catch，日志与 A/B 长得一样 —— 只看日志无法区分，必须看外连。

验证 C 的方法（主机，只读）：
```bash
getent hosts api-m.sandbox.paypal.com      # -> 151.101.43.1 (paypal-dynamic-cdn.map.fastly.net)
# 一边发伪造请求，一边采样到该 IP:443 的出连；出现即证明「拿到了原始字节并真的问了 PayPal」
```
实测结论：**出现 node → 151.101.43.1:443 的出连** ⇒ 分支 C ⇒ 原始字节链路（built-in `preserveRawBody` + 事件总线 Buffer 还原）成立。这同时证明了真实事件不会被误拒。

---

## 8. 失败上报格式（任一步失败立即用）

```
【PAYPAL E2E 阻塞】
- 步骤：4.2 / 5 / 6 / 7.x
- 现象：<具体报错/界面表现/HTTP 码/日志行>
- 已排除：<已确认没问题的前置>
- 阻塞点：<精确到「哪个组件没满足什么」>
- 需要 Owner：<如果涉及凭据/账号/域名则明确>
```

---

## 9. 完成判据（全部满足才算 FINALIZED）

- [ ] 主链路：真授权 → webhook → 订单创建 → 成功页 → 查单，全真、无伪造。
- [ ] capture / refund / partial refund 全通过。
- [ ] webhook 签名验证：伪造事件被拒。
- [ ] 六键 env 全写入，`PAYPAL_SANDBOX=true`（切生产前改为 `false` + Live 凭据 + Live webhook）。
- [ ] 文档同步：`FIRST_REAL_ORDER_STATUS.md`、`OWNER_ACTIONS_ZH.md`、`REMAINING_WORK.md` 成对更新。
