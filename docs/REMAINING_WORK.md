# PawShop 未完成清单与操作顺序

更新：2026-09-30（**履约闭环 Phase 1 已上线：Guest Order Lookup 现在返回真实 `fulfillments[]`，订单详情在真有履约/物流数据时才渲染物流区块（展示站 + 商务站均为 `6aa211cc`）**：后端把 lookup 的纯逻辑抽到 `_commerce/src/lib/order-lookup.cjs`，新增 `fulfillments[]`（id/created_at/packed_at/shipped_at/delivered_at/canceled_at + `labels[].{tracking_number,tracking_url}`，oldest-first、**永远是数组**，支持多包裹/部分发货）；**`labels.label_url` 按设计永不下发**（仓库面单，非买家可见）。状态语义只用 Medusa 原生真实值：`not_fulfilled`→尚未发货 / `fulfilled`+`partially_fulfilled`→**已打包**（来自 `packed_at`，**不是已发货**，旧文案"Fulfilled/已履行"有歧义已废）/ `shipped`+`partially_shipped`→已发货 / `delivered`+`partially_delivered`→已送达 / `canceled`→履约已取消。**"运输中 / 派送中"本轮明确不实现**（Medusa 无 carrier event source，须未来 carrier API/webhook）→ 已记入 backlog。反枚举从"约定"升级为"结构"：唯一冻结常量 `LOOKUP_NOT_FOUND_STATUS/BODY`，路由所有失败路径（含闭店）都走它。**不碰 PayPal / A11 / Region / Service Zone / checkout UI / 邮件 / account center / 退货**。测试：commerce **217/217**（+23）、展示站 **58/58**（+3）、types/security/html 全绿。**未标记 OWNER VERIFIED**。详见下文 §0）

更新（上一轮）：2026-09-30（**A11 服务端地址结构校验已实现并上线（商务站 `f00139c`）**：在 `POST /store/carts` 与 `POST /store/carts/:id` 两个 cart 写路由上加 storefront 专属 middleware（`_commerce/src/lib/address-structure.cjs`）；全国家必填完整性 + 仅 US 校验州码（50 州+DC+territories）与 ZIP/ZIP+4；**不碰 Region 权威**（国家是否可配送仍由 Medusa 裁决）、不碰 PayPal provider/capture/refund、不碰 checkout UI。19 新测试；commerce 194/194、types、security、storefront 44/44 全绿；生产 live 实测 10 条路径全符合预期。**未标记 OWNER VERIFIED**。前两轮的 `ADDRESS INVALID-FIELD RED BORDER`（`48b44d6`）与 `PAYPAL RETURN SUCCESS/CANCEL UX`（`dae62b9`）展示站已上线，仍待店主复看。前一轮 `CHECKOUT COUNTRY / ADDRESS UX = OWNER VERIFIED ✅` 不变。详见下文 §0）

更新（上两轮）：2026-09-30（**红框视觉缺陷已修 + PayPal 回跳 UX 已发版，两项均待店主验收**：① `ADDRESS INVALID-FIELD RED BORDER` 根因有二——`assets/tailwind.css` 从未包含 `.border-red-400`；且即使包含，编译产物把 `.border-slate-200` 排在 `.border-red-400` **之后**，`border-slate-200 border-red-400` 仍解析为灰色。改为「错误态只保留单一边框色类」（`fieldClass` 用替换而非追加），并让 State/Country 控件也走 `fieldClass`；重建 CSS（hash `a39414b8…`）。② `PAYPAL RETURN SUCCESS/CANCEL UX`（commit `dae62b9`）随本次发版上线。展示站现行 `48b44d6`；**未标记 OWNER VERIFIED**。前一轮 `CHECKOUT COUNTRY / ADDRESS UX = OWNER VERIFIED ✅` 不变；**A11 仍独立缺口**：`SERVER-SIDE ADDRESS STRUCTURE VALIDATION = NOT YET IMPLEMENTED`）

前一轮：2026-09-29（**ORDER SUCCESS UX = OWNER VERIFIED ✅**：店主已按验收清单 A–F 复测通过。本轮结项，不再扩展——成功页 note 已去掉未上线邮件承诺、CTA 已改「确认并支付」、详情三层、无自动闪现 lookup。展示站现行 `ef2767c`）
配套阅读：`docs/OWNER_ACTIONS_ZH.md`（**需要店主本人出面的项：链接、点击步骤、交付方式**）、`PRODUCTION_HANDOFF_ZH.md`（路径与排错总索引）、`docs/RUNBOOK.md`（可执行命令）、`docs/ADVERSARIAL_REVIEW.md`（对抗审查发现）。

图例：**P0** 阻塞上线 / **P1** 上线前应完成 / **P2** 可延后。**归属** 指谁能做：
**Agent** = 可自主执行并验证；**店主** = 必须本人（身份、协议、账号归属、付款）；**共同** = Agent 执行、店主在场确认。

---

## 0. 当前没有阻塞项；关键路径交回店主

**2026-09-30 履约闭环 Phase 1（本轮，High，已上线，待店主验收）**：上一阶段（TRANSACTION UX / CHECKOUT COUNTRY-ADDRESS FLOW / A11 / PAYPAL RETURN SUCCESS-CANCEL UX / ADDRESS INVALID-FIELD RED BORDER）店主已全部亲测封口。本轮不做 carrier API，先建立 PawShop 自己**完整、真实、可追踪**的履约闭环——**只把 Medusa 已经存着的履约数据露出来，不发明它没有的东西**。

- **范围**：B（扩展现有 guest order lookup，返回真实 `fulfillments[]`）+ C（订单详情渲染真实物流区块）。A（发货操作）继续用 Medusa Admin 原生，不开发替代后台；D（结构化 carrier Admin widget、从 `tracking_url` 猜承运商）**本轮暂缓**。
- **改动的文件（commit `6aa211cc9147e1dc33e01f925412aaf249a22f93`，7 文件 +822/−59）**：新增 `_commerce/src/lib/order-lookup.cjs`；改 `_commerce/src/api/store/pawshop-orders/lookup/route.ts`；改 `PawShop.html`；改 `safe.js`；重建 `assets/tailwind.css`；新增 `_commerce/tests/order-lookup-fulfillment.test.cjs`；改 `tests/storefront.test.mjs`。
- **guest lookup payload 形状**：`order.fulfillments[]` = `{ id, created_at, packed_at, shipped_at, delivered_at, canceled_at, labels: [{ tracking_number, tracking_url }] }`。**永远是数组**（一单可多包裹/部分发货，前端不得假设只有一个单号）；**oldest-first 排序**；无 labels 时为 `[]`；无履约时为 `[]`（整块不渲染）。**`label_url` 永不下发**——它是仓库打印的面单，不属于公开未认证查询该给买家的东西；字段白名单 `LOOKUP_FULFILLMENT_FIELDS` 里根本没有它（编译产物实证：`label_url` 只出现在注释里）。
- **反枚举升级为"结构"**：把 7 处重复字面量 `res.status(404).json({type:'not_found'})` 收敛为唯一冻结常量 `LOOKUP_NOT_FOUND_STATUS=404` + `LOOKUP_NOT_FOUND_BODY={type:'not_found'}`。任何新失败分支都只能复用它，改不出第二种失败体。
- **fulfillment 状态映射（客户侧真实语义，勿回改）**：`not_fulfilled`→尚未发货；`fulfilled`/`partially_fulfilled`→**已打包/部分已打包**；`shipped`/`partially_shipped`→已发货/部分已发货；`delivered`/`partially_delivered`→已送达/部分已送达；`canceled`→履约已取消。**关键修正**：`fulfilled` 来自 `packed_at`（打包/拣货），**不等于已发货**，旧中英文案"Fulfilled/已履行"会被读成"已发货"⇒ 已改为 "Packed/已打包"。每包裹状态由**该 fulfillment 自己的时间戳**推出，优先级 `canceled > delivered > shipped > packed`（与 core-flows 聚合器一致）。
- **tracking UI**：有 `tracking_number` 就显示真实单号；有 `tracking_url` 就显示「查询物流 / Track shipment」（`target="_blank" rel="noopener noreferrer"`）；两者都无则整行不渲染——**不显示假链接、不显示假承运商、不从 URL 猜 carrier**。新增 `PawSafe.link()`：承运商 URL 是运营手填入库的值，按不可信输出处理，只放行绝对 http(s) 并转义，**不设 host 白名单**（承运商多且会变；这是用户主动跳转的顶层导航，不是页面自动加载的资源，所以不能用 `image()` 那套 allowlist）。
- **"运输中 / 派送中"本轮明确不实现**：Medusa 2.21.0 没有原生承运事件来源，任何这类状态都只能是编的 ⇒ 已记入 **carrier integration backlog**，等未来 carrier API/webhook 补齐 `运输中 → 派送中 → 已送达`。
- **测试**：`_commerce/tests/order-lookup-fulfillment.test.cjs` **23 条**（号码各形态解析、邮箱门禁、`mapFulfillments` 的空/排序/多包裹/部分发货/已送达/已取消/空串归 null/`label_url` 永不出现/脏条目丢弃、字段白名单精确相等、路由接线、"每条失败路径都是同一个 404"）；`tests/storefront.test.mjs` **+3**（**不存在的订单 vs 错邮箱渲染出逐字节相同的未找到界面**且不泄露 `not_found`/`404`/`type`、命中失败时不渲染任何订单详情、**断网 ≠ "订单不存在"**）。全绿：commerce **217/217**、`check:types` 干净、root `check:security` + `check:html` 通过、展示站 **58/58**。
- **Tailwind 重建的安全证明（新规矩）**：先输出到 `/tmp` 不覆盖，再按 `}` 深度 0 切规则做集合差 → **removed == 0**（270→275 规则，added 5 = `.flex-wrap`/`.items-end`/`.gap-x-4`/`.gap-y-2`/`.underline-offset-2`），且 `.border-red-400` 与 `.border-slate-200` **相对位置不变** ⇒ 证明重建没动 A11 已验收的红框行为。现行 hash `b6f8a6257555357e6e7137b4b0dbdd49e512cbbe1a70c21e7bcedff0bcf0cc08`，size 18313。
- **发版（两条路径都走完，同一 SHA）**：后端走 code-only 路径（`prepare-commerce-release.sh`：backend 15.32s / frontend 127.41s → `prepare-code-only-release.sh`（`f00139c -> 6aa211cc`）→ `deploy-commerce.sh`）；前端走 `deploy-static.sh`（4 env）。两棵树 `/current` 均 = `6aa211cc`，`NRestarts=0`、`/health` 200、档位 `production-storefront`、journalctl 无 err。
- **生产 live 实测**（`127.0.0.1:9000` 与公网 HTTPS 各一遍）：order **#2**（`e2e-refund-partial@pawlivora.com`，`PS-20260928-0002`）→ 200，`fulfillment_status: fulfilled`，`fulfillments:[{id:ful_01M3KHGAFC…, packed_at:2026-09-28T08:18:35.619Z, shipped/delivered/canceled:null, labels:[]}]`，**`label_url` 不存在**；order **#17** → `not_fulfilled` + **`fulfillments: []`**；**不存在的订单 / 错邮箱 / 畸形邮箱 / 畸形单号 → 四种全是同一个 `{"type":"not_found"}`，`cmp` 逐字节一致**。公网 `assets/tailwind.css` sha256 与本地/生产一致，5 个新 utility 在产物里，`.border-red-400` 仍在。
- **⚠️ 线上暂时看不到单号，这是真实状态不是缺陷**：`fulfillment_label` 至今 **0 行**，全站没有任何 tracking 数据。要看到单号必须先由店主演一次真实发货（Admin 填单号）。
- **⚠️ 本轮不自行标记 OWNER VERIFIED**：`FULFILLMENT / TRACKING PHASE 1` 等店主验收（见 `docs/OWNER_ACTIONS_ZH.md` §0.5）。

