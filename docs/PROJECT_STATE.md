# PawShop 项目状态（WorkBuddy 接管勘察）

- 勘察日期：2026-09-16
- 勘察者：WorkBuddy（接替 Codex 的工程推进阶段）
- BASE_COMMIT（接管前）：`366cc0e3656eb2259e9f4e4002452f142d20a147`
- WIP 保全提交：`13616a9`（Codex 未提交的分层异地备份收尾工作，已固化为独立提交供审计）
- 审计范围：`git diff 366cc0e...HEAD`

状态词汇：`DONE`（实现+构建+运行+关键路径测试四重证据）、`UNVERIFIED`（存在但无运行证据）、`BLOCKED`（被外部条件阻塞）、`RISK`（存在已识别风险）、`TODO`（待做）。

## 1. 技术架构（按代码实际检测）

| 层 | 实际技术 | 状态 |
| --- | --- | --- |
| 公开前端 | 静态 HTML（PawShop.html / product.html 等 8 页）+ 原生 JS + Tailwind CSS 3.4（构建产物） | DONE（本地）；线上展示站 DONE |
| 前端渲染方式 | 无框架 SPA/SSR，纯静态 + 客户端 catalog.json 渲染 | DONE |
| 后端 | `_commerce/` Medusa.js 2.19.0（Node 22，TypeScript） | DONE（本地）；生产未激活 |
| 包管理 | npm（根目录与 `_commerce/` 各自独立 package.json + lockfile） | DONE |
| 数据库 | PostgreSQL 17（本地 127.0.0.1:54329；生产 127.0.0.1:5432 已安装未迁移） | DONE（本地）；生产 UNVERIFIED |
| ORM/迁移 | Medusa 内置 MikroORM 迁移（`db:migrate`，生产需 `PAWSHOP_MIGRATIONS_CONFIRMED=1`） | DONE（本地）；生产 UNVERIFIED |
| 认证 | Medusa Admin JWT + Cookie Secret；本地 admin-only 模式；Store/Customer API 无条件 503 门禁 | DONE（本地） |
| 对象存储 | 阿里云 OSS（S3 兼容）：`pawlivora-products-us-west-1`（商品图）、`pawlivora-backups-us-west-1`（加密备份，已开版本控制） | RISK（桶已建；备份 RAM 用户/AccessKey 未创建，生命周期规则未提交） |
| 邮件 / 支付 / AI / 搜索 / 分析 | 代码中不存在 | 不适用（未虚构） |
| 缓存/队列/事件 | Redis（生产注册 caching/event-bus/workflow/locking Redis 模块；本地开发用内存实现） | DONE（代码+构建）；生产 UNVERIFIED |
| Cron | systemd timer：每日备份 + 月度/年度归档（WIP 保全） | DONE（代码+测试）；生产 UNVERIFIED（未安装） |
| 托管 | 公开展示站：阿里云美国（硅谷）SWAS 2GB + Nginx + `ops/deploy-static.sh` 原子发布；GitHub Pages 发布 `main`（`_config.yml`，排除 `_commerce/`） | 展示站 DONE（verify:production 通过）；commerce UNVERIFIED |
| Docker | 未使用（明确选择原生 Ubuntu systemd 方案） | 不适用 |
| CI/CD | `.github/workflows/quality.yml`（PR/push main：根目录 build+check，_commerce test+typecheck+build:ci） | DONE（本地全绿复现；线上 CI 运行记录未在本机核对） |

## 2. 用户路径（逆向自代码真实功能）

```
访客
 ↓ https://pawlivora.com（HTTPS 强制重定向，verify:production 已验证）
主页 PawShop.html（商品展示，catalog.json 驱动，1 个活跃商品）
 ↓
商品详情 product.html（9 张自托管图片，USD 29.90，prelaunch 状态）
 ↓
注册/登录/购物车/下单/支付 —— 全部刻意关闭（README + check:security 门禁）
 ↓
（无公开用户功能；account/admin/dashboard 页面线上 404）
 ↓
后台：Medusa Admin（仅限本地/SSH 隧道，127.0.0.1:9000/app）
 ↓
PostgreSQL 17（本地 pawshop_dev；生产库未创建）
 ↓
OSS：商品图桶（已投入使用）+ 备份桶（已建，未产生生产备份）
```

