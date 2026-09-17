# PawShop 发布门禁（Release Gates）

更新：2026-09-16（含第三轮对抗审查 + 生产主机侧 AR-6/AR-7 修复）。原则：**没有执行证据不得 PASS**。所有命令在接管工作区内实际运行过并记录 exit code。

## 当前门禁结论

| 门禁 | 结论 | 证据 |
| --- | --- | --- |
| BUILD | **PASS** | 根 `npm run build` exit 0；`_commerce` `medusa build` exit 0（Medusa 2.21.0，backend 4.46s / frontend 13.22s，2026-09-16） |
| TYPECHECK | **PASS** | `_commerce` `tsc --noEmit` exit 0（2.21.0） |
| TEST | **PASS** | 根 **20/20**；`_commerce` **75/75**（62 原有 + 13 监控；node --test，2026-09-17）。告警端到端 **15/15**（`npm run test:alert-delivery`） |
| CORE_FLOW | **PASS（本地）** | dev server health 200；admin UI 200；未鉴权 admin 401；store 路由关闭；foundation:verify 与 catalog:verify 均通过。线上展示站 `verify:production` exit 0 |
| MOBILE | **FAIL（部分）** | 本轮首次取得**真实浏览器执行证据**（无依赖 CDP + headless Chrome，11 页面：功能正确、0 CSP 违规、0 JS 错误、0 HTTP 404）。但**跨浏览器（Safari/Edge）与移动视口仍无证据**，故不 PASS |
| SECURITY | **PASS** | check:security 通过（**CSP 现覆盖全部 10 个页面**并由回归强制）；git 密钥模式零命中；.env.example 全占位符；**生产 HSTS 已补齐（AR-6）**；`www`→apex 已规范化（AR-7）。生产渗透面（Cookie flags 实测、Rate limit）= UNVERIFIED。依赖漏洞见 RISK-2/AR-15 |
| PRODUCTION_ENV | **PASS（静态站）/ UNVERIFIED（commerce）** | 展示站生产验证通过；commerce **生产 env 已存在**（`/etc/pawshop/commerce.env` 在主机上，非"不存在"——⚙️ 2026-09-17 纠正），但商务 release 未激活，激活链未执行 |
| DATABASE | **PASS（本地）/ UNVERIFIED（生产）** | 本地 PG 17 运行中、迁移已应用、测试通过。⚙️ **纠正（2026-09-17 实测）**：生产库 `pawshop` **已存在**（而非"未创建"），但 **public schema 下 0 张表** —— 即"库在、迁移没跑"。首次迁移被 release 前置卡住（需已推送的提交），未执行 |
| BACKUP | **PASS（本地）/ READY（生产，待 release）** | 本地 `backup:real` exit 0（AES-256 + manifest）。**2026-09-17：备份链四处阻塞全部清除**——① 首次备份流程用 release 自身目录（不需要 `current`）；② `backup-offsite.env` 完成且**两个闸门已打开**；③ 备份凭据 **`pawshop-backup-writer` 已建并与策略 `/pawshop-backup-writer-policy` 授权，密钥恰好一把、写在 `root:root 0600` 文件、只经 `LoadCredential` 读取**；④ 单元依赖已改为真实的 `postgresql@17-main.service`。**两个闸门是实测事实**：版本控制用**功能性证明**（用该凭据覆盖上传后旧版本仍可按精确版本号读回，2026-09-17 生产桶实跑）；用该凭据发 `DeleteObject → 403 AccessDenied`（且连 `?versioning` / `?lifecycle` 都读不到）。凭据自检 **7/7 通过**（`ops/commerce/verify-offsite-credential.mjs`）。⚠️ **2026-09-17 修正**：运行时**不再读桶级 versioning 状态**——该身份被刻意拒绝一切桶级操作，原 `GetBucketVersioning` 前置检查永远不可能通过（首次备份实测暴露）；已改为对象级证明：每次上传必须拿到版本号，且每个远端对象按精确版本号回读/校验。OSS 生命周期 **4 条规则已写入并回读核对**（daily 90 / monthly 365 / yearly 1095，与代码常量一致）。**剩余**：首次加密备份 + 离线回读 + 隔离恢复演练尚未执行，因为它要求一个**已推送**的 release 提交（`21454c0` 已推送；offsite 对象级版本证明修复后需再推一次并重建 release）；该步通过后才允许激活商务并启用 `pawshop-backup.timer` |
| RESTORE | **PASS（本地演练）** | `restore:verify-real` exit 0：隔离库恢复、关键数据哈希校验、临时库清理确认（`pawshop_restore_%` 计数=0）。生产隔离恢复服务未演练 |
| ROLLBACK | **PASS（脚本级）/ UNVERIFIED（生产演练）** | 展示站：deploy-static.sh 内建失败回滚；commerce：rollback-commerce.sh 有 DB 兼容门禁+原子切换，但生产从未演练回滚 |
| MONITORING | **PASS** | `pawshop-monitor.timer` 于 2026-09-16 在生产安装并启用（enabled+active，每 5 分钟；实测 12/12，状态文件正常）；单元从 `/usr/local/libexec/pawshop` 运行以摆脱对商务激活的依赖（RUNBOOK §9.1）。**2026-09-17：告警通道已真实接入并实测送达** —— **飞书 + Slack 双通道**（`PAWSHOP_MONITOR_ALERT_CHANNELS`），任一条被对方确认即算送达、部分失败会在日志点名、全部失败才 `exit 2`；新脚本已装到主机（`root:root 0555`，装前后各跑一次 12/12 无回归）。**真实投递验证：告警与恢复各一条、四条全部送达**（店主在群里可见）。**实测发现并修掉一个只有真发消息才会暴露的缺陷**：飞书自定义关键词过滤是 `[PawShop 告警]`，而恢复通知原以 `[PawShop 恢复]` 开头 → 飞书返回 **HTTP 200 + `code:19024`**，会造成"告警永远送到、恢复永远送不到"的最坏不对称；现所有消息共用同一信封前缀，并有断言锁死（RUNBOOK §9.3）。单测 13/13、端到端 **15/15**。**剩余：commerce 与备份新鲜度两项检查为临时显式跳过，须在商务激活后删除（RUNBOOK §9.2）** |
| STAGING | **FAIL（不存在）** | 无 staging 环境；本地 dev 即最接近 production-like 的环境（回环 PG/Redis + admin-only 门禁） |
| PRODUCTION_DEPLOY | **PASS（展示站）/ FAIL（commerce）** | 展示站线上可用，`verify:production` exit 0；**`verify:production:strict` 亦 PASS**（HSTS max-age 15552000s；www→apex 301）——两项主机侧缺口已于 2026-09-16 修复；**当前线上 release `6dce5a4`**（含 sitemap 与隐私声明修订；原子切换 + 边界探测通过；`a74aab3`、`012666fc…` 等 7 个 release 保留可回滚），线上真实浏览器 0 CSP 违规；commerce 生产部署未发生（Medusa 未激活，`/srv/pawshop-commerce/current` 不存在） |

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