---

**2026-09-30 A11 服务端地址结构校验（上一轮，High，已上线，待店主验收）**：Medusa 的 `AddressPayload` 把每个地址字段都标成 `.nullish()`，所以 store API 接受「US 地址但没 city、没州、没 ZIP」。前端表单会校验，但**浏览器不是权威**。本轮补服务端最后一道防线；严格只做 A11，不扩功能、不碰 PayPal/Region/checkout UI。

- **插入点（为什么是这里）**：`_commerce/src/api/middlewares.ts` 里对 `POST /store/carts` 与 `POST /store/carts/:id` 挂 storefront-profile 专属 middleware `validateCartShippingAddress`（实体在 `_commerce/src/lib/address-structure.cjs`）。**这两个路由是前台存地址的唯一入口**，因此它是「最小且正确」的插入点——任何地址在写库前就被拦，shipping method 选择、payment collection、PayPal hand-off 因此**永远位于一个「已通过校验的地址」之下游**。不带地址的 cart 更新（`email`、shipping method）原样 `next()` 放行。
- **精确规则**：① 全国家必填 `first_name`/`last_name`/`address_1`/`city`/`country_code`/`province`/`postal_code`；② **仅 US** 加结构校验——`province` ∈ {50 州 + DC + AS/GU/MP/PR/VI}（共 56 码），`postal_code` 匹配 `^\d{5}(-\d{4})?$`（ZIP 或 ZIP+4）；③ **非 US 只做必填完整性**，不发明任何国家级格式。失败返回 `400 {"type":"invalid_data","code":"cart_shipping_address_invalid","errors":[{field,code,message}]}`（`field` 用 Medusa snake_case key，可直接映射回表单）。
- **Region 权威未被削弱（关键设计）**：middleware 只用 `country_code` **选择套哪套结构规则**，**从不拒绝国家**。国家是否可配送仍由 Medusa Region 裁决——live 实测：非 region 国家 CA 带全字段通过本 middleware，随后被 Medusa 以 `{"type":"invalid_data","message":"Country with code ca is not within region United States"}` 拒绝（**没有**本模块的 `code` 字段）。两层职责清晰可分。
- **未触碰**：PayPal provider、authorize/capture/refund/webhook、Region/Service Zone/shipping option 数据模型、checkout UI 结构（前端 `validateAddress()` 保留，后端成为最终防线，不是替代）。
- **测试**：新增 `_commerce/tests/cart-address-validation.test.cjs` 19 条（NY+10001 通过、无效州拒、无效 ZIP 拒、必填缺失/畸形拒、非 US 仅必填、middleware 放行分支、两条路由挂载）。**commerce 全量 194/194**、`check:types` 干净、root `check:security` 通过、storefront `tests/*.test.mjs` **44/44**（PayPal checkout 回归未破）。
- **生产 live 实测（对运行中的 `/store`，`pk_…` 公开键）**：无效州+无效 ZIP → 400（两个 field error）；缺 city → 400；NY+10001 → 200；ZIP+4 → 200；无地址 → 200（放行）；update 路由上同上；非 region 国家由 Medusa 拒（见上）。region 支付通道 `pp_paypal_paypal` enabled、shipping option 正常解析 → **PayPal 路径未被影响**。
- **发版**：`f00139c9908ad34a95a345c1404fd1e0971ba924`，走 **code-only 路径**（`prepare-commerce-release.sh` → `prepare-code-only-release.sh` → `deploy-commerce.sh`，无 DB 迁移/恢复演练）。`/srv/pawshop-commerce/current` 已切到 `f00139c`，`NRestarts=0`、`/health` 200、档位 `production-storefront/open`、gate=1。**展示站未动**（仍 `48b44d6`）。**（→ 展示站已于同日第四轮随履约 Phase 1 升到 `6aa211cc`，见 §0 顶部。）**
- **⚠️ 本轮不自行标记 OWNER VERIFIED**：`SERVER-SIDE ADDRESS STRUCTURE VALIDATION` 等店主验收。

---

**2026-09-30 红框视觉修复 + PayPal 回跳 UX 发版（前一轮，待店主验收）**：两件事——修已确认的 Tailwind 红框视觉缺陷、发版 PayPal return success/cancel UX。范围只这两项，不碰 A11、不升级 Tailwind、不改 provider/capture/refund/Medusa/address validation。

- **修复 `ADDRESS INVALID-FIELD RED BORDER`（commit `48b44d6`）**：出问题的不是一处而是三处——(a) 提交在库的 `assets/tailwind.css` 里**根本没有 `.border-red-400`**（前两个 commit 只改了 `PawShop.html`，重建的 CSS 从未提交/部署）；(b) **即便类存在也仍是灰框**：编译产物把 `.border-slate-200`（偏移 9838）排在 `.border-red-400`（9646）**之后**，两者同特异度、后者在前，所以灰色赢；`fieldClass` 现改为**用错误色替换中性色**（不并列两个边框色类）；(c) **State / Country 控件从没走 `fieldClass`**（州下拉与国别 select 是硬编码 class），错误时永远不会有红框，现均已绑定。用 pinned `tailwindcss 3.4.17` 重建（未升级）。
- **CSS 校验**：`assets/tailwind.css` sha256 = `a39414b8ecd65fdd709654e69d6ce2c7e025201f9463ffa41cdb2bf8cd684a9c`，**本地 = 生产 release = 公网 HTTPS 三者一致**（`https://pawlivora.com/assets/tailwind.css` 拉取同 hash，size 18140）；含 `.border-red-400` / `.bg-amber-100` / `.text-red-600`。**（→ 该 hash 已被 2026-09-30 履约 Phase 1 轮的重建取代：现行 `b6f8a625…` / size 18313，见 §0 顶部。`border-red-400` 仍在且与 `.border-slate-200` 的相对次序未变。）**
- **发版**：展示站 `deploy-static.sh` 原子发版 → `48b44d6b3266432f3238bc64f439034b32008428`，`readlink -f /srv/pawshop/current` 确认，`nginx -t` OK。
- **生产实测（真实 Chrome 打生产站）**：无效 ZIP → ZIP 边框 `rgb(248,113,113)` + inline 错误红字 + State 保持灰；空 State → State 边框红 + ZIP 回灰；`?token=…`（无 PayerID）→ "Payment not completed" + Try again / Back to cart，**绝不进成功态**；`?token=…&PayerID=…` 且后端 lookup 返回订单 → "Payment confirmed" + "Your order has been created successfully" + 订单号 + "Continue shopping"，无 raw lifecycle 词。
- **成功仍以后端为准**：`renderOrderSuccess` 只在该 cartId+email 的 `lookupOrder` 真的返回订单后调用（PayerID 只用于区分「继续轮询」与「取消」，从不单独判定成功）。
- **⚠️ 本轮不自行标记 OWNER VERIFIED**：`ADDRESS INVALID-FIELD RED BORDER` 与 `PAYPAL RETURN SUCCESS/CANCEL UX` 均等店主复看。
- **⚠️ 当时 A11 仍为独立缺口（本轮不关闭）**：`SERVER-SIDE ADDRESS STRUCTURE VALIDATION = NOT YET IMPLEMENTED`。**（→ 已于 2026-09-30 第三轮实现并上线，见本文件 §0 顶部与 A11 行。）**