真实业务边界：**当前是"不可交易的商品展示站 + 本地 admin-only 电商地基"**。不存在购物车、结账、支付回调、订单、库存一致性等模块，因此未对其进行虚构测试。

## 3. 模块状态总表

| 模块 | 状态 | 证据 |
| --- | --- | --- |
| 根目录 install | DONE | `npm ci` exit 0（2026-09-16） |
| 根目录 build | DONE | `npm run build` exit 0 |
| 根目录 lint/security | DONE | `npm run check` exit 0（check:security + html-validate + 14/14 测试） |
| commerce install | DONE | `npm --prefix _commerce npm ci` exit 0 |
| commerce test | DONE | 62/62 pass（含 WIP 保全的分层备份测试） |
| commerce typecheck | DONE | `tsc --noEmit` exit 0 |
| commerce production build | DONE | `medusa build` exit 0（backend 3.88s + frontend 12.19s） |
| commerce 本地运行 | DONE | dev server health 200；foundation:verify 通过；独立 curl：/app 200、/admin/* 401、/store/* 拒绝 |
| catalog:verify | **RISK** | 失败："Product must remain unpublished" —— 商品于 2026-09-08 21:11（接管前）被置为 published。其余契约满足：9 图、无销售渠道关联、reviewed_for_sale=false、0 客户、0 订单。待店主确认后一条 UPDATE 或后台切回 Draft |
| 本地备份 | DONE | `backup:real` exit 0，AES-256 加密 + SHA-256 + HMAC manifest |
| 本地恢复演练 | DONE | `restore:verify-real` exit 0，隔离库恢复 + 关键数据哈希校验 + 临时库自动清理（`pawshop_restore_%` 残留数 = 0） |
| 生产部署（展示站） | DONE | `verify:production` exit 0（HTTPS 重定向、安全头、活跃目录、退役页 404） |
| 生产部署（commerce） | UNVERIFIED | 服务器已 bootstrap（PG/Redis/Node 就绪），但 Medusa 未激活、未迁移、未验收 |
| 异地备份（OSS） | UNVERIFIED | 代码+测试 DONE；RAM 用户/AccessKey 未创建，真实上传/回读证据不存在 |
| OSS 生命周期规则 | TODO | 三条前缀规则（daily/monthly/yearly）尚未提交到桶 |
| 生产监控 | TODO | 无 uptime monitoring / error tracking 实现 |
| 回滚 | DONE（脚本）/ UNVERIFIED（生产演练） | `rollback-commerce.sh`：root-only、完整 SHA、DB 兼容门禁、原子符号链接切换、flock；未在生产演练 |
| 依赖安全 | RISK | 根目录 prod 0 漏洞；`_commerce` prod 77 个（10 moderate + 67 high，主因 lodash 传递链），修复需升级 @medusajs/medusa 2.19.0→2.21.0，超出锁定范围，需店主决策 |

## 4. Git 现场记录（接管时）

- 分支：`codex/pawshop-real-operations`（与 origin 同步，无未推送提交）
- 无 tag、无 stash
- 未提交修改：12 个文件（分层备份保留功能）+ 6 个未跟踪文件 → 已固化为保全提交 `13616a9`
- 其他分支：`main`、`codex/pawshop-mobile-preview-fix`、`codex/pawshop-secure-foundation`、`codex/pawshop-selfhost-foundation`
- 远程：`https://github.com/wesley9311/pawshop.git`

## 5. 主要风险与下一步

1. **RISK-P1**：本地 DB 商品发布状态违反契约（见上表）。
2. **RISK-P1**：`_commerce` 生产依赖 77 个已知漏洞（lodash 链为主）；Medusa 2.21.0 升级需完整回归。
3. **TODO-P1**：生产监控（uptime、错误跟踪、5xx/延迟告警）完全缺失。
4. **UNVERIFIED**：生产 commerce 激活链（迁移→首备份→隔离恢复→验收）未执行，需店主在场按 `_commerce/OPERATIONS_ZH.md` 执行。
5. **UNVERIFIED**：异地备份需先创建最小权限 RAM 用户并提交三条生命周期规则。

详细操作入口见 `docs/RUNBOOK.md`；上线门禁见 `docs/RELEASE_GATES.md`。
