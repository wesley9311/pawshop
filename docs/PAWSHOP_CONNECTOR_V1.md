# PawShop Connector API V1.1（CloudGull ↔ PawShop）

> 2026-09-27。本轮实现 **PawShop 侧**与 CloudGull 同一份契约，本地验收完成，**未接真实凭据、未动生产**。

契约来源（唯一依据）：CloudGull 仓库 `docs/cloudgull/PAWSHOP_CONNECTOR_API_V1.md`，参考实现 `cloudgull/lib/connectors/pawshop/pawshop-auth.ts`、`pawshop-contracts.ts`、`pawshop-connector-adapter.ts` 与 `tests/pawshop-connector-*.test.ts`。

---

## 1. 边界（本文件的责任范围）

```text
CloudGull 域
  → ProductConnector 接口
  → PawShopConnectorAdapter
  → HTTPS /api/connector/v1          ← nginx 改写为 /connector/v1/
  → PawShop Connector（本仓 _commerce/src/api/connector/v1/**）
  → PawShop 内部 commerce engine（Medusa）
```

- CloudGull **不读 PawShop 数据库**、不 import PawShop 代码；PawShop **不向 CloudGull 暴露 Medusa 内部模型**。两侧只交换本契约定义的 JSON。
- 翻译（中性 DTO → commerce 写入）只发生在一个文件里：`_commerce/src/lib/connector-product-writer.ts`。它是唯一同时懂两种词汇表的地方，且是链路最后一环。
- 本轮**未触碰** Payment / Checkout / Auth / Media 的任何代码路径。对 nginx 只新增一条 `location`。

---

## 2. 已实现（对外表现）

### 2.1 端点

| 方法 | 路径 | scope | 成功状态 |
|---|---|---|---|
| `GET` | `/api/connector/v1/health` | `connector:health:read` | 200 |
| `PUT` | `/api/connector/v1/products/{sourceProductId}` | `connector:products:write` | 201 创建 / 200 更新 / 200 重放 |

- `GET /health` 同样需要凭据（它是凭据探针，不是公开端点），响应只回显 `authenticatedKeyId` / `authenticatedKeyVersion`，**不含 token / secret / 任何可复用值**。
- 未匹配的 方法+路径 一律 `404 {code:"NOT_FOUND"}`，与参考实现一致。

### 2.2 鉴权与请求签名

每个请求必须携带：`Authorization: Bearer <service-token>`、`X-CloudGull-Key-Id`、`X-CloudGull-Key-Version`、`X-CloudGull-Timestamp`、`X-CloudGull-Nonce`、`X-CloudGull-Signature: v1=<HMAC-SHA256>`。

签名原文（换行连接，与 CloudGull 逐字节一致）：

```text
<METHOD>\n
/api/connector/v1<path+query>\n
sha256hex(<raw body>)\n
<timestamp>\n
<nonce>\n
<Idempotency-Key 或 空串>
```

**校验顺序刻意与参考实现完全一致**，因此"多处同时出错时看到哪个错误"也一致：`headers → timestamp → credential(token) → scope → signature → replay`。

关键实现选择：**签名覆盖原始请求字节**。Medusa 的 JSON 解析器对本命名空间配置了 `preserveRawBody`（`src/api/middlewares.ts`），HMAC 算在 `req.rawBody` 上，绝不重序列化已解析的 body——重序列化会在某天 body 键序或数字往返形式变化时变成签名绕过。此点有专门断言（见 §5 的 "raw-body integrity"）。

### 2.3 轮换（current / next）

- 环境变量支持两个 slot，命名与 CloudGull 客户端契约完全对称（两侧是同一凭据的两份拷贝）：`PAWSHOP_CONNECTOR_KEY_ID` / `..._NEXT`，以及 `_SERVICE_TOKEN` / `_SIGNING_SECRET` / `_SCOPES` / `_KEY_VERSION` / `_NOT_BEFORE` / `_EXPIRES_AT`。
- 凭据按 **(keyId, keyVersion)** 二元组定位，与 CloudGull 的选择方式一致；同一 keyId 的不同 version 不可互换。
- 校验时同时接受 current 与 next；离开有效期窗口（`NOT_BEFORE` / `EXPIRES_AT`）即拒绝。
- 凭据读取缓存 30 秒：轮换只需换 env 文件并重启服务，无需改代码；缓存避免每请求解析。