### RISK-5（P1，安全头）：线上缺 `Strict-Transport-Security` —— **已闭环（2026-09-16）**
- 证据（修复前）：监控 `storefront_security_headers` 检查失败；独立 `curl -sI https://pawlivora.com/` 仅返回 `X-Content-Type-Options: nosniff` 与 `X-Frame-Options: DENY`，HSTS 命中数 0。
- 影响：浏览器不会强制后续访问使用 HTTPS，首次访问存在被降级劫持的窗口。
- **处置**：已在生产主机 `/etc/nginx/sites-available/pawshop` 的 HTTPS `server` 块内加入 `add_header Strict-Transport-Security "max-age=15552000" always;`；改动前 `cp -a` 备份至 `/root/pawshop-nginx-pawshop.bak-20260916T070651Z`，`nginx -t` 通过后 `systemctl reload nginx`。
- 取值说明：采用 **180 天且不含 `includeSubDomains`**（比先前建议的 31536000+includeSubDomains 更保守）。HSTS 被浏览器缓存后，在 `max-age` 到期前无法由服务端撤销；待确认全部子域均为 HTTPS 后再升级。详见 `docs/RUNBOOK.md` §10.1。
- 验证：`verify:production:strict` → **PASS**（`HSTS max-age 15552000s`）；既有两个安全头仍在。

### RISK-6（P1，合规）：`privacy.html` 曾谎称使用第三方 CDN —— **已修复（第三轮）**
- 事实：实际为自管主机 nginx + 同源资源，隐私声明却写"由第三方 CDN 托管"，属事实性错误。
- 处置：改为可核实的准确表述（自管主机 + 同源资源），并如实披露 GitHub Pages 镜像面（含 `i.ibb.co`）。详见 `docs/ADVERSARIAL_REVIEW.md` AR-2。
- 状态：**已修复并已上线**（随展示站 release `a74aab3` 于 2026-09-16 发布）；线上 `privacy.html` 实测已为准确表述。

### RISK-7（P1，第二公开面）：陈旧 GitHub Pages 镜像 —— **已闭环（2026-09-16）**
- 事实（修复前）：`wesley9311.github.io/pawshop/` 由 `origin/main` 自动发布，其 `catalog.json` 仍是**已撤回**的旧数据（stock=100 / originalPrice=39.9），与线上 `catalog.json`（price 29.9 / availability prelaunch / 无 stock 字段）**直接矛盾**。
- **处置：已停用该仓库的 GitHub Pages**。实测镜像 URL 返回 **404**；仓库本体**仍为 PUBLIC**（保持公开，符合"非必要不转私有"的判断）。
- 同时修订 `privacy.html`：删去"另有 GitHub Pages 预览镜像、可能加载第三方图片站"一句（已不成立），隐私声明现在只剩"自管主机 + 同源资源 + 无第三方 CDN"这一条准确表述。
- **回滚**：`gh api -X POST repos/wesley9311/pawshop/pages -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/'`（注意 `main` 仍是旧状态，重新启用会立刻恢复陈旧内容，故合流 RISK-9 前不建议重开）。
- 备注：无凭据泄露（`admin.html` 为无害占位页，敏感模式命中 0）。

