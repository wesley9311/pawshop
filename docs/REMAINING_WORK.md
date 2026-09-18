# PawShop 未完成清单与操作顺序

更新：2026-09-19（WorkBuddy 第十轮）
配套阅读：`docs/OWNER_ACTIONS_ZH.md`（**需要店主本人出面的项：链接、点击步骤、交付方式**）、`PRODUCTION_HANDOFF_ZH.md`（路径与排错总索引）、`docs/RUNBOOK.md`（可执行命令）、`docs/ADVERSARIAL_REVIEW.md`（对抗审查发现）。

图例：**P0** 阻塞上线 / **P1** 上线前应完成 / **P2** 可延后。**归属** 指谁能做：
**Agent** = 可自主执行并验证；**店主** = 必须本人（身份、协议、账号归属、付款）；**共同** = Agent 执行、店主在场确认。

---

## 0. 当前没有阻塞项；关键路径交回店主

**2026-09-18 结项**：`aaa5673` 已推送 → 主机取码 → 构建 → **升级迁移（不清库）** → 迁移后加密备份 + 离线回读 + 隔离恢复演练 → 合闸 → 激活 → 验收，全部完成。**商务后台的工程侧到这里已经通了**，生产库里店主账号与数据都还在。

**接下来不再是"我卡住了"，而是只有店主本人能做的那几件事**（链接、点击步骤、交付方式见 `docs/OWNER_ACTIONS_ZH.md`）：

1. ~~**QQ 邮箱 SMTP 授权码**~~ → **✅ 2026-09-18 14:59 结项**：授权码按"先真发一封自检邮件、对方接受了才写入"的顺序装到 `/etc/pawshop/email-credentials.json`（`root:pawshop 0640`、非符号链接，凭据指纹 `4007df34874c` 与店主文件逐字节一致），随后服务日志确认 `the subscriber handed the message to the relay for 504533680@qq.com`——"忘记密码"真的会发信了。**这一条 2026-09-18 16:47 实测复核**：文件在（`f3c0a9a82608`，键集合恰为 `from,host,password,port,secure,user`，130 B，mtime `14:59:51`）。
2. ~~**重新生成 Slack Incoming Webhook URL**~~ → **✅ 2026-09-18 结项（店主选择摘除）**：那条地址在 Slack 侧已被撤销，店主选择**不重建、直接摘掉**。已从 `monitoring.env` 摘除（**只改 1 行**，飞书那行逐字节未动，属主/权限保持 `root:pawshop 0640`，备份 `/root/pawshop-monitor.env.bak-20260918T082109Z`），改完复跑真实投递验证：告警与恢复各一条**均 `feishu accepted the payload`**，巡检 `12/12`、0 跳过行。当前告警走**飞书单通道**；将来想恢复双通道，见 `docs/OWNER_ACTIONS_ZH.md` §1.6。
3. ~~**删掉接管期遗留的 RAM 用户 `pawshop-agent-temp`**（需控制台手工删）~~ → **✅ 2026-09-18 结项**：店主已在控制台删除（属记账性质，见 A4）。
4. **Airwallex / PingPong 收款申请**（§D）—— 只在你手上，与工程侧解耦。
5. **`~/Downloads/AccessKey.csv`**（1 分钟）：确认无用后删掉（§A9）。**这是唯一一件"可做可不做"的技术小事。**

**我这一侧唯一未落地的动作**：~~无~~ → **✅ 2026-09-18 17:05 全部推送完毕**（`b2a723d..5778dbd`：`a1b4931` 凭据轮换记录 + `5778dbd` 过期文档修正），本地已无未推送提交。推送踩的坑：**店主真实代理端口是 `7897`（clash-verge 混合口），仓库 `.git/config` 里那个 `7892` 已经死了** → `plain git push` 会卡住，必须 `-c http.proxy=http://127.0.0.1:7897` 覆盖（**不改店主配置**）。