---

**2026-09-30 Checkout Country / Address UX Owner 验收（前一轮，已关单）**：店主按验收路径复测通过，前端关单。只收口前端 UX，不扩功能、不改 Payment/Region/Service Zone。

- **验收路径（全部通过）**：
  1. 无效 ZIP（US→NY→"INVALID"）→ Confirm and pay：页面**不**表现为"按钮没反应"——自动 focus/scroll 到第一个 invalid 字段（ZIP），ZIP 红框 + 明确错误提示 "Enter a valid ZIP code (12345 or 12345-6789)."，按钮恢复可操作（未 disabled、未 stuck loading）。
  2. 修正合法地址（New York / NY / 10001 / US）→ Confirm and pay → **正常跳转 PayPal Sandbox**（`checkoutnow?token=…`）。
  3. 切换 State/Shipping 不丢已填字段（city/state/postal/country 全保留）。
  4. 无额外确认弹窗（无 `confirm()`）。
  5. Shipping option 正常（`so_…` radio 可选、可选中）。
  6. 错误提示能让普通用户知道怎么改（每条 inline 错误指明"错在哪 + 怎么改"，另有总提示 "Please check the highlighted address fields."）。
- **生产核实**：展示站 `current` → `81e45f6`（含 `f04cd98` Country/Address UX + `e35d2e3` focus/scroll 修复），`PawShop.html` 关键逻辑（`validateAddress`/`focusFirstInvalidField`/`fieldClass` 红框）已落地。
- **⚠️ 当时 A11 仍为独立缺口（本轮通过不关闭）**：`SERVER-SIDE ADDRESS STRUCTURE VALIDATION = NOT YET IMPLEMENTED`。**（→ 已于 2026-09-30 第三轮实现并上线，见本文件 §0 顶部与 A11 行。）**

---

**2026-09-29 Checkout→Payment→Success UX 用户视角校对（本轮）**：Owner 按真实用户购物节奏校对，要求更少步骤/更少弹层/更少误操作。本轮只做 UX 审核 + 最小必要修正，不扩账户中心、不加物流、不加"是/否"确认弹窗、不改 Payment/provider/backend semantics。

- **CTA 文案**：`co_place_order` = "Place order/提交订单" → **"Confirm and pay / 确认并支付"**；`co_placing`（loading 态）= "Placing order…/正在提交…" → **"Confirming…/确认中…"**。这是本轮唯一代码改动。
- **审计结论（对照 7 条原则，其余均已符合）**：
  1. Checkout 页面承担最终确认职责，无额外"是/否"确认弹窗（无 `confirm()`）。
  2. 最终 CTA = 确认并支付 / Confirm and pay ✅
  3. PayPal 返回后只回答一个问题（订单是否成功创建）：成功→"下单成功"，失败/超时→"支付已授权，订单生成中…"+ 重试。
  4. 标题中文 "下单成功"（英文保留 "Order placed"）。
  5. 成功页轻量：下单成功 + public number + Total + payment status + 返回商店 + View order 次级入口（不自动展开）。
  6. 完整详情/物流归长期「我的 → 我的订单 → 订单详情 → 物流」，当前无账户中心故不建。
  7. 无自动闪现 lookup/email/详情多层 UI。
- **验证**：21/21 storefront 契约测试 + check-security PASS；展示站 `deploy-static.sh` 原子发版到 `1c7704d`，`readlink current` 确认，边界 200 全绿，线上文案确认无旧 "Place order/提交订单" 残留。

**下一步（已结项 ✅）**：店主已按 §4.2 清单 A–F 复测通过，**ORDER SUCCESS UX = OWNER VERIFIED**。本轮停手，不再扩展。

---

**2026-09-29 Order Detail UX Owner 实测修正（本轮）**：店主已真实走 PayPal 成功回跳并检查订单详情，发现交互/信息层级问题。本轮只做交互与层级校正，不扩功能、不改 Payment/provider/backend order semantics、不加物流追踪/账户中心。

- **去掉支付回跳时的瞬时 Lookup 层**：`openOrderLookupFromSuccess()` 原先先 `renderOrderLookupForm()` 再 `submitOrderLookup()`，造成「闪现一层 → 消失 → 又出现订单内容」。现改为直接 `store.lookupOrder(public_number, email)` → `renderOrderDetail`，全程不再渲染 order-number+email 输入层。`handlePayPalReturn()` 本身轮询用的是 `store.lookupOrder(null, email, cartId)` → `renderOrderSuccess`，本就不闪现 lookup。
- **去掉重复"您的订单"标题**：详情正文原先又渲染一次 `t('order_title')`，与 modal 顶部标题重复。现正文顶部只显示 `订单号：PS-…`，标题只出现在 modal 顶部一次。
- **统一字体层级**：抽出 `orderField(label, value)` 复用（label = `text-xs text-slate-500`，value = `text-sm text-slate-800 font-medium`）；section 标题统一 `sectionTitle()`。避免多个近似字号混用。
- **详情重排为三层**：
  - 第一层：Items（含数量、单价小计）+ Order status + Fulfillment status + Email
  - 第二层：收货地址（姓名 / Address1 / Address2 可选 / City·Province / Postal code / Country）
  - 第三层：Total + Payment status +（shipping_amount 非 null 时追加 shipping method + shipping 金额）
  - 不猜支付/履行状态：`paymentStatusLabel`/`fulfillmentStatusLabel`/`orderStatusLabel` 仍是 `map[raw] || raw || '—'`。
- **呼吸空间**：section 间 `mb-6`（24px），字段间 `space-y-3`（12px），商品间 `divide-y` 轻分割线，无大面积空白。
- **底部**：保留「返回商店」（`order_back`），无物流追踪、无账户中心。
- **验证**：21/21 storefront 契约测试 + `check-security` PASS；展示站 `deploy-static.sh` 原子发版到 `5d72626`，`readlink current` 确认，边界（PawShop.html/store-api.js/root 200、lookup 无 key 400）全绿。

**下一步（已结项 ✅）**：店主已按验收清单复测通过，**ORDER SUCCESS UX = OWNER VERIFIED**。

---

**2026-09-28 Order Success UX 收尾（本轮）**：支付成功 → 成功页真实订单信息 → 查看订单 → 订单详情完整，这个「查看订单」闭环走通。**订单查询已不再是硬阻塞**——用 Guest Lookup（`/store/pawshop-orders/lookup`，order_number+email 双因子，无需 customer auth）实现，绕过 `/store/orders` 的 customer 认证要求。随 `74aff04` 两树发版（展示站 deploy-static + 商务标准升级路径），范围只做查看订单，**不加物流追踪**（等真实 fulfillment/carrier/tracking 接入后才有 Track shipment 入口）。

- **后端** `_commerce/src/api/store/pawshop-orders/lookup/route.ts`：新增返回 shipping method（`shipping_method`/`shipping_amount`）与完整收货地址（`shipping_address{first_name,last_name,address_1,address_2,city,province,postal_code,country_code}`）。原只返回 city/country。
- **前端** `PawShop.html`：`renderOrderResult` 完整展示订单号/email/商品/total/payment status/fulfillment status/shipping method/收货地址/订单状态；成功页加「查看订单」+「返回商店」两按钮；「查看订单」复用 lookup 预填真实 display_id+email（**订单号绝不由前端生成**）。
- **验证**：28/28 测试 + security PASS；后端 lookup 实测 Order #3 返回完整新字段；两树 current 均 `74aff04`、商务服务 NRestarts=0。

**下一步（先停，校对完整闭环）**：店主 PayPal approve → 成功页真实订单号 → 查看订单 → 命中同一订单详情。确认后再决定下一块。

---

**2026-09-27 CloudGull Connector V1.1（PawShop 侧）轮（本轮）**：按 CloudGull 已冻结的 V1.1 契约，只实现 PawShop 侧的同一份 `/api/connector/v1/products`。**代码 + 本地验收全绿，停在凭据边界，未部署。**

