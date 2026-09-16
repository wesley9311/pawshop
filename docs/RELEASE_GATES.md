# PawShop 发布门禁（Release Gates）

更新：2026-09-16。原则：**没有执行证据不得 PASS**。所有命令在接管工作区内实际运行过并记录 exit code。

## 当前门禁结论

| 门禁 | 结论 | 证据 |
| --- | --- | --- |
| BUILD | **PASS** | 根 `npm run build` exit 0；`_commerce` `medusa build` exit 0（Medusa 2.21.0，backend 4.46s / frontend 13.22s，2026-09-16） |
| TYPECHECK | **PASS** | `_commerce` `tsc --noEmit` exit 0（2.21.0） |
| TEST | **PASS** | 根 14/14；`_commerce` **70/70**（62 原有 + 8 监控新增；node --test） |
| CORE_FLOW | **PASS（本地）** | dev server health 200；admin UI 200；未鉴权 admin 401；store 路由关闭；foundation:verify 与 catalog:verify 均通过。线上展示站 `verify:production` exit 0（HTTPS 重定向+安全头+catalog+退役页 404） |
| MOBILE | **UNVERIFIED** | 存在历史分支 `codex/pawshop-mobile-preview-fix`；本轮未做跨浏览器/移动端布局验证（无浏览器自动化证据） |
| SECURITY | **PASS（静态部分）** | check:security 通过；git grep 密钥模式零命中；.env.example 全占位符；CSP 存在；监控新增安全头与 TLS 到期检查。新发现线上缺 HSTS（RISK-5，待主机侧修复）。生产渗透面（Cookie flags 实测、Rate limit）= UNVERIFIED。依赖漏洞见 RISK-2 |
| PRODUCTION_ENV | **PASS（静态站）/ UNVERIFIED（commerce）** | 展示站生产验证通过；commerce 生产 env 未安装（`/etc/pawshop/commerce.env` 不存在），激活链未执行 |
| DATABASE | **PASS（本地）/ UNVERIFIED（生产）** | 本地 PG 17 运行中、迁移已应用、62 测试通过；生产库未创建、首次迁移未执行 |
| BACKUP | **PASS（本地）/ UNVERIFIED（异地+生产）** | 本地 `backup:real` exit 0（AES-256 + manifest）；OSS 异地备份无真实凭据与上传证据；生产每日备份 timer 未安装 |
| RESTORE | **PASS（本地演练）** | `restore:verify-real` exit 0：隔离库恢复、关键数据哈希校验、临时库清理确认（`pawshop_restore_%` 计数=0）。生产隔离恢复服务未演练 |
| ROLLBACK | **PASS（脚本级）/ UNVERIFIED（生产演练）** | 展示站：deploy-static.sh 内建失败回滚；commerce：rollback-commerce.sh 有 DB 兼容门禁+原子切换，但生产从未演练回滚 |
| MONITORING | **PASS** | `pawshop-monitor` 已实现并验证：12 项检查、8 项新单测通过、真实冒烟运行（对 https://pawlivora.com + 本地运行时，10/12 ok）。告警通道为可选 HTTPS webhook，未配置时 fail-closed 本地告警。剩余：定时器需在生产主机安装（需 root） |
| STAGING | **FAIL（不存在）** | 无 staging 环境；本地 dev 即最接近 production-like 的环境（回环 PG/Redis + admin-only 门禁） |
| PRODUCTION_DEPLOY | **PASS（展示站）/ FAIL（commerce）** | 展示站线上可用，`verify:production` exit 0；**新增 `verify:production:strict` 检出两项主机侧缺口（HSTS、www 规范化）**，修好后应转 PASS；commerce 生产部署未发生（Medusa 未激活） |

## 风险登记

### RISK-1（P1，数据）：本地商品发布状态违反 catalog 契约 —— **已闭环（2026-09-16）**
- 事实：`pawshop_dev.product` 中 `large-corrugated-cardboard-cat-lounger` 曾被置为 `published`（updated_at 2026-09-08 21:11，早于 WorkBuddy 接管）。
- 处置（经店主批准）：先执行 `backup:real` 生成加密备份 `pawshop_dev_20260916T054523011Z`，再以带条件的单条语句 `UPDATE ... WHERE handle=... AND status='published'` 精确命中 1 行切回 `draft`。
- 验证：`catalog:verify` 通过（exit 0）：一个未发布 SKU、九张图、USD 29.90。
- 结论：契约恢复，无残留影响。