---

## 0.1 下一轮计划（**2026-09-18 17:20 店主已选定**）

**店主的选择**：(1) 后台暴露走 **(b) 同源反向代理**（见 A6，含"白名单不可用"的修正）；(2) 下一轮先做 **发版侧三件小改动**（不是运营台）。

### 任务 A：发版侧三件小改动（**Agent 独立完成，店主不参与**）

一次发版打包走完，全部走已实跑的升级路径（**不清库**）。**代码已于 2026-09-19 本地完成（`120/120` 测试通过），未推送、未发版。**

| # | 改动 | 状态 | 落点与要点 |
| --- | --- | --- | --- |
| 1 | **备份密钥轮换（A7）** | ✅ **代码完成** | **钥匙环**落地：`backup-integrity.cjs`（`backupKeyFingerprint` / `manifestKeyTest` / `matchBackupKeyRing`）、`production-private-paths.cjs`（`readProductionBackupKeyRing`、退役钥目录/文件 stat 策略、`assembleBackupKeyRing`）、三个消费方接到环上（`sync-production-backups.mjs`、`archive-production-backup.mjs`、`production-backup-verification.cjs`）。**匹配语义是"查询"**（无匹配返回 `null`，由调用方保留各自那句更具体的报错）。**`backup-production.mjs` 仍只用实时钥写新 dump；恢复演练不改**——因为它钻取的永远是刚创建的那个集合（`latest.json` 由 `backup-production.mjs` 写），用实时钥就是对的。轮换步骤见 `RUNBOOK.md` §13.3。 |
| 2 | **备份新鲜度跨重启（A3）** | ✅ **代码完成** | `run-scheduled-backup.mjs` 在 dump 与异地同步**都成功后**写 `/var/lib/pawshop-backup/last-success.txt`（先 `.staged` 再 `rename`，显式 `chmod 0644`）；`pawshop-backup.service` 加 `StateDirectory=pawshop-backup`；监控改为**文件（年龄）+ systemd（最近一次结果）两个来源都要过**。未配置该项时行为与旧版逐字相同。见 `RUNBOOK.md` §9.4。 |
| 3 | 手册补记 | ✅ **完成** | `RUNBOOK.md` §13.3 换成可执行的轮换流程、新增 §9.4、§13.4 补四条纪律、§11.2 插入"先刷 libexec"这一步。 |
| 4 | **本轮新增的前置（重要）** | ⚠️ **发版时必做** | 本次改动了 **3 个 libexec 文件**（`backup-integrity.cjs`、`monitor-production.mjs`、`monitoring-policy.cjs`）→ 备份演练第 126-131 行与 `deploy-commerce.sh` 第 131-136 行都会 `cmp` 失败。**必须先按 `RUNBOOK.md` §11.2 新增的「1.5) 先刷新 libexec」把 4 个文件从候选 release 装进 libexec**（该步骤行为中性，提前装不会改变在跑的监控/备份行为）。 |
| 5 | **T2 上线顺序（反了会报假故障）** | ⚠️ **发版时必做** | 先发版 → 跑一次备份让时间戳文件出现 → **再**往 `/etc/pawshop-monitor/monitoring.env` 加 `PAWSHOP_MONITOR_BACKUP_TIMESTAMP_FILE=/var/lib/pawshop-backup/last-success.txt`。提前加会如实报"文件缺失"（fail-closed，非 bug）。 |

**验收标准**：本地 `npm run check`/`npm run check:types`/告警投递全绿（✅ 已达成）→ **推送（先问店主）** → 主机构建 release → **先刷 libexec** → **升级迁移（关系数/行数一行未少）** → 迁移后备份 + 异地回读 + 隔离恢复演练 → 合闸 → 激活 → 监控 `12/12` 无跳过行 → 加时间戳环境变量并复跑监控 → **再跑一次真实备份证明钥匙环生效** → 最后才执行钥匙轮换，并归档旧钥匙到 `retired-keys/`。