- **两个端点**：`GET /api/connector/v1/health`、`PUT /api/connector/v1/products/{source_product_id}`（其余动词一律 404）。覆盖 HMAC-SHA256 / timestamp / nonce / 防重放 / service token + scope / current+next 密钥轮换 / 幂等 / 商品 create+update / 稳定外部商品 id / 结构化错误映射 / 审计。
- **新模块 `pawshop-connector`**：4 张自己建的表（商品映射 / 幂等 / 重放 nonce / 审计）。迁移**只新增 Connector 自己的表，不改 commerce 核心表**；Redis/内存**不作**最终审计来源。
- **验收**：`_commerce` **173/173**（其中 17 项为本连接器，黄金向量由 CloudGull **真实签名器**跑出）、HTTP 端到端 **77 项 0 失败**（签名侧用 CloudGull 自己的代码）、真实 Postgres 引擎（PGlite）持久化 **16/16**、`tsc` **0 错**；根目录 `check-security` / `check-html` / 前台 22 项全绿。
- **边界（红线）**：**未接任何真实凭据、未建 `/etc/pawshop/connector.env`、未部署、未发版、未改生产 nginx、未重启 commerce**；ops 模板只落仓库（nginx 尾斜杠改写段 + 独立限速文件 + systemd 可选 `EnvironmentFile` + 空白 env 模板）。
- **Owner Pending Decision（只登记、不执行）**：① 是否现在部署 → **等 CloudGull 真实 handshake 阶段再单独批准**；② CloudGull 正式媒体域名 → **域名确定后再精确加入白名单，不用通配符**；本次**不动**现有生产 nginx 与图片白名单。详见 `docs/PAWSHOP_CONNECTOR_V1.md`、`docs/OWNER_ACTIONS_ZH.md` §10。

---

**2026-09-27 PayPal FINALIZATION 轮（上一轮）**：支付方向从 Stripe 改为 **PayPal**（V1 PSP，大陆个体工商户可开 PayPal，海外主体不再阻塞）。代码全部就绪并通过本地测试，**唯一硬阻塞 = 店主还没给 PayPal Sandbox 凭据**，所以本轮停在「代码+反代就绪，待凭据跑 E2E」。

- **Owner 已放行**：允许仅为 PayPal webhook 加最小 Nginx 反代（`POST /hooks/payment/paypal` → Medusa），不改其他路由，不碰 Media/Auth/CDN/CloudGull。
- **修复两个 P0**（暴露 webhook 前必须补，详见 `docs/PAYPAL_SANDBOX_E2E.md`）：
  1. **webhook 无签名验证** → 已补 `verifyWebhookSignature`（调 PayPal `/v1/notifications/verify-webhook-signature`，失败即 `not_supported` 不建单）。
  2. **authorize 只 GET 不授权** → 已修 `authorizePayment` 主动调 `POST /v2/checkout/orders/{id}/authorize`（PayPal `intent=AUTHORIZE` 订单 approve 后必须商户主动授权，否则无可捕获的 authorization）。
- **就绪但未部署**：Nginx webhook 反代 canonical（`ops/nginx/sites-available/pawshop` + 限速区 `pawshop_webhook`）；E2E 手册 `docs/PAYPAL_SANDBOX_E2E.md`。
- **本地验证**：前台 22 + commerce 156 项、tsc、check-security、html 全绿。

**下一步（卡在店主）**：到 developer.paypal.com 建 App，给 Sandbox Client ID/Secret + Webhook ID + 买家测试账号（步骤见 `docs/OWNER_ACTIONS_ZH.md` §4）。给齐后我部署反代 + 发版 + 跑完整 Sandbox E2E。

---

**2026-09-26 前台 Storefront 完整化结项（上一轮）**：把前台推进到「每页能进、每页有状态、关键操作走通闭环」，范围=**支付前闭环 + 状态完善**（支付/订单仍被海外主体硬阻塞，保留真实边界，不造假订单）。随展示站发版 `235745e`（`da66764` + `235745e`）上线，**只动展示站静态文件，商务 `e443e7f` 不动**：

- **旧 `product.html` 停用**：它是死代码（静态 `catalog.json` + `localStorage` 假购物车 + prelaunch 旧文案），与主 SPA 两套系统互相矛盾。已改为 **302 重定向 shim**（meta refresh + canonical → `PawShop.html`），sitemap 移除、tailwind content 移除。
- **新增 `faq.html`**（诚实文案：商品+购物车已上线、支付未接通、不虚假承诺），挂 footer；`deploy-static.sh` 白名单同步加 faq.html。
- **支付边界升级**：`placeOrder()` 从 toast 一句话升级为 checkout 弹窗内的**明确边界面板**（未扣款/未创建订单/购物车已保存三条 + 返回按钮）。诚实、不伪造支付。
- **状态完善确认**：加载/空/错误/售罄/重试/移动端/购物车刷新恢复，主 SPA 此前已具备，本轮逐项核实 + 契约测试覆盖。

**实测**：本地 `npm test` 21/21 全绿（含更新后的支付边界契约测试）+ `check:security` + `check:html` 通过；公网 10 个页面全 200；无头 Chrome 渲染确认两商品 `In stock`、footer 有 FAQ、Cart 状态正确。

**本轮量清的两个硬阻塞（订单链路，均非代码可解）**：
1. **支付**：region `payment_providers` 空 + 店主无海外主体（开不了 Stripe）→ 无真实订单。
2. **订单查询/详情**：`/store/orders` 需 customer 认证（401），`/store/auth/customer/*` 全 404（**customer auth 未注册**）→ Order Lookup/Detail 依赖 customer 登录，而 customer 登录未启用。这是支付之外的**第二个独立硬阻塞**。

> ⚠️ **订正（2026-09-28）**：第 2 条已被推翻。订单查询通过**自建 Guest Lookup**（`/store/pawshop-orders/lookup`，order_number+email 双因子校验，无需 customer auth）实现，绕过了 `/store/orders` 的 customer 认证要求。09-28 `74aff04` 起该 lookup 返回完整订单字段并驱动成功页「查看订单」闭环。**订单查询不再是硬阻塞**；`/store/orders` 的 401 与 `/store/auth/customer/*` 的 404 仍存在，但只是"未启用 customer 账号体系"这一独立事项，不影响订单查询。

**未动（店主决策/法律风险）**：`shipping/returns/privacy/terms` 仍是 prelaunch 占位文案（涉及政策内容，需店主提供）；支付/订单链路（需海外主体 + customer auth）。

**2026-09-19 第三轮结项（本轮）：落地页接上了真实 Store API（P0-5 完成）**，静态站发版 `0422cb5`。新增 `store-api.js`（列商品 / 读购物车 / 建购物车），`PawShop.html` 改为按真实商品与真实游客购物车渲染（刷新能找回同一台 cart），`config.js` 带上 publishable key 与图床白名单，`safe.js` 新增只放行自有域名与白名单图床的 `image()`。**产品目录是空的（`products=0`），所以前台如实显示"暂无可购买的商品"——没有任何演示商品、没有回退目录**；`check:security` 新增三条禁令（`/complete`、支付会话、顾客账号）把"越长越大"挡在门外。

**实测（不是推测）**：本地门禁全绿（`npm run check` **26/26**，含 10 项新前台契约测试，`check:security` 与 `check:html` 通过）；真实浏览器（无头 Chrome）打开 `https://pawlivora.com/PawShop.html`，网络日志里确有一次 `GET /store/products?...&region_id=reg_01M2W4PYEVVYAGCY4RHAP7Q0HH` → **200 / 0 商品**，DOM 渲染 `no_products`（"店空着"）而**非** `catalog_unavailable`（"店坏了"）；`POST /store/carts` 建出真购物车、`GET /store/carts/{id}` 回读一致、不存在的 cart 解析为 `null`、假 variant 被 **400** 拒；无 key 仍 **400**；发版后监控 **12/12**。

**这一轮的边界（明确不做）**：支付、订单、顾客账号、Stripe、`/hooks/payment/` 反代、运营台，一律没碰。**下一步的真实阻塞仍在店主**：① 进后台建首件商品（P0-3，只有他能做）→ 前台会自动显示，不需要我再发版；② 收款主体的决定（P0-6 的前置）。

**P0-5 的已知留白（只记录，不顺手做）**：`catalog.json` 现在是"发版探针的凭证"而非前台数据源，属无害死重（**09-26 起 `product.html` 已改重定向 shim，不再走静态目录，两台前台并存问题已消除**）。

**2026-09-19 第二轮结项（本轮）**：**顾客侧 API 已对公网开放**，随 `cddfab5` 走**升级路径**（不清库）上线：准备 release → 升级迁移（**147 关系 / 601 行一行未少**）→ 迁移后加密备份 + 异地精确版本回读 + 隔离恢复演练 → 合闸 → 激活 → 开门三件（nginx `/store/` 反代 + `PAWSHOP_MODE=production-storefront` + 监控 `store_api_open` 换真 key）→ 监控 12/12。对外实测：带真 key `/store/products` **200**、无 key **400**、`POST /store/carts` **200 并真的建出购物车**（USD / 美国 region）；`/admin/*` 仍 **401**。升级窗口期间**一条告警都没发**（停机窗口正好落在两次巡检之间）。