### 2.4 幂等

`Idempotency-Key` 为写请求必填。语义按契约落实：

- **同 key 重放** → 返回**同一 `productId`** 且 `replayed: true`，状态码 200。
- 存的是**首次的响应体**并原样回放，不是重新计算——重算可能合理地给出 `created:false`，会破坏调用方的账目。
- **先认领、后写库**：认领就是向 `connector_idempotency_record` 插入一行（`response_status` 哨兵 0 = 进行中），唯一索引即互斥量。这保证**同一 key 的并发请求在碰到商品之前就知道自己输了**，不会建出第二个商品。
- 认领态四分：`claimed`（继续）/ `replay`（回放）/ `conflict`（同 key 不同 body）/ `in_flight`（另一请求正在处理 → 回 503 可重试，让客户端稍后回来）。认领心跳停滞 60s 视为放弃，可被接管。
- 写失败即**释放认领**，否则调用方唯一的一次合理重试会被误判为 in_flight。
- 保留窗口 90 天；窗口外的重放退化为 `updated`（`productId` 仍然不变，因为稳定 ID 由映射表永久保证）。

### 2.5 防重放

`(key_id, nonce)` 唯一索引，`connector_replay_nonce` 表。落在数据库而非内存：内存会在重启后丢失窗口，且多实例不共享。唯一索引冲突**就是**检出机制。过期行按小时机会式清理（`delete*` 是硬删，另有 `softDelete*` 家族，已在 §5 核实）。

### 2.6 稳定外部商品 ID

`connector_product_mapping`：`source_product_id` 唯一约束 → `product_id`。

- 映射在**创建时写入一次，之后永不重算**。改名、改价、响应丢失后的重试都不可能为同一 CloudGull 商品建出第二个 PawShop 商品。
- 同时冻结 `handle`：标题变化不会移动商品 URL。
- 返回 `version` 形如 `ps-r<source.revision>`（CloudGull 存为 externalRevision，其测试断言该形状）。

### 2.7 字段映射（已验证的翻译结果）

| 契约字段 | commerce 写入 | 说明 |
|---|---|---|
| `title` / `subtitle` | 商品 title / subtitle | 原样 |
| `active/draft/archived` | `published` / `draft` / `draft` | Medusa **没有 archived 状态**，故 archived 落到 draft 并在 metadata 记 `connector_status:"archived"`，不静默抹平 |
| `category.name` | `product_category`（按名 find-or-create） | 不使用平台类目 ID；并发建同名类目时回读兜底 |
| `variants[].sku/title` | 变体 sku / title | 变体按 **(sourceVariantId, sku)** 识别，不靠标题 |
| `variants[].price` | `prices:[{currency_code:"usd", amount}]` | Medusa v2 的 amount 是十进制（79 = $79.00），与契约同义，原样传递；拒绝低于分的精度 |
| `variants[].inventoryQuantity` | 变体 metadata + 商品 metadata，`manage_inventory:false` | **见 §3.1 的边界说明** |
| `media[].url/primary/position` | `images[]` + `thumbnail` | 按 position 排序；primary 决定 thumbnail；仅接受白名单主机 |
| `media[].alt/sourceMediaId` | 商品 metadata `cloudgull_connector.media` | Medusa 图片没有 alt 列，不静默丢弃 |

单个 Medusa option（标题 `Source Variant`）承载稳定变体 ID 列表，每个变体映射到自己的值。这样做让**改名安全**：option 集合不随标题变化。前台只渲染 `variant.title`，不渲染 option 名/值，因此该 ID 不会出现在顾客可见界面。

### 2.8 审计

`connector_audit_event`：每个请求（成功或失败）一行，含 occurred_at / method / path / key_id / key_version / source_product_id / product_id / idempotency_key / request_body_sha256 / outcome / http_status / error_code / duration_ms / detail。

