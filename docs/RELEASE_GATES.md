# PawShop 发布门禁（Release Gates）

更新：2026-09-16。原则：**没有执行证据不得 PASS**。所有命令在接管工作区内实际运行过并记录 exit code。

## 当前门禁结论

| 门禁 | 结论 | 证据 |
| --- | --- | --- |
| BUILD | **PASS** | 根 `npm run build` exit 0；`_commerce` `medusa build` exit 0（backend 3.88s / frontend 12.19s，2026-09-16） |
| TYPECHECK | **PASS** | `_commerce` `tsc --noEmit` exit 0 |
| TEST | **PASS** | 根 14/14；`_commerce` 62/62（node --test） |
| CORE_FLOW | **PASS（本地）** | dev server health 200；foundation:verify 通过；独立 curl：`/app`=200、`/admin/products`=401、`/admin/users/me`=401、`/store/products`=拒绝。线上展示站 `verify:production` exit 0（HTTPS 重定向+安全头+活跃目录+退役页 404）。注：`catalog:verify` 因接管前数据漂移失败，见 RISK-1 |
| MOBILE | **UNVERIFIED** | 存在历史分支 `codex/pawshop-mobile-preview-fix`；本轮未做跨浏览器/移动端布局验证（无浏览器自动化证据） |
| SECURITY | **PASS（静态部分）** | check:security 通过；git grep 密钥模式零命中；.env.example 全占位符；CSP 存在。生产渗透面（TLS 配置、Cookie flags 实测、Rate limit）= UNVERIFIED。依赖漏洞：`_commerce` prod 77 个（见 RISK-2） |
| PRODUCTION_ENV | **PASS（静态站）/ UNVERIFIED（commerce）** | 展示站生产验证通过；commerce 生产 env 未安装（`/etc/pawshop/commerce.env` 不存在），激活链未执行 |
| DATABASE | **PASS（本地）/ UNVERIFIED（生产）** | 本地 PG 17 运行中、迁移已应用、62 测试通过；生产库未创建、首次迁移未执行 |
| BACKUP | **PASS（本地）/ UNVERIFIED（异地+生产）** | 本地 `backup:real` exit 0（AES-256 + manifest）；OSS 异地备份无真实凭据与上传证据；生产每日备份 timer 未安装 |
| RESTORE | **PASS（本地演练）** | `restore:verify-real` exit 0：隔离库恢复、关键数据哈希校验、临时库清理确认（`pawshop_restore_%` 计数=0）。生产隔离恢复服务未演练 |
| ROLLBACK | **PASS（脚本级）/ UNVERIFIED（生产演练）** | 展示站：deploy-static.sh 内建失败回滚；commerce：rollback-commerce.sh 有 DB 兼容门禁+原子切换，但生产从未演练回滚 |
| MONITORING | **FAIL** | 无 uptime monitoring、无 error tracking、无 5xx/延迟/DB 连通告警。这是当前最大的上线运维缺口 |
| STAGING | **FAIL（不存在）** | 无 staging 环境；本地 dev 即最接近 production-like 的环境（回环 PG/Redis + admin-only 门禁） |
| PRODUCTION_DEPLOY | **PASS（展示站）/ FAIL（commerce）** | 展示站线上可用且验证通过；commerce 生产部署未发生（Medusa 未激活） |

## 风险登记

### RISK-1（P1，数据）：本地商品发布状态违反 catalog 契约
- 事实：`pawshop_dev.product` 中 `large-corrugated-cardboard-cat-lounger` 为 `published`（updated_at 2026-09-08 21:11，早于 WorkBuddy 接管）。
- 影响：`catalog:verify` 失败；因无销售渠道关联 + Store API 503 门禁，**无对外影响**。
- 修复（需店主确认）：后台切回 Draft 或 `UPDATE product SET status='draft' WHERE handle='large-corrugated-cardboard-cat-lounger';`（改前先 `backup:real`）。

### RISK-2（P1，依赖）：_commerce 生产依赖 77 个已知漏洞
- `npm audit --omit=dev`：10 moderate + 67 high（主因 lodash 传递链，via @medusajs/*）。
- 官方修复路径：升级 `@medusajs/medusa` 2.19.0 → 2.21.0（超出锁定范围）。
- 决策：不擅自升级框架（供应链审查是本项目明确原则）。建议店主安排专门的升级+全量回归轮次。

### RISK-3（P2，dev 依赖）：根目录 `qs` 1 个 moderate（http-server 链，仅本地 serve 使用）。

### RISK-4（P1，历史泄露）：公开 Git 历史含供应商成本字段
- 事实：`git log -S costCNY` 命中 8 个提交（含 catalog.json 的 3 个：`5eef94b`、`23202af`、`5efc128`）。当前工作树已由 `5eef94b` 清除并由 `check:security` 永久防护，但**历史提交仍在公开 GitHub 仓库可见**。
- 影响：供应商成本、供货链接等商业敏感信息对任何克隆者可见；不影响网站运行时安全。
- 修复选项（**均需店主决策**，Agent 不得自行重写历史）：将仓库转为私有；或经店主批准后使用 `git filter-repo` 重写历史并协调全部克隆方；或评估后接受该风险。


## 上线（开放交易）前必须完成的门禁

按 `LAUNCH_READINESS.md` 与代码内门禁，开放任何真实交易前需要：

1. 生产 commerce 激活链完成并留证（迁移→首加密备份→OSS 回读→隔离恢复→店主登录验收）。
2. Redis ACL 专用凭据门禁完成。
3. 备份 RAM 最小权限用户创建 + 三条 OSS 生命周期规则提交（只匹配各自前缀，禁止全桶 90 天规则）。
4. 监控与告警落地（uptime、5xx、错误聚合、备份失败告警）。
5. RISK-1 数据漂移处置。
6. 支付服务商沙箱测试（成功/失败/退款/webhook/对账）。
7. 物流、税务、退货地址、隐私条款、客服路由就绪。
8. Store/Customer API 开放需单独批准（当前无条件 503 是代码级门禁）。