**本轮顺带修掉一个真故障（它由"开门"这一步暴露）**：单元的启动就绪门 `verify-production-admin.mjs` 把档位写死成 admin-only，开门后**每次启动都失败 → 无限重启**（实测 `NRestarts` 涨到 3）。同一处写死还在 4 个店主账号脚本里（开门后建账号/找回密码/两项验收会全部拒跑）。两处都已改并加了契约测试，见 `RUNBOOK.md` §15.5。

**本轮同时量清了"顾客要能下单，商业基线还缺哪一件"**（口径见 `RUNBOOK.md` §15.7）。**已在的**：`United States / USD` region（国家 `us`）、1 个 publishable key 且已挂到默认 sales channel、`PawShop Warehouse` 库存地、fulfillment set + shipping profile、`United States` service zone、`Standard Shipping`（flat，USD 9.90）——**P0-2 的主体已经在开门验收时建好了，下一轮不要重复建**。**唯一缺的**：该 region 的 **`payment_providers` 是空的**（`GET /store/regions` 带真 key 实证 `payment_providers=None`）→ **现在任何结账都会在"完成购物车"那步抛 `not enabled in the cart's region`**。这件正是 **P0-6 的接线段**（把 `pp_stripe_stripe` 加进 region）。⚠️ **红线：`pp_system_default` 绝不能加到这个 region**——它恒 `authorized`、`capture` 为空操作，等于"不收钱也把订单走完"，只可在关店窗口做一次性演练且必须立刻移除。

**2026-09-19 第一轮结项**：`bbabde4` 已推送并走**升级路径**（不清库）上线：构建 → 刷 libexec → 升级迁移（147 关系 / 601 行一行未少）→ 迁移后备份 + 异地回读 + 隔离恢复演练 → 合闸 → 激活 → 监控 12/12 → 备份新鲜度双来源上线 → **备份密钥已按钥匙环轮换并验收**。店主账号与数据全在。本次实跑还处置了两个"写了但从未跑过"的空档（升级窗口残留、单元文件手工安装），均已修/已记（`RUNBOOK` §11.2）。

**接下来不再是"我卡住了"，而是只有店主本人能做的那几件事**（链接、点击步骤、交付方式见 `docs/OWNER_ACTIONS_ZH.md`）：

1. ~~**QQ 邮箱 SMTP 授权码**~~ → **✅ 2026-09-18 14:59 结项**：授权码按"先真发一封自检邮件、对方接受了才写入"的顺序装到 `/etc/pawshop/email-credentials.json`（`root:pawshop 0640`、非符号链接，凭据指纹 `4007df34874c` 与店主文件逐字节一致），随后服务日志确认 `the subscriber handed the message to the relay for 504533680@qq.com`——"忘记密码"真的会发信了。**这一条 2026-09-18 16:47 实测复核**：文件在（`f3c0a9a82608`，键集合恰为 `from,host,password,port,secure,user`，130 B，mtime `14:59:51`）。
2. ~~**重新生成 Slack Incoming Webhook URL**~~ → **✅ 2026-09-18 结项（店主选择摘除）**：那条地址在 Slack 侧已被撤销，店主选择**不重建、直接摘掉**。已从 `monitoring.env` 摘除（**只改 1 行**，飞书那行逐字节未动，属主/权限保持 `root:pawshop 0640`，备份 `/root/pawshop-monitor.env.bak-20260918T082109Z`），改完复跑真实投递验证：告警与恢复各一条**均 `feishu accepted the payload`**，巡检 `12/12`、0 跳过行。当前告警走**飞书单通道**；将来想恢复双通道，见 `docs/OWNER_ACTIONS_ZH.md` §1.6。
3. ~~**删掉接管期遗留的 RAM 用户 `pawshop-agent-temp`**（需控制台手工删）~~ → **✅ 2026-09-18 结项**：店主已在控制台删除（属记账性质，见 A4）。
4. **Airwallex / PingPong 收款申请**（§D）—— 只在你手上，与工程侧解耦。
5. **`~/Downloads/AccessKey.csv`**（1 分钟）：确认无用后删掉（§A9）。**这是唯一一件"可做可不做"的技术小事。**

**我这一侧未落地的动作**：无（`c336fa7`、`3532c67` 已于 2026-09-19 02:30 推送）。**推送规矩更新（2026-09-19 店主定）：本地提交直接推，不再询问**；要修就追加提交再推。推送链路：先探测（店主 clash 开着用 `-c http.proxy=http://127.0.0.1:7897`；没开用沙箱出口 `env|grep -i proxy`，2026-09-19 实测 `51455` 可用），**不改店主 `.git/config` 里的 7892**。

---

## 0.1 下一轮计划（**2026-09-18 17:20 店主已选定**）

**店主的选择**：(1) 后台暴露走 **(b) 同源反向代理**（见 A6，含"白名单不可用"的修正）；(2) 下一轮先做 **发版侧三件小改动**（不是运营台）。

### 任务 A：发版侧三件小改动（**✅ 2026-09-19 全部上线，随 `bbabde4` 发版实跑验收**）

一次发版打包走完，全部走已实跑的升级路径（**不清库**）。**已于 2026-09-19 推送（店主批准）并上线。**

| # | 改动 | 状态 | 落点与要点 |
| --- | --- | --- | --- |
| 1 | **备份密钥轮换（A7）** | ✅ **已执行** | 钥匙环已上线（`bbabde4` + libexec 刷新），**轮换已于 2026-09-19 01:51 执行并验收**：`retired:0168d887dfa4` → `current:67f9d337ab5e`，验收备份 `Result=success`（含对全部历史 manifest 的逐条重验），监控 12/12。执行记录见 `RUNBOOK.md` §13.3。 |
| 2 | **备份新鲜度跨重启（A3）** | ✅ **已上线** | `run-scheduled-backup.mjs` 写 `/var/lib/pawshop-backup/last-success.txt`；`pawshop-backup.service` 的 `StateDirectory` 已随发版安装；`monitoring.env` 已加时间戳变量（按"先有文件再加变量"的顺序）。实测：加变量后监控 12/12，新鲜度读数切换到文件来源。见 `RUNBOOK.md` §9.4。 |
| 3 | 手册补记 | ✅ **完成** | `RUNBOOK.md` §13.3 轮换流程 + 首次执行记录、§9.4 双来源、§11.2 新增 1.5（libexec）/ 1.6（单元文件）两个"就位"步骤与第二次实跑记录。 |
| 4 | 刷新 libexec | ✅ **已执行** | 3 个改动文件（`backup-integrity.cjs`、`monitor-production.mjs`、`monitoring-policy.cjs`）已按 §11.2 的 1.5 装入 `/usr/local/libexec/pawshop/` 并 cmp 收敛；`matchBackupKeyRing` 在主机可用。libexec 快照备份在 `/root/pawshop-libexec-backup-20260918T171313Z/`。 |
| 5 | T2 上线顺序 | ✅ **已执行** | 发版 → 真跑一次备份（`Result=success`，`last-success.txt` 出现且 0644）→ 加 `PAWSHOP_MONITOR_BACKUP_TIMESTAMP_FILE` → 复跑监控 12/12。 |

**本次实跑新增的两个"就位"点（都已写进 RUNBOOK §11.2）**：升级窗口残留要归档（上次成功升级留下的 before/after 快照让本次在第 2 步被拒；代码已修，随下一 release 生效）；**改了单元文件的发版必须手工装单元**（`install-commerce-runtime.sh` 只服务首次休眠安装，升级没有自动入口）。

### 任务 B：后台暴露 (b)（**✅ 2026-09-19 02:35 上线并全链路验收**）

nginx 已开三段反代：`/admin/`（Basic + Medusa 会话双层）、`/auth/user/`（Basic，登录入口）、`location = /auth/session`（**有意不叠 Basic**——一个请求只有一个 `Authorization` 头，这端点靠 Medusa 验 Bearer JWT 自鉴权，而 JWT 只能从被 Basic 闸住的登录拿到）。实测的完整链路：登录 200 → 换 `connect.sid` cookie → 调 `/admin/users/me` 200（认出店主账号）→ 去 Basic 401 → 登出后旧 cookie 401。回归全对（`/`·`/sitemap.xml` 200，`/app`·`/store/*` 404——其中 **`/app` 的公网 404 只到 2026-09-19 白天为止**，当晚起经 `/console/` 对公网开放，见 `RUNBOOK.md` §14.4/§14.5），监控 12/12。设计、验收、轮换、回滚见 `RUNBOOK.md` §14。**Basic 口令在主机 `/root/pawshop-admin-basic-auth.json`**（用户名 `owner`）。注意：文档早前写的 `/admin-api/` 是泛称，这个 Medusa 版本的真实前缀是 `/admin/`。**前置已满足，任务 C 可以开工。**

### 任务 C：中文运营台（**店主 2026-09-19 已点头，但同日起随"首笔真实订单"目标暂停，未开工**）