- 这是 PawShop 自己的视角，与 CloudGull 的 `connector_sync_audits` 互补：**认证失败的请求会记录在案**，尽管 CloudGull 从未得知 PawShop 怎么看它。
- **绝不落 token / secret / Authorization / 签名**；只存 body 的 sha256，不存 body。
- 审计写失败不会改变 HTTP 结果（只记 warn）：已提交的商品写入不能因为审计问题变成调用方要重试的错误。

### 2.9 结构化错误映射

响应体恒为 `{ error, code, retryable }`（契约违规额外带 `details`）。

| code | status | retryable |
|---|---|---|
| `AUTH_HEADERS_REQUIRED` / `REQUEST_TIMESTAMP_EXPIRED` / `INVALID_SERVICE_CREDENTIAL` / `INVALID_REQUEST_SIGNATURE` | 401 | false |
| `INSUFFICIENT_SCOPE` | 403 | false |
| `REPLAY_DETECTED` / `IDEMPOTENCY_KEY_CONFLICT` | 409 | false |
| `NOT_FOUND` | 404 | false |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | false |
| `CONTRACT_VALIDATION_FAILED` | 422 | false |
| `CONNECTOR_NOT_CONFIGURED` | 503 | false |
| `TEMPORARY_UPSTREAM_FAILURE` | 503 | true |
| `INTERNAL_ERROR` | 500 | true |

`retryable` 永远是显式字段，调用方无需从状态码推断。原则：**鉴权/契约错误是终局**（同样输入重试必然同样失败），**上游故障可重试**（写入可能只是还没落）。

---

## 3. 刻意保留的边界（不是遗漏，是决定）

### 3.1 库存：`manage_inventory:false` + 元数据留存

契约本轮把真实库存明确留给未来的 `PATCH /inventory/{sourceVariantId}`（文档"未实现"）。因此连接器**不建 inventory item / stock level**，而是把请求里的 `inventoryQuantity` 完整写入变体与商品 metadata（`pending_inventory`），并在审计中可见。

**这不是静默丢数据**，但必须说清楚它意味着什么：在库存端点落地之前，连接器建出的商品**不做库存扣减**。当前店铺已有首商品同样使用 `manage_inventory=false`，且支付尚未开通，因此与本轮现实一致。**真实售卖前必须先做库存端点**。

### 3.2 变体集合变更 → 422（命名了后续能力）

更新时变体按 SKU 匹配，**保持商品既有变体顺序**（`updateProductsWorkflow` 按下标绑定，已在源码中核实）；可自由改标题与价格。

但**新增 / 删除 / 换 sourceVariantId** 会拒绝：

```json
{ "code": "CONTRACT_VALIDATION_FAILED",
  "details": { "addedSkus": [...], "removedSkus": [...], "deferredTo": "..." } }
```

原因：增删变体必须同时改商品 option 的值集合，而 `updateProductsWorkflow` **无法新建变体**（其变体映射 `variant_id: p.variants[i].id` 是按下标的，越界即崩）。这属于契约未定义的产品结构变更。**大声失败**好过静默丢弃调用方的变体。后续能力与库存端点同批设计。

### 3.3 媒体主机策略（**需店主拍板**）

仅接受白名单主机上的 HTTPS 图片 URL：

- 默认回退到前台自己的 `config.imageHosts`：`media.pawlivora.com`、`pawlivora-products-us-west-1.oss-us-west-1.aliyuncs.com`。
- 可用 `PAWSHOP_CONNECTOR_MEDIA_HOSTS` 覆盖。

**未定项**：CloudGull 侧有自己的媒体存储（其 `MEDIA_STORAGE_V1.md`），它发给 PawShop 的 URL 落在哪个域，需要明确。若落在 CloudGull 自己的域，**必须**在 `PAWSHOP_CONNECTOR_MEDIA_HOSTS` 显式声明，否则返回 422（错误信息会点名该变量）。这是刻意做的显式决定，而不是静默允许任意外链。

`url` 经 `URL` 解析后取 `hostname` 比对，因此 `https://media.pawlivora.com@evil.example.com/x.png` 这类 userinfo 伪装会被拒（已有断言）。

### 3.4 契约未定义的补强（扩展项）

| 项 | code | 为什么加 |
|---|---|---|
| 同 key 不同 body | `IDEMPOTENCY_KEY_CONFLICT` 409 | 契约未定义。回放旧响应会静默丢弃新内容，故判冲突 |
| 连接器未配置 | `CONNECTOR_NOT_CONFIGURED` 503, retryable=false | 缺/半配凭据属部署故障，明确不可重试，避免调用方猛敲 |

