# MY ORDERS / ACCOUNT EXPERIENCE — PHASE 1 只读审计报告

> 结论：**当前 customer auth 不足**，按任务约定「先只读审计并报告缺口，不擅自重构 auth」，
> 本轮不做任何代码改动、不提交、不部署。以下为完整审计事实与缺口清单。

## 1. 现状：customer auth 不存在，订单是纯 guest 形态

审计方法：仓库源码只读 + 生产库只读查询（`sudo -u pawshop psql -d pawshop`）。

| 事实 | 证据 |
|---|---|
| 前台无任何登录/session/账户 UI | `PawShop.html`、`store-api.js`、`config.js`、`account.html` 全量 grep 无 `/auth/`、`/customers`、`login`、`session` 调用；`account.html` 是静态占位「Orders not open yet」 |
| 订单查询是 guest 双因子 | `_commerce/src/api/store/pawshop-orders/lookup/route.ts`：`order_number + email` 双因子匹配，无 session、无 customer 授权 |
| 服务端 auth 模块只服务于 admin | `production-modules.cjs` 注册 `@medusajs/medusa/auth`（emailpass + 可选 google），但 nginx 层 `/auth/user/*` 全部叠 Basic Auth（`pawshop-admin.htpasswd`），是运营台登录，不是顾客登录 |
| 订单全部挂在 guest customer 上 | 生产库：`order` 表 23 行、`customer_id` 23/23 非空；`customer` 表 13 行，**`has_account=false` 13/13** |
| 无任何 customer auth identity | `auth_identity` 仅 2 行，`app_metadata.user_id` **都指向同一个** `user_01M2Q720G75E4DC1BY360593H2`（店主账号），即 admin 的 emailpass + google 两条身份；**顾客侧 0 条** |

## 2. 关键结论：customer auth 的三块地基全部缺失

要做「已登录用户查看自己的订单列表」，缺的不是一个接口，而是整套身份体系，三者都还没建：

1. **顾客登录/注册入口与 session**：没有 `/auth/customer/emailpass` 的顾客侧调用，没有注册页、登录页、会话管理，没有「把 guest 订单认领到账户」的机制。
2. **customer → auth_identity 绑定**：13 个 customer 全是 `has_account=false` 的 guest 快照（结账时按 email 自动 upsert 出的），没有一个有密码/身份；要「登录后看订单」必须先让顾客能注册并把已有订单的 email 关联到 auth identity。
3. **按已认证 customer 过滤订单的授权接口**：现在唯一的订单读接口是 guest lookup（email 双因子），没有「用 session 里的 authenticated customer 过滤 `order.customer_id`」的端点。

> 安全红线上任务要求「服务端按已认证 customer/session 过滤，不接受前端传 customer_id」——
> 这个语义在「没有顾客 session」的前提下根本无法落地，因为它依赖第 2 块地基。

## 3. 缺口清单（若要实现 Phase 1，需先补齐这些，均属 auth 重构范畴）

- [ ] 顾客注册/登录（emailpass）端点 + 前台 UI（登录/注册/登出/「我的订单」入口）
- [ ] customer `has_account` 置真 + auth_identity 绑定（含把既有 guest 订单 email 认领到新账户的迁移策略）
- [ ] 服务端 `GET /store/customers/me/orders`（或等价）端点：从 session 解析 authenticated customer，`WHERE customer_id = :authenticated`，前端零 customer_id 入参
- [ ] session cookie 跨域/同源策略、CSRF、登录限速（nginx 层现有限速只覆盖 `/auth/user` 与 admin，未覆盖 customer）
- [ ] 订单历史快照策略确认（任务已明确：继续用订单快照、不跟随商品翻译改写——现有 lookup 已是快照语义，可复用）

## 4. 已具备、可复用的基础（好消息）

- **订单快照语义已达标**：`lookup` 返回的 `items.title/quantity/unit_price/total` 是下单时的快照，不跟随当前商品翻译（Phase 2 本地化只在 catalog 层，不进 order 快照）。做 My Orders 时直接复用同一快照序列化。
- **公共订单号** `PS-YYYYMMDD-NNNN`（`buildPublicOrderNumber`）已在 lookup 下发，My Orders 列表可直接沿用。
- **payment/fulfillment status 计算**已走 Medusa 官方 `getOrderDetailWorkflow`，My Orders 列表若要精简字段可复用同一来源。
- **en/zh i18n 体系**（`I18N` + `t()`）与 **order detail 渲染**（`renderOrderDetail`）已存在，列表点进去复用即可。
- **guest lookup 与 anti-enumeration 模式**（统一 404）可作为 My Orders 授权接口的错误语义范本。

## 5. 建议的下一步（供 Owner 决策，未执行）

Phase 1 若要做「已登录看自己订单」，实际等价于**引入 customer auth**，这是任务明确列为「不足时只报告、不擅自重构」的部分。建议二选一：

- **A（推荐，符合本轮范围）**：本轮停在审计报告。My Orders 作为独立后续阶段立项，先补「顾客注册/登录 + guest 订单认领」这层 auth 地基，再做列表页。
- **B（若 Owner 坚持本轮就要可回看的轻账户）**：需要 Owner 明确授权「新建 customer auth」这一超出「复用现有 session」的重构动作，并确认 guest 订单认领策略后，再单独排期实现。

## 6. 未改动 / 未执行清单

- 未改任何代码、未提交、未 push、未部署。
- 未碰 PayPal / fulfillment / notification / auth / order lifecycle / CloudGull。
- 未创建第二套账户系统。
- 未自行标注 OWNER VERIFIED。