分三步，风险递增：**只读看板**（订单/库存/销售）→ **商品上架**（草稿默认不公开）→ **发货与退款**。前置任务 B 已通（浏览器现在能调到 Admin API）。见 C 节。

---

工程侧下一个里程碑是**中文运营台**（要不要做、做到哪，见 C 节）。基线：`docs/RUNBOOK.md` §11 与 §11.2（激活序列与升级序列，均已实跑）。

---

## A. 生产环境现状与剩余项

### 已完成的（本轮及前几轮）

| 项 | 证据 |
| --- | --- |
| HSTS + www→apex 301 | `verify:production:strict` PASS；`max-age=15552000`；`www` 301 到 apex |
| 展示站发布 | release `6dce5a4`；`/srv/pawshop/current` 指向它；上一版 `a74aab3` 保留可回滚 |
| sitemap.xml + robots 声明 | 线上 200、XML 合法、7 条 URL；`Sitemap:` 已写入 robots.txt |
| 监控定时器 | `pawshop-monitor.timer` enabled+active，每 5 分钟；实测 **12/12** |
| 告警通道（**当前 `feishu` 单通道**） | 2026-09-17 接入双通道并真实投递验证；2026-09-18 店主选择摘除已失效的 Slack（其 webhook 在 Slack 侧被撤销，`404`）→ 现为飞书单通道，摘除后复验告警与恢复**均被飞书接受**、巡检 `12/12`。多通道脚本与"点名未确认通道"的日志能力都还在主机上，随时可恢复双通道。详见 A1 |
| **备份凭据 + 两个闸门** | `pawshop-backup-writer` + 最小权限策略（对象级三权限，**读不到任何桶级元数据**）；密钥 root-only、`LoadCredential` 注入；`DeleteObject → 403`、**版本控制改用功能性证明（覆盖上传后旧版本仍可读）** 均已实测；自检脚本 `ops/commerce/verify-offsite-credential.mjs` **7/7**。⚠️ 运行时改为**对象级**版本证明——原 `GetBucketVersioning` 前置检查在该权限边界下**永不通过**（首次备份实测暴露，已修） |
| **OSS 生命周期** | 4 条规则（原有全桶非当前版本规则 + daily 90 / monthly 365 / yearly 1095），写入后回读核对 |
| 陈旧 GitHub Pages 镜像（AR-8） | 已停用，镜像 URL 返回 404；仓库仍为 PUBLIC |
| 隐私声明事实性 | 已改为"自管主机、同源资源、无第三方 CDN"；日期 2026-09-16 |

### 未完成

| # | 项 | 级别 | 归属 | 说明与前置条件 |
| --- | --- | --- | --- | --- |
| A1 | ~~**Slack 告警通道已失效**~~ → **✅ 2026-09-18 结项** | — | **Agent** | 定性：该 webhook 在 Slack 侧已被撤销（同一次实测中飞书正常）。处置：**店主选择不重建、直接摘除**；已从 `monitoring.env` 移除（只改 1 行，飞书那行逐字节未动，备份 `pawshop-monitor.env.bak-20260918T082109Z`），复验告警 + 恢复均被飞书接受、巡检 12/12。当前为**飞书单通道**。 |
| A2 | ~~**邮件凭据（QQ SMTP 授权码）未安装**~~ → **✅ 2026-09-18 14:59 结项** | — | **店主 → Agent** | 已安装并端到端验收：`/etc/pawshop/email-credentials.json`（`root:pawshop 0640`、非符号链接、键集合恰为 `from,host,password,port,secure,user`、内容指纹 `4007df34874c` 与店主所给逐字节一致），装前先真发一封自检邮件、被接受才写入，装后服务日志出现 `the subscriber handed the message to the relay for 504533680@qq.com`。装完**不需要发版、不需要重启**。过程留档见 `docs/OWNER_ACTIONS_ZH.md` §1.2，命令见 RUNBOOK §12.4–12.5。 |
| A3 | ~~备份新鲜度缺少跨重启的可靠信号~~ → **✅ 2026-09-19 结项（已上线）** | — | **Agent** | 已改为**双来源**并随 `bbabde4` 上线：备份成功后自写 `/var/lib/pawshop-backup/last-success.txt`（跨重启存活）+ systemd `Result`（几分钟内报真失败），两者都要过。`StateDirectory` 单元已装、`monitoring.env` 已加时间戳变量，实测 12/12。见 `RUNBOOK.md` §9.4。 |
| A4 | ~~临时 RAM 用户 `pawshop-agent-temp` 残留~~ → **✅ 2026-09-18 结项** | — | **店主** | 店主已删除。它本来就已零权限（OSS 管理面/数据面与 RAM 全 403），删除只是身份名单卫生。**⚠️ 记账性质**：删除后我没有任何可控凭据可以独立回查（该身份按设计读不了 RAM 管理面，本机也没有 RAM 凭据），所以这条是"按店主操作记账"而非我的测量结果；下次类此操作应**先留一份受控凭据再删**。故事与顺序教训见 `docs/OWNER_ACTIONS_ZH.md` §2.3。 |
| A5 | 收款通道（Airwallex / PingPong） | P1 | **店主** | 需店主本人申请；与工程侧无耦合。 |
| A6 | ~~后台对店主的暴露方式未定~~ → **✅ 2026-09-18 17:20 店主已定：走 (b) 同源反向代理** | P1 | **共同（已定，待执行）** | nginx 在 `pawlivora.com` 下开 `/admin-api/` → `127.0.0.1:9000`。**⚠️ 方案要改一处**：店主选的是"叠加 IP 白名单"，但实测他的来源 IP 一天内出现过 4 个不同地址段（`61.149.161.174` / `115.171.229.55` / `223.160.130.117` / `223.160.131.33`），根因是**他现在走手机热点**（网关 `172.20.10.1`）→ **静态白名单会把他本人挡在门外**。因此访问控制改为：**nginx Basic Auth（口令加盐哈希存储）+ Medusa 自身鉴权**两道，**IP 白名单降级为可选开关**（他换固定宽带出口后再开）。详见 `docs/OWNER_ACTIONS_ZH.md` §6.1。**执行顺序：等发版侧三件小改动（A7/A3）走完之后做，因为它本身不依赖发版**。 |
| A7 | ~~**备份加密密钥已进入对话记录**~~ → **✅ 2026-09-19 01:51 结项（已轮换并验收）** | — | Agent | `2026-09-18` 脱敏器把 `/etc/pawshop-backup/backup.key` 原文打印进会话记录。钥匙环代码随 `bbabde4` 上线后，已按 `RUNBOOK.md` §13.3 执行轮换：现钥归档为 `retired-keys/backup-0168d887dfa4.key`，新钥 `current:67f9d337ab5e`（只记指纹）。验收备份 `Result=success`——同步进程逐条重验了**全部历史 manifest**（旧集合用退役钥），即"轮换没打断历史"的直接证据；轮换后监控 12/12。**退役钥在它签发的所有 dump 过期前不得删除**；人工恢复旧集合时按 §13.3 把它拷进 restore input。 |
| A8 | ~~`sshd` 多开公网 22222 端口 + `Match User admin` 块~~ → **🟢 2026-09-18 17:05 查清：建议保持原样，无需任何动作** | — | **Agent** | **更正前一版"主机上手工加的无文档配置"的说法**：`Port 22222` 是**服务器开通当天的平台初始配置**（`Server listening on :: port 22222` 最早 `Sep 06 17:43`，`99-pawshop.conf` 文件时间 `Sep 6 18:29`）。`admin` 是**阿里云 SWAS 平台创建的用户**（UID 1000、密码锁定 `L`、带 `NOPASSWD: ALL` sudo），其 `authorized_keys` 里的非生产密钥注释为 **`swas-imported-key`**（阿里云导入密钥）→ 那 ~320 次 `Accepted publickey admin from 100.104.x.x` 是**阿里云控制台「远程连接」走内网**，末次 `Sep 14 17:36`，**全发生在我 Sep 16 开始工作之前**。**处置：不关端口**——关掉收益≈0（爆破本就不可能成功，只允许密钥），却可能打断阿里云控制台那条内网通道；已写成 `RUNBOOK` 的正式约定。 |
| A9 | 店主 `~/Downloads/AccessKey.csv` 明文凭据 | P2 | **店主** | 含一对真实 AccessKey（ID 24 位 / Secret 30 位，文件时间 `2026-09-13 17:56`）。**指纹比对确认不是生产在用的任何一把**（备份 OSS 密钥 `30f36f937bf4`/`977ae2c163a8`、商务 S3 密钥 `c5d4a2e09e69`/`816c291af801` 均不同）→ 生产不受影响。建议确认已无用后删除；若仍在使用，应改为独立 RAM 用户并尽快轮换。**我未改动该文件**（个人目录只读不写）。 |
| A10 | `_commerce/scripts` 没有静态"未定义标识符"检查（本轮真实差点上线） | P2 | Agent（**提议**） | 本轮我把 `manifestKeyTest` 用在 `sync-production-backups.mjs` 里**却漏了导入**：`node --check` 只做语法分析（语法合法，通过），四个契约测试只匹配字符串（也通过），**本地全绿但一上生产就是 `ReferenceError`**。是逐行复核 diff 才发现的。这些脚本本地跑不起来（模块加载即抛"必须 Linux/非 root"），所以没有"跑一下就知道"的兜底。**提议**：给 `_commerce/scripts` 加 ESLint（`no-undef` + `sourceType: module`）作为本地门禁；在没做之前，改这类脚本必须**逐行核对新用到的符号是否都在导入行里**。 |
| A11 | ~~**SERVER-SIDE ADDRESS STRUCTURE VALIDATION = NOT YET IMPLEMENTED**~~ → **🟡 2026-09-30 已实现并上线（commit `f00139c`，商务站 code-only 发版）；等店主验收，未标记 OWNER VERIFIED** | P1 | **Agent** | 结算地址的服务端结构化校验已实现。**插入点**：`POST /store/carts` 与 `POST /store/carts/:id` 两个 cart 写路由上的 storefront-profile 专属 middleware（`_commerce/src/api/middlewares.ts` 的 `cartAddressValidation` → `_commerce/src/lib/address-structure.cjs` 的 `validateCartShippingAddress`）。这是前台存地址的唯一入口，因而**天然位于 shipping method 选择 / payment collection / PayPal hand-off 之上游**；不带地址的更新（email、shipping method）原样放行。**规则**：① 全国家必填 `first_name`/`last_name`/`address_1`/`city`/`country_code`/`province`/`postal_code`；② 仅 US 加结构校验——`province` 必须是 50 州+DC+territories（AS/GU/MP/PR/VI）两字母码，`postal_code` 必须是 `ZIP` 或 `ZIP+4`（`^\d{5}(-\d{4})?$`）；③ 非 US 只做必填完整性，**不发明任何国家级格式**。**Region 权威未动**：middleware 只用 `country_code` 选择套哪套结构规则，**从不拒绝国家**——国家是否可配送仍由 Medusa Region 裁决（实测非 region 国家 CA 通过本 middleware 后由 Medusa 以 `Country with code ca is not within region United States` 拒绝，无本模块的 `code` 字段）。**未改**：PayPal provider / authorize/capture/refund/webhook、Region/Service Zone/shipping option 数据模型、checkout UI 结构。失败返回 400 `{"type":"invalid_data","code":"cart_shipping_address_invalid","errors":[{field,code,message}]}`。19 条新测试；commerce 194/194、types、security、storefront 44/44 全绿。细节见 §0 本轮段。 |