两处都不影响契约已定义的行为。

### 3.5 未覆盖路径的 404 形状

`/api/connector/v1/` 下**未定义**的路径由 Medusa 默认 404 处理，其响应体是 Medusa 形状，非本契约的 `{error,code,retryable}`。契约实际使用的两个端点不受影响（方法不匹配时由连接器自己按契约回 404）。CloudGull 只会调这两个端点。

---

## 4. 持久化

新增 Medusa 模块 `pawshop-connector`（`_commerce/src/modules/pawshop-connector/`），自带 4 张表，**迁移只新增本模块自己的表，不改动任何 commerce 核心表**：

| 表 | 用途 |
|---|---|
| `connector_product_mapping` | 稳定外部商品 ID（`source_product_id` 唯一） |
| `connector_idempotency_record` | 幂等认领 + 响应回放（`idempotency_key` 唯一） |
| `connector_replay_nonce` | 防重放（`key_id, nonce` 唯一） |
| `connector_audit_event` | 审计 |

- 迁移：`src/modules/pawshop-connector/migrations/Migration20260927120000.ts`（13 条 `addSql`，含 up/down）。
- 模块在 `medusa-config.ts` 中**所有 profile 都注册**（本地验收与生产跑同一模块图），production 模块列表是**追加**而非替换。
- Redis / 内存**不作为最终审计来源**——审计与幂等都在 PostgreSQL。

---

## 5. 验收证据（全部离线可复现）

| 证据 | 命令 | 结果 |
|---|---|---|
| 协议单测（含 CloudGull 黄金向量） | `cd _commerce && npm test` | **173 pass / 0 fail**（其中 17 项为本连接器） |
| 类型检查 | `cd _commerce && npm run check:types` | 0 error |
| 模块方法面 | `npm run verify:connector-module`（需先 `tsc` 产出） | **OK**（32 个生成方法 + 10 个自有方法 + 4 模型） |
| 持久化（真实 Postgres 引擎） | 见下 | **16/16 PASS** |
| HTTP 端到端（CloudGull 真实签名器） | `npm run verify:connector-http` | **77 checks / 0 failure** |

### 5.1 黄金向量（跨实现证据）

`_commerce/tests/connector-protocol.test.cjs` 里的 `GOLDEN_*` 常量是用 **CloudGull 自己的签名代码**跑出来的，不是手算：对固定输入调用其 `createCanonicalPawShopRequest` + `createPawShopSignedHeaders`，把得到的 canonical 原文与 HMAC 固化成断言。任一侧漂移，canonical 或 HMAC 就会变，测试立刻失败。复现方式：

```bash
node --experimental-strip-types <cloudgull>/scripts/generate-connector-goldens.mjs
```

（该生成器是 **CloudGull 仓库里**的一次性工具，不属于本仓库。）

### 5.2 HTTP 端到端的"真"与"桩"

**真**：编译后的路由处理器；真实验签/防重放/凭据查找；真实 DTO 校验；真实 Medusa payload 翻译；真实 socket 上的 HTTP（签的是真实请求字节）；**签名侧是 CloudGull 自己的代码**。

**桩**：commerce 工作流与容器。本机没有 Postgres/Redis，无法启动真实 Medusa 应用。桩的位置刻意选在**工作流边界**——那正是连接器停止翻译、开始委托的缝隙，因此缝隙之上的一切都是真跑，只有那一跳被捕获下来断言。模块服务用同契约的内存实现替代；SQL 实现由 §5.3 单独验证。

其中一条断言专门守护设计主张：**用非规范空白（多余空格与换行）的 body 请求，签名按这些真实字节计算，必须被接受**。若实现是重序列化后哈希，这条必然失败。

### 5.3 持久化验证（真实 Postgres）

用 PGlite（WASM 版 PostgreSQL）直接执行迁移的 `up()` SQL，并验证约束语义。脚本在仓库里（`_commerce/scripts/verify-connector-persistence.mjs`），但**它的引擎不是本项目的依赖**，需要自带：