### RISK-8（P1，规范主机/重复内容）：`www` 未规范化到 apex —— **已闭环（2026-09-16）**
- 证据（修复前）：`https://www.pawlivora.com/` 返回 200 且与 apex 内容 MD5 完全一致（`29aaa54a…`）。
- **处置**：在 HTTPS 内容 `server` 块内加 server 级 `if ($host = www.pawlivora.com) { return 301 https://pawlivora.com$request_uri; }`。证书 SAN 已覆盖 `www`（Let's Encrypt，至 2026-12-06，自动续期），故跳转不中断 TLS。
- 验证：`https://www.pawlivora.com/` → `301 Location: https://pawlivora.com/`；apex 仍 200；`/admin.html` 经 www 访问仍最终 404（门禁未被绕过）。
- 已知小瑕疵（已接受）：`http://www` 需两跳（80 端口块为 certbot 托管行，未改动）。HTTPS 侧为单跳。详见 `docs/RUNBOOK.md` §10.2。

### RISK-9（P1，分支一致性）：工作分支与 `main` 已分叉
- 事实：`codex/pawshop-real-operations` 领先 `origin/main`，`main` 侧不是最新真实状态（含 GitHub Pages 镜像因此陈旧，见 RISK-7）。
- 处置：由店主决定合流策略；合流时应同时解决 RISK-7。

### RISK-10（P2，CI 覆盖）：CI 不覆盖工作分支
- 事实：`.github/workflows/quality.yml` 仅在 `main` 触发，工作分支的推送不会触发云端校验（本地已全量复现通过）。
- 处置：合流后自然覆盖；如需保护工作分支可扩展触发条件。

### RISK-11（P2，SEO 基础）：缺 `sitemap.xml` —— **已闭环（2026-09-16）**
- **处置**：新增 `sitemap.xml`（apex 上 7 个已发布页面），`robots.txt` 增加 `Sitemap:` 行，并把 `sitemap.xml` 加入 `ops/deploy-static.sh` 的 `public_paths`。线上实测 **200、XML 合法、7 条 URL**，随 release `6dce5a4` 上线。
- **`canonical` 有意未加**：RISK-8 完成后 `www` 已 301 到 apex，RISK-7 的镜像也已停用，"同一内容多个主机名"的问题面已消失，`canonical` 成为冗余。若将来重新引入任何第二主机名或镜像，再补。
- `/` 仍保持 200 + 客户端跳转：`scripts/production-probe.mjs` 断言 `/` 必须返回 **200**，故不能用 `return 301` 把 `/` 重定向走（见 `docs/RUNBOOK.md` §10.3）。

## 上线（开放交易）前必须完成的门禁

按 `LAUNCH_READINESS.md` 与代码内门禁，开放任何真实交易前需要：

1. 生产 commerce 激活链完成并留证（迁移→首加密备份→OSS 回读→隔离恢复→店主登录验收）。
2. Redis ACL 专用凭据门禁完成。
3. 备份 RAM 最小权限用户创建 + 三条 OSS 生命周期规则提交（只匹配各自前缀，禁止全桶 90 天规则）。
4. 监控与告警落地。**定时器已于 2026-09-16 安装并运行**（实测 12/12）；**告警 webhook 仍未配置**——当前 log-only，失败不会通知任何人，需店主提供 HTTPS webhook 后接入并做一次真实投递验证。**备份失败告警目前无法生效**，因为备份链本身未启用（四处硬阻塞见 `docs/REMAINING_WORK.md` A2）。
5. ~~RISK-1 数据漂移处置~~ —— **已于 2026-09-16 闭环**。
6. ~~RISK-5（HSTS）与 RISK-8（www 规范化）处置~~ —— **均已于 2026-09-16 在生产主机执行并验证**；`verify:production:strict` 由 FAIL 转 PASS。
7. ~~RISK-6（隐私声明事实性错误）~~ —— **已修复并已上线**（随 release `a74aab3` 发布）。
8. ~~RISK-7（陈旧 Pages 镜像公开服务已撤回声明）~~ —— **已停用该镜像（2026-09-16）**，镜像返回 404。RISK-9（分支合流）**仍待店主决策**。
9. 支付服务商沙箱测试（成功/失败/退款/webhook/对账）。
10. 物流、税务、退货地址、隐私条款、客服路由就绪。
11. Store/Customer API 开放需单独批准（当前无条件 503 是代码级门禁）。