**已结项（2026-09-18，全部有实跑证据）**：

- **提交已推送**（`aaa5673`），主机已取码并构建 release。
- **加密备份链已启用**：首次备份 + OSS 精确版本回读 + 隔离恢复演练通过；**且此后每次发版都会再跑一次**（升级流程的第 3 步）。
- **监控临时跳过已删除**：`monitoring.env` **0 跳过行**，实测 **12/12 全部真实检查**。
- **生产库已非空**：**155 关系 / 147 表 / 601 行**，含店主账号 `504533680@qq.com`。
- **商务 release 已部署并在跑**：`current` → `aaa56732efad4934f4d67c14dc684f8d208fbbd9`，服务 enabled+active、`NRestarts=0`、只监听 `127.0.0.1:9000`。
- **一个数据库只能激活一个 release** 的隐患已消除，且已用本次发版实跑验收（147 关系 / 601 行 **一行未少**）。

---

## B. 商务后台（Medusa）激活 —— ✅ 已完成（2026-09-18 走升级路径发版到 `aaa5673`）

这是 Codex 方案里"先激活生产后台并验证商品草稿上传"那一步，于 2026-09-17 首次打通、2026-09-18 用**升级路径**完成第二次发版（不清库、店主账号与数据全在）。**A2/A3/A5 都由它解锁并已结项**（详见 A 节与 B3）。

**激活链（可执行命令已整理进 `docs/RUNBOOK.md` §11 首次激活 / §11.2 后续升级，全部为已审查脚本）**

1. 更新 `/srv/pawshop-source` 到目标 commit（它是**商务**构建源，与展示站的 `/srv/pawshop/source` 是两棵独立的树）。⚠️ **必须是已推送的提交**（A0）。
2. `prepare-commerce-release.sh` → 产出 `/srv/pawshop-commerce/releases/<sha>`（带 manifest + evidence）与内容摘要。
3. `run-first-production-migration.sh` 执行首次迁移（写 `migration.json` 门禁）。
4. `run-first-production-backup-restore.sh`：**首次加密备份 + 离线精确版本回读 + 隔离恢复演练**（写 `backup-restore.json`）。**这一步不通过就不允许激活。**
5. `deploy-commerce.sh` 激活（`PAWSHOP_RELEASE_ACTIVATION_CONFIRMED=1`）→ 建 `current` + 重启服务。
6. 激活后：删掉监控里的临时跳过行（A3）→ 启用 `pawshop-backup.timer` → 验证商品草稿上传。

> ⚙️ **2026-09-17 修正一处错误说法**：`deploy-commerce.sh` **不会安装** systemd 单元，它只把已安装单元与候选 release **逐字节比对**，不一致就**拒绝激活**（"Installed runtime units do not match the exact candidate release."）。会安装的是 `install-commerce-runtime.sh`，而它是"首次安装专用"（目标已存在即拒绝、要求无 `current`），在混合状态上不可用。当日实际发生的是：`pawshop-backup-monthly.{service,timer}` 与 `pawshop-backup-yearly.{service,timer}` 这 **4 个月/年归档单元从来没有被安装过**（release 里有、`/etc/systemd/system` 里没有），把激活门禁卡死。处置是按 release 内容逐字节 `install` + `cmp` 补齐（快照在 `/root/pawshop-unit-snapshot-*`）。**教训：部署脚本"比对"不等于"就位"，首次上线要自己核对单元清单是否真的装齐。**
>
> 另外，店主的**后台账号**（`/root/pawshop-production-owner-credentials.json`）由 `finalize-production-admin.sh` / `provision-production-owner-credentials.mjs` 在激活后创建。**脚本不生成邮箱、需要店主给一个**（密码由脚本随机生成并写进 root-only 文件，不打印）。**当前阻塞在"等店主给邮箱"这一步。**

**需要店主先拍板的一件事（B2）**：后台暴露方式。RUNBOOK 的既定设计是**回环 + SSH 隧道**（`127.0.0.1:9000`，不对外）。这最安全，但也意味着**浏览器里的中文运营台无法直接调 Admin API**（浏览器在你自己电脑上，够不到服务器的回环口）。三条路：

- **(a) 保持回环 + SSH 隧道**，运营台只在店主本机跑。最安全，但"随时随地用"很别扭。
- **(b) 同源反向代理**：nginx 在 pawlivora.com 下开 `/admin-api/` → `127.0.0.1:9000`，加 IP 白名单或 Basic Auth，再叠 Medusa 自身鉴权。**运营台能用，攻击面从 0 变成 1**，但可控。推荐作为运营台的前置。
- **(c) 直接公网暴露 Admin API**：不推荐。

**我的判断：走 (b)**，但要在运营台开工前先定，否则运营台做完发现调不通。

### B3 2026-09-18 状态与未结项

**已完成**：商务后台**已激活并在跑**，且**已于 2026-09-18 用升级路径发版到 `aaa5673`**（`current` → `/srv/pawshop-commerce/releases/aaa56732efad4934f4d67c14dc684f8d208fbbd9`，服务 enabled+active、NRestarts=0，只监听回环 `127.0.0.1:9000`），4 个定时器（3 个备份 + 监控）全部 enabled，首次加密备份 + OSS 精确版本回读 + 隔离恢复演练全部通过，线上店铺全程 200 无中断，**监控 12/12 全部真实检查（无任何跳过行）**。**店主账号仍在**（`504533680@qq.com`，`user` 表 1 行）——这正是升级路径要保住的东西。⚠️ 更正：此前文档写的"`current` → `9bac8dc`"与主机不符，实测 `9bac8dc` 早于 `d316bd4`，即 9 月 17 日最终停在 `466cfc5`；现已由 `aaa5673` 取代。

**未结项（按优先级）**：