### 任务 B：后台暴露 (b)（**不依赖发版，可在任务 A 之后单独做**）

nginx 开 `/admin-api/` 反代 → `127.0.0.1:9000`；访问控制 = **Basic Auth（口令加盐哈希）+ Medusa 自身鉴权**；**IP 白名单不做**（理由见 §A6）。改 nginx 属独立单元，**不需要清库、不需要重新激活商务**。

### 任务 C：中文运营台（**产品决策，等店主再点头**）

分三步，风险递增：**只读看板**（订单/库存/销售）→ **商品上架**（草稿默认不公开）→ **发货与退款**。前提是任务 B 已通（否则浏览器调不到 Admin API）。见 C 节。

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
| A3 | ~~备份新鲜度缺少跨重启的可靠信号~~ → **✅ 2026-09-19 结项（代码完成，待发版）** | — | **Agent** | 已改为**双来源**：备份成功后自写 `/var/lib/pawshop-backup/last-success.txt`（跨重启存活）+ systemd `Result`（几分钟内报真失败），两者都要过。`pawshop-backup.service` 加 `StateDirectory=pawshop-backup` 提供可写目录。**未配置该文件时行为与旧版逐字相同**，老主机不受影响。见 `RUNBOOK.md` §9.4。**发版时注意上线顺序**（先有文件、再加环境变量）。 |
| A4 | ~~临时 RAM 用户 `pawshop-agent-temp` 残留~~ → **✅ 2026-09-18 结项** | — | **店主** | 店主已删除。它本来就已零权限（OSS 管理面/数据面与 RAM 全 403），删除只是身份名单卫生。**⚠️ 记账性质**：删除后我没有任何可控凭据可以独立回查（该身份按设计读不了 RAM 管理面，本机也没有 RAM 凭据），所以这条是"按店主操作记账"而非我的测量结果；下次类此操作应**先留一份受控凭据再删**。故事与顺序教训见 `docs/OWNER_ACTIONS_ZH.md` §2.3。 |
| A5 | 收款通道（Airwallex / PingPong） | P1 | **店主** | 需店主本人申请；与工程侧无耦合。 |
| A6 | ~~后台对店主的暴露方式未定~~ → **✅ 2026-09-18 17:20 店主已定：走 (b) 同源反向代理** | P1 | **共同（已定，待执行）** | nginx 在 `pawlivora.com` 下开 `/admin-api/` → `127.0.0.1:9000`。**⚠️ 方案要改一处**：店主选的是"叠加 IP 白名单"，但实测他的来源 IP 一天内出现过 4 个不同地址段（`61.149.161.174` / `115.171.229.55` / `223.160.130.117` / `223.160.131.33`），根因是**他现在走手机热点**（网关 `172.20.10.1`）→ **静态白名单会把他本人挡在门外**。因此访问控制改为：**nginx Basic Auth（口令加盐哈希存储）+ Medusa 自身鉴权**两道，**IP 白名单降级为可选开关**（他换固定宽带出口后再开）。详见 `docs/OWNER_ACTIONS_ZH.md` §6.1。**执行顺序：等发版侧三件小改动（A7/A3）走完之后做，因为它本身不依赖发版**。 |
| A7 | **备份加密密钥已进入对话记录 → 代码已就位，轮换待执行** | P1 | Agent（**轮换前问一句店主**） | `2026-09-18` 我读取备份凭证时，脱敏器对"单行文件带结尾换行"判断错误，把 `/etc/pawshop-backup/backup.key` 原文打印了出来。该密钥做 manifest/回执 HMAC，**同时是 dump 的 `openssl enc -aes-256-cbc -pbkdf2` 口令**。**为什么不能直接换**：`sync-production-backups.mjs` 会**遍历所有 manifest 逐个验签**，裸换当天就让每日备份+异地同步失败。**✅ 2026-09-19：钥匙环代码已完成并本地全绿**（`120/120`），因此"先发版 → 再轮换"这条路已经通了：退役钥落 `/etc/pawshop-backup/retired-keys/backup-<指纹>.key`（`root:pawshop-backup 0640`，目录 `0750` 且**服务不可写**），验签逐把试、匹配到哪把就用哪把解密 → **历史 dump 轮换后仍可验、可恢复**。**影响面**：单独持有该密钥无法利用，还需同时拿到一份加密 dump（需 OSS 凭据或主机权限，两者均**未泄露**）。**剩余动作**：随下次发版上线 → 执行 `RUNBOOK.md` §13.3 的轮换 → 归档旧钥 → 真跑一次备份验收。 |
| A8 | ~~`sshd` 多开公网 22222 端口 + `Match User admin` 块~~ → **🟢 2026-09-18 17:05 查清：建议保持原样，无需任何动作** | — | **Agent** | **更正前一版"主机上手工加的无文档配置"的说法**：`Port 22222` 是**服务器开通当天的平台初始配置**（`Server listening on :: port 22222` 最早 `Sep 06 17:43`，`99-pawshop.conf` 文件时间 `Sep 6 18:29`）。`admin` 是**阿里云 SWAS 平台创建的用户**（UID 1000、密码锁定 `L`、带 `NOPASSWD: ALL` sudo），其 `authorized_keys` 里的非生产密钥注释为 **`swas-imported-key`**（阿里云导入密钥）→ 那 ~320 次 `Accepted publickey admin from 100.104.x.x` 是**阿里云控制台「远程连接」走内网**，末次 `Sep 14 17:36`，**全发生在我 Sep 16 开始工作之前**。**处置：不关端口**——关掉收益≈0（爆破本就不可能成功，只允许密钥），却可能打断阿里云控制台那条内网通道；已写成 `RUNBOOK` 的正式约定。 |
| A9 | 店主 `~/Downloads/AccessKey.csv` 明文凭据 | P2 | **店主** | 含一对真实 AccessKey（ID 24 位 / Secret 30 位，文件时间 `2026-09-13 17:56`）。**指纹比对确认不是生产在用的任何一把**（备份 OSS 密钥 `30f36f937bf4`/`977ae2c163a8`、商务 S3 密钥 `c5d4a2e09e69`/`816c291af801` 均不同）→ 生产不受影响。建议确认已无用后删除；若仍在使用，应改为独立 RAM 用户并尽快轮换。**我未改动该文件**（个人目录只读不写）。 |
| A10 | `_commerce/scripts` 没有静态"未定义标识符"检查（本轮真实差点上线） | P2 | Agent（**提议**） | 本轮我把 `manifestKeyTest` 用在 `sync-production-backups.mjs` 里**却漏了导入**：`node --check` 只做语法分析（语法合法，通过），四个契约测试只匹配字符串（也通过），**本地全绿但一上生产就是 `ReferenceError`**。是逐行复核 diff 才发现的。这些脚本本地跑不起来（模块加载即抛"必须 Linux/非 root"），所以没有"跑一下就知道"的兜底。**提议**：给 `_commerce/scripts` 加 ESLint（`no-undef` + `sourceType: module`）作为本地门禁；在没做之前，改这类脚本必须**逐行核对新用到的符号是否都在导入行里**。 |

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
4. **P1｜备份新鲜度缺少跨重启的可靠信号**：`backup_freshness` 仍只能读 systemd 运行时状态（重启后该属性为空）。已修成"报失败"而不是崩溃，但**重启后到下一次备份之间会误报一次**。干净做法是让备份把时间戳写进监控可读的文件（`PAWSHOP_MONITOR_BACKUP_TIMESTAMP_FILE` 机制已支持、**尚无写入方**），需要动 release 侧单元；注意 `/var/backups/pawshop` 是 `0700 pawshop-backup`，监控用户读不到。

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