```bash
cd _commerce
node node_modules/typescript/bin/tsc          # 产出 .medusa/server（迁移编译产物）
npm i --no-save @electric-sql/pglite          # 或装在任意临时目录
node scripts/verify-connector-persistence.mjs # 即 npm run verify:connector-persistence

# 引擎不在默认解析路径时，用 PGLITE_PATH 指到它的 dist/index.js：
PGLITE_PATH=/path/to/node_modules/@electric-sql/pglite/dist/index.js \
  node scripts/verify-connector-persistence.mjs
```

找不到引擎时脚本会 **SKIP 并 exit 0**（打印 `SKIPPED: PGlite is not installed.`）——所以"没报错"不等于"跑过了"，看输出首行确认。

覆盖 16 项，全部通过：恰好 4 张表、`public` 下无其它表、迁移可重复执行、13 个索引/主键齐全、重放 nonce 被唯一索引拒绝、不同 key_id 可复用同一 nonce、同 key 二次认领被拒（互斥量生效）、响应按首次原样回放、同 source product 第二条映射被拒、软删后释放部分唯一索引、`down()` 只删本模块表。

> 说明：PGlite **刻意不写进 `_commerce/package.json` 依赖**（否则为了跑一次验收就把一个 WASM Postgres 拖进生产镜像依赖树）。脚本本身进仓库，引擎按需临时装。

---

## 6. 部署（**本轮未执行，待店主放行**）

已改好的 repo 模板（生产**未应用**）：

| 文件 | 改动 |
|---|---|
| `ops/nginx/sites-available/pawshop` | 新增 `location /api/connector/v1/`（`proxy_pass` 带尾斜杠改写为 `/connector/v1/`） |
| `ops/nginx/conf.d/pawshop-connector-ratelimit.conf` | 新增（独立文件，便于单独回滚）`zone=pawshop_connector 120r/m` |
| `ops/commerce/pawshop-commerce.service` | 新增 `EnvironmentFile=-/etc/pawshop/connector.env`（`-` 即**可选**：缺文件绝不能让服务起不来） |
| `ops/commerce/connector.env.example` | 空白模板（与 CloudGull 同名变量，含 current/next 两槽） |

未来上线步骤（顺序有依赖）：

1. 发版（走既有升级路径：先 `write-production-migration-gate.mjs ... enable` 合闸，再 deploy）。**迁移只新增 4 张表**。
2. 建 `/etc/pawshop/connector.env`（0600 root:root，值来自双方约定的 secret manager）。**此时仍不要给 CloudGull 真值**。
3. 用 §5 的方式在主机侧自签请求做冒烟：`GET /api/connector/v1/health` 期望 200 且回显 key id/version；预期会先失败一次（凭据未注入时的 `CONNECTOR_NOT_CONFIGURED`）。
4. scp nginx 两处 → `nginx -t` → `systemctl reload nginx`（**不 restart commerce**）。
5. 双方交换凭据 → CloudGull 切 `PAWSHOP_CONNECTOR_MODE=production` → 用其真实 `PawShopConnectorAdapter` 打第一个商品。
6. 轮换演练：加 next 槽 → 观察 health/错误率/审计 → 撤 current → next 提升为 current。

### 回滚

- 代码：走既有 release 回滚路径。
- 迁移：`down()` 只 drop 连接器的 4 张表，与 commerce 数据无关。
- nginx：删掉 `location /api/connector/v1/` 段 + `pawshop-connector-ratelimit.conf` → `nginx -t` → `reload`。
- systemd：删掉那一行 `EnvironmentFile=-/etc/pawshop/connector.env`。

---

## 7. 本轮未做（明确停在凭据边界）

- ❌ 未接任何真实凭据；`/etc/pawshop/connector.env` 未创建。
- ❌ 未部署、未发版、未改生产 nginx、未重启 commerce 服务。
- ❌ 未在真实 Medusa + PostgreSQL 上跑过上架（本机无 Postgres/Redis）。**首个真实商品的端到端仍需在主机侧完成**（§6 步骤 3）。
- ❌ 未实现契约明确留白的后续端点：Inventory / Orders / Fulfillment / Refund / Webhook。
- ❌ CloudGull 侧代码未改动一行。