1. ~~**P0｜店主账号未建**~~ → **✅ 已结项**（账号 `504533680@qq.com`，凭据只在 `/root/pawshop-production-owner-credentials.json`；2026-09-18 发版后重新做了一次真实登录验收，通过）。
2. ~~**P0｜一个数据库只能激活一个 release**~~ → **✅ 2026-09-18 结项，且已实跑验收**：升级证据路径（`pawshop-production-migration-v2`，`initialization: 'existing-database'`）+ `ops/commerce/run-production-upgrade-migration.sh` + `write-production-upgrade-evidence.mjs`；门禁与备份证据两处断言同时接受两种证据，空库路径一字未改。**首次实跑就是 `aaa5673` 这次发版**：147 关系 / 601 行 → 147 关系 / 601 行，**一行未少**（逐表精确行数见证，`relations_*_sha256` 可由 `sha256sum` 复算），改动前加密恢复点 `pawshop_production_20260918T063311496Z` 先取后验，迁移后备份异地回读 + 隔离恢复演练通过。全程明细见 RUNBOOK §11.2。**结论：后续发版不再需要清库，店主现在可以放心往后台录真实商品与客户数据。**
3. **✅ 已结项（2026-09-18）｜Slack 告警通道已失效**：`alert channel slack did not accept the payload (status 404, provider code none)`，告警与恢复两轮都是如此。**配置侧原因已排除**：店主提供的地址与主机 `monitoring.env` 里现存的**逐字相同**（两者 `sha256[:12]` 均为 `cb1f84d459ef`），且 URL 结构完整（`/services/` + 标准 `T`+10 位 / `B`+10 位 / 24 位，字符集干净、无截断）→ 结论是**该 webhook 在 Slack 侧已被撤销**（被删／应用卸载），**重新贴同一个地址不会有任何效果**。同样这两轮里**飞书均正常**（`feishu accepted the payload`），所以现在是"1/2 通道"，告警仍能到达店主，但少一层冗余。 **处置（2026-09-18 16:21）**：店主选择**不重建该通道**，我按他的选择把它从 `monitoring.env` 摘除——**只改 1 行**、飞书那行逐字节未动、属主权限保持 `root:pawshop 0640`、改前备份 `/root/pawshop-monitor.env.bak-20260918T082109Z`；失败模式已封：只剩 0 条通道时拒绝写入、存在 legacy `PAWSHOP_MONITOR_ALERT_WEBHOOK` 时拒绝盲改、同一键出现多次时拒绝。改完复跑真实投递验证：告警与恢复各一条**均 `feishu accepted the payload`**，巡检 `12/12`、无跳过行，日志里不再出现 slack 行。**当前告警走飞书单通道**；想恢复双通道时见 `docs/OWNER_ACTIONS_ZH.md` §1.6。
4. ~~**P1｜备份新鲜度缺少跨重启的可靠信号**~~ → **✅ 2026-09-19 结项（随 `bbabde4` 上线）**：双来源判定（`last-success.txt` + systemd `Result`）已实装，`monitoring.env` 已加时间戳变量，实测 12/12。

**已结项（同日）**：定时备份的异地同步（`ExecStartPost` 读不到 systemd 凭据 → 异地副本静默落后）已随 release `9bac8dc` 修复并实测通过；`SKIP_SYSTEMD_CHECKS` 已删除，监控不再有任何跳过行。`aaa5673` 这次发版还把 **libexec 漂移窗口关掉了**：`/usr/local/libexec/pawshop/` 四个文件与候选 release 逐字节相同（`deploy-commerce.sh` 的 `cmp` 已通过）。

**同日稍后（14:59）**：**「忘记密码」的发信通道已接通并端到端实测通过** —— 店主提供的 QQ 邮箱授权码按“先真发一封自检邮件、对方接受了才写入”的顺序装到 `/etc/pawshop/email-credentials.json`（`root:pawshop 0640`；凭据指纹 `4007df34874c` 与店主文件逐字节一致），随后服务日志确认 `the subscriber handed the message to the relay for 504533680@qq.com`。**至此店主侧只剩两件事：新生成 Slack webhook、删除临时 RAM 用户。**

---

## C. 中文运营台（对 Codex 方案的意见）

**结论：同意。保留 Medusa 做订单/商品/库存/支付的底层引擎，另建中文运营台。** Medusa 官方确实支持用 Admin API 完全自定义后台，原生后台降级为"高级/故障处理入口"是合理做法。

**技术上可行，但方案里有一处被略过的关键约束**：Codex 说"静态构建后放在现有服务器上，通过 Medusa Admin API 操作数据"。静态 SPA 部署没问题（不需要额外服务进程，2GB 够），**但"通过 Admin API"这一步依赖 B2 的暴露决策**。静态页面是跑在**店主浏览器**里的，它要用 `fetch` 打 Admin API——所以 Admin API 必须从浏览器可达。这就是为什么 B2 要在 C 之前定。

**实现要点**

- 前端：React + TypeScript + Ant Design（中文组件），静态产物放 `/srv/pawshop/current/ops-console/` 或独立路径，随展示站发布流程一起走（复用 `deploy-static.sh` 的原子切换与回滚）。
- 调 Admin API 用 **publishable/admin API key + 会话令牌**，令牌只存内存或 `sessionStorage`，不要落 `localStorage`。
- **不要**把运营台塞进 `deploy-static.sh` 现有白名单里就完事——它是**内部工具**，必须走 B2(a)/(b) 的访问控制，绝不能被匿名访问到（现在 `admin.html` 靠 nginx 404 挡着，运营台要同等或更强）。
- 分阶段：先做**只读**（订单/库存/销售看板）→ 再做**商品五步式发布**（草稿默认不公开）→ 最后做**发货与退款**（写操作，风险最高）。
- 五步式发布、默认草稿、复杂字段默认隐藏——这些都对，符合"少出错"的目标。

**关于店小秘 / 妙手**：同意 Codex 的判断。它们是**多平台 ERP**，用于同时经营 Amazon / Temu / TikTok Shop 时集中同步商品与订单；**不是**独立站的核心数据库。等真的多平台了再引入，不要现在换。

**关于店匠 / SHOPLINE**：同意**不切换**。会重新迁移站点/商品/订单/支付，并回到套餐月费 + 交易佣金 + 平台依赖，与自建品牌路线冲突。

---

## D. 收款通道

按 Codex 的决策执行，我补充操作纪律：

| # | 项 | 归属 |
| --- | --- | --- |
| D1 | 空中云汇作第一生产候选 | 店主 |
| D2 | PingPong 同步申请，作费率对照与备用通道 | 店主 |
| D3 | 两家都通过后，**只接一家到生产**，另一家保留 | 店主决定，Agent 接线 |
| D4 | **先沙盒测试，不开放真实扣款** | 共同 |

**操作纪律（重要）**

- 申请时如实填写：主体=个体工商户（**执照下证后再选**）；网站 `pawlivora.com`；业务=自营宠物用品独立站；首要市场=美国；发货地=中国大陆；客单价与预计月销售额按**冷启动真实低额**填。
- **不要**填写"已有大量订单""已有海外仓""已确定送达时效"，除非已经落实。
- American Express 是**卡组织/支付方式**，不是收款账户；等通道审核支持后再启用。
- **身份信息、银行卡、营业执照、短信验证码、最终协议一律由店主本人提交。**
- **不要把密码、验证码或完整证件发到聊天里。** 看不明白的字段可以截图（打码后）问我，我逐项判断。

---

## E. 仓库与合规

| # | 项 | 级别 | 结论 / 待办 |
| --- | --- | --- | --- |
| E1 | 公开 Git 历史含供应商成本字段（`costCNY`，AR-14） | P2 | **已决策：保持公开、不重写历史。** 泄露范围是历史提交里的采购成本，不是客户数据或凭据；`HEAD` 的 `catalog.json` 已干净，`check-security.mjs` 已把 `costCNY` 列为禁止字段。**不改私有**的另一个硬理由：主机 `git fetch` 是**匿名**的（无 credential helper、无 `/root/.git-credentials`），转私有会立刻打断发布链，需要额外部署 token。 |
| E2 | `main` 与工作分支分叉 | P1 | `main` 停留在旧状态，默认分支展示的代码不是真实状态；且 CI 只在 `main` 触发。**待店主决定**合并策略（把 `codex/pawshop-real-operations` 并入 `main`，或改用 `main` 为基线）。建议：**等商务后台激活跑通后再合并**，避免一次涌入过多变更。 |
| E3 | CI 不覆盖工作分支 | P2 | `.github/workflows/quality.yml` 只在 `main` 触发。 |
| E4 | 依赖 advisories（lodash 等） | P2 | 追踪上游补丁；开放任意公网 Store API 前重新评估。 |

---

## F. 建议的操作顺序（不要跳步）

1. **店主批准推送**（A0）← **唯一的 P0 阻塞，一句话即可**
2. **店主确定后台暴露方式 B2**（建议方案 b，也是一句话）
3. Agent：**激活商务后台**（B1 全链，RUNBOOK §11）→ 此时 A2/A3/A5 一并解锁：回填 commerce 检查、启用备份定时器、删掉两行 skip
4. Agent：**首次加密备份 + 离线回读 + 隔离恢复演练**已在第 3 步内强制完成（A2 收尾）
5. 店主：激活后设置**后台账号**（需要你本人设密码/确认邮箱，我会给交互命令）
6. Agent：**中文运营台**（C），从只读看板起步
7. Agent + 店主：**收款通道沙盒接入**（D）；店主先申请，通过后再考虑真实扣款
8. 视情况合并 `main`（E2）；店主有空时删掉临时 RAM 用户（A6）

每一步之后都跑一遍全量回归：根 `check` + `build`、commerce 测试/类型/构建、真实浏览器检查、`verify:production` 与 `verify:production:strict`、监控实测、告警端到端。