### RISK-2（P1，依赖）：_commerce 生产依赖 73 个 advisories —— 单一 lodash 根因，**上游暂无修复**
- 事实（2026-09-16，升级 2.21.0 后实测）：`npm audit --omit=dev` 报 73 个（6 moderate / 67 high）；`--json` 显示是 **73 个不同包名**，但全部经 `@graphql-codegen/plugin-helpers` 扇出到同一个传递依赖 `lodash@4.17.23`。
- 关键判断：lodash 已是当前最新版本，两条 advisory（GHSA-r5fr-rjxr-66jc 代码注入、GHSA-f23m-r3pf-42rh 原型污染）**没有已修复版本**。因此"升级 Medusa 修漏洞"这条路径**不成立**。
- 已执行：Medusa 全家族升级 2.19.0 → 2.21.0（`f679161`），全量回归通过（70/70 测试、类型检查、构建、本地运行时、监控冒烟），但**漏洞计数未变**。
- **禁止操作**：`npm audit fix --force` 会把 `@medusajs/file-s3` 降到 `0.0.3`，属有害的破坏性变更，已明确排除。
- 风险面评估（非证明）：`_.template` 注入需要不可信输入进入模板；`_.unset/_.omit` 原型污染需要攻击者可控路径。当前部署为 admin-only、Store/Customer API 无条件关闭、服务仅回环监听、无公网 API 面，实际可利用性低。
- 处置建议：追踪 lodash 上游补丁；在开放任一公网 Store API 之前重新评估；其余为接受风险（需店主确认）。

### RISK-3（P2，dev 依赖）：根目录 `qs` 1 个 moderate（http-server 链，仅本地 serve 使用）。

### RISK-4（P1，历史泄露）：公开 Git 历史含供应商成本字段
- 事实：`git log -S costCNY` 命中 8 个提交（含 catalog.json 的 3 个：`5eef94b`、`23202af`、`5efc128`）。当前工作树已由 `5eef94b` 清除并由 `check:security` 永久防护，但**历史提交仍在公开 GitHub 仓库可见**。
- 影响：供应商成本、供货链接等商业敏感信息对任何克隆者可见；不影响网站运行时安全。
- 修复选项（**均需店主决策**，Agent 不得自行重写历史）：将仓库转为私有；或经店主批准后使用 `git filter-repo` 重写历史并协调全部克隆方；或评估后接受该风险。

### RISK-5（P1，安全头，**本轮新发现**）：线上缺 `Strict-Transport-Security`
- 证据：监控 `storefront_security_headers` 检查失败；独立 `curl -sI https://pawlivora.com/` 仅返回 `X-Content-Type-Options: nosniff` 与 `X-Frame-Options: DENY`，HSTS 命中数 0。
- 影响：浏览器不会强制后续访问使用 HTTPS，首次访问存在被降级劫持的窗口。当前站点不可交易、无登录，风险有限；但接入登录/结账前必须补齐。
- 修复：在生产主机 Nginx 的 HTTPS `server` 块加 `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`（见 `docs/RUNBOOK.md` §9），`nginx -t` 通过后 reload，再由监控确认转绿。仓库不管理 Nginx 配置，需主机侧 root 操作。


## 上线（开放交易）前必须完成的门禁

按 `LAUNCH_READINESS.md` 与代码内门禁，开放任何真实交易前需要：

1. 生产 commerce 激活链完成并留证（迁移→首加密备份→OSS 回读→隔离恢复→店主登录验收）。
2. Redis ACL 专用凭据门禁完成。
3. 备份 RAM 最小权限用户创建 + 三条 OSS 生命周期规则提交（只匹配各自前缀，禁止全桶 90 天规则）。
4. 监控与告警落地（uptime、5xx、错误聚合、备份失败告警）。实现已完成，**定时器与告警 webhook 需在生产主机安装配置**。
5. ~~RISK-1 数据漂移处置~~ —— **已于 2026-09-16 闭环**。
6. 处置 RISK-5（HSTS）与 RISK-8（www 规范化）——均为主机侧一行/一块配置，命令已备。
7. 决策 RISK-7（陈旧 Pages 镜像公开服务未验证的折扣声明）。
8. 支付服务商沙箱测试（成功/失败/退款/webhook/对账）。
9. 物流、税务、退货地址、隐私条款、客服路由就绪。
10. Store/Customer API 开放需单独批准（当前无条件 503 是代码级门禁）。
