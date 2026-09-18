# PawShop 未完成清单与操作顺序

更新：2026-09-17（WorkBuddy 第七轮）
配套阅读：`docs/OWNER_ACTIONS_ZH.md`（**需要店主本人出面的项：链接、点击步骤、交付方式**）、`PRODUCTION_HANDOFF_ZH.md`（路径与排错总索引）、`docs/RUNBOOK.md`（可执行命令）、`docs/ADVERSARIAL_REVIEW.md`（对抗审查发现）。

图例：**P0** 阻塞上线 / **P1** 上线前应完成 / **P2** 可延后。**归属** 指谁能做：
**Agent** = 可自主执行并验证；**店主** = 必须本人（身份、协议、账号归属、付款）；**共同** = Agent 执行、店主在场确认。

---

## 0. 当前唯一的关键路径阻塞：**推送**

**一句话**：本轮所有工程改动都已完成、已本地提交、**未推送**（店主的规矩是推送前先问）。而**激活商务后台要求主机源码树停在已推送的提交上**（主机 `git fetch` 是匿名、且 release 校验要求 `HEAD` == release ID 且工作树干净）。所以：

```
说出"可以推送"
  → 主机取码 → prepare release → 首次迁移 → 首次加密备份 + 离线回读 + 隔离恢复演练
  → 激活商务后台 → 删掉监控那两行临时跳过 → 启用备份定时器
  → 开工中文运营台
```

**为什么不能用主机上现成的 `79a045c`**：它**不含** `write-production-backup-restore-evidence.mjs`，走不了首次备份的证据流程（`run-first-production-backup-restore.sh` 第 140 行会调用它）。所以必须准备一个新 release。

命令序列已写入 `docs/RUNBOOK.md` **§11 商务后台激活序列**（含前置校验与回滚）。

---

## A. 生产环境现状与剩余项

### 已完成的（本轮及前几轮）

| 项 | 证据 |
| --- | --- |
| HSTS + www→apex 301 | `verify:production:strict` PASS；`max-age=15552000`；`www` 301 到 apex |
| 展示站发布 | release `6dce5a4`；`/srv/pawshop/current` 指向它；上一版 `a74aab3` 保留可回滚 |
| sitemap.xml + robots 声明 | 线上 200、XML 合法、7 条 URL；`Sitemap:` 已写入 robots.txt |
| 监控定时器 | `pawshop-monitor.timer` enabled+active，每 5 分钟；实测 **12/12** |
| **告警双通道（飞书 + Slack）** | **2026-09-17 接入并真实投递验证**：告警与恢复各一条、四条全部送达；多通道脚本已上主机；日志会点名未确认的通道 |
| **备份凭据 + 两个闸门** | `pawshop-backup-writer` + 最小权限策略（对象级三权限，**读不到任何桶级元数据**）；密钥 root-only、`LoadCredential` 注入；`DeleteObject → 403`、**版本控制改用功能性证明（覆盖上传后旧版本仍可读）** 均已实测；自检脚本 `ops/commerce/verify-offsite-credential.mjs` **7/7**。⚠️ 运行时改为**对象级**版本证明——原 `GetBucketVersioning` 前置检查在该权限边界下**永不通过**（首次备份实测暴露，已修） |
| **OSS 生命周期** | 4 条规则（原有全桶非当前版本规则 + daily 90 / monthly 365 / yearly 1095），写入后回读核对 |
| 陈旧 GitHub Pages 镜像（AR-8） | 已停用，镜像 URL 返回 404；仓库仍为 PUBLIC |
| 隐私声明事实性 | 已改为"自管主机、同源资源、无第三方 CDN"；日期 2026-09-16 |

### 未完成

| # | 项 | 级别 | 归属 | 说明与前置条件 |
| --- | --- | --- | --- | --- |
| A0 | **待批准的提交未推送** | **P0** | 店主 → Agent | 见上面 §0。这是 A2/A5/B1 现在唯一的共同前置。 |
| A1 | 告警 webhook 未配置 | P0 | ⏳ **待发版** | ✅ 2026-09-17 完成接入：飞书 + Slack 双通道，真实投递验证通过。当日的"已验证送达"结论**当天晚上即被推翻**：生产真触发一次告警时飞书回 `code:19024`，逐候选探测发现该群关键词已从 `[PawShop 告警]` 变成 `[PawShop]`，**飞书通道自那一刻起静默丢弃全部告警**（只有 Slack 在响），而监控始终 12/12 全绿。已把信封改为 `[PawShop] 告警`（同时含两种写法）、日志补上厂商错误码与含义、`run.sh` 加关键词拒收用例，并用真实通道复验通过（RUNBOOK §9.3/§9.3.1）。**修复只改了 libexec 的 2 个文件，需要一次 release 才生效**；不需要重新激活商务，也不需要清库。 |
| A2 | **加密备份链未启用** | **P0** | Agent（待 A0） | 原有四处硬阻塞，**2026-09-17 全部清除**：① 首次备份流程用 release 自身目录（`--property=WorkingDirectory=$release/_commerce`，不需要 `current`）；② `backup-offsite.env` 已写入**且两个闸门已打开**（留空会让离线同步 fail-closed，这是设计而非缺陷）；③ `backup-s3-access-key` / `backup-s3-secret-key` 已写入（`root:root 0600`）并用真实凭据实测（能写、能回读版本、**删除被拒 403**、读不了生命周期规则）；④ `Requires=postgresql.service` → `postgresql@17-main.service`（⚙️ 纠正：`postgresql.service` 是空壳单元 `ExecStart=/bin/true`，依赖它等于没有任何保证，并非"inactive 起不来"）。<br>**仍剩**：首次加密备份 + 离线回读 + 隔离恢复演练尚未执行——**它要求一个已推送的 release 提交（A0）**。<br>**当前后果：生产库没有任何加密备份。** 库现在是空的（见 A4）所以暂时无数据可丢，但**必须在开放下单前解决**。 |
| A3 | 监控有两项**临时跳过** | P1 | Agent（待 A5） | `/etc/pawshop-monitor/monitoring.env` 里 `PAWSHOP_MONITOR_SKIP_COMMERCE_CHECKS=1` 与 `PAWSHOP_MONITOR_SKIP_SYSTEMD_CHECKS=1`。前者让 3 项 commerce 检查记为"显式跳过"，后者让备份新鲜度检查跳过。**commerce 激活并启用备份后必须删掉这两行**，否则真实的 commerce 宕机与备份中断会被掩盖。删掉后监控应变成 12/12 且全部为真实检查。 |
| A4 | 生产库 `pawshop` 存在但**空** | 提示 | Agent | 库已创建（⚙️ 纠正上轮"未创建"的说法），但 `public` schema **0 张表**——首次迁移从未执行。这正是"目前没有可丢数据"的原因。 |
| A5 | commerce release 从未部署 | P0 | Agent（待 A0） | `/srv/pawshop-commerce/current` 不存在；`releases/` 里有 3 个旧构建，其中 `79a045c` 早于监控模块，**且不含 `write-production-backup-restore-evidence.mjs`**，因此走不了首次备份的证据流程。这是 A2、B1 的共同根因，**必须准备新 release**。 |
| A6 | 临时 RAM 用户 `pawshop-agent-temp` 残留 | P2（非关键路径） | **店主**（1 分钟） | 我用它完成了备份凭据与生命周期配置；收尾时**先解除策略、后删密钥**的顺序错误让我失去了 RAM 权限，删不掉自己这个用户。**它已彻底作废**（OSS 管理/数据面与 RAM 全部 403）。删除步骤见 `docs/OWNER_ACTIONS_ZH.md` §2.3。 |

---

## B. 商务后台（Medusa）激活 —— 下一个里程碑

这是 Codex 方案里"先激活生产后台并验证商品草稿上传"那一步，也是 A2/A3/A5 的统一解锁点。

**激活链（可执行命令已整理进 `docs/RUNBOOK.md` §11，全部为已审查脚本）**

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

### B3 2026-09-17 状态与未结项

**已完成**：商务后台**已激活并在跑**（`current` → `9bac8dc`，服务 enabled+active、NRestarts=0，只监听回环），4 个定时器（3 个备份 + 监控）全部 enabled，服务已 enable 开机自启，首次加密备份 + OSS 精确版本回读 + 隔离恢复演练全部通过，线上店铺全程 200 无中断，**监控 12/12 全部真实检查（无任何跳过行）**。

**未结项（按优先级）**：

1. **P0｜店主账号未建**：等店主给一个**小写**邮箱（脚本的校验只接受小写完整地址）；密码由 `provision-production-owner-credentials.mjs` 随机生成、写入 root-only 文件、**不打印**。拿到邮箱后跑 `finalize-production-admin.sh <ID>` 即可（它还会复核 owner 登录、跑管理端验证、并 enable 服务与 3 个定时器——这几项现已手工完成，重复执行是幂等的）。
2. ~~**P0｜一个数据库只能激活一个 release**~~ → **✅ 2026-09-18 结项**：新增**升级证据路径**（`pawshop-production-migration-v2`，`initialization: 'existing-database'`），配套 `ops/commerce/run-production-upgrade-migration.sh` 与 `write-production-upgrade-evidence.mjs`；门禁与备份证据两处断言同时接受两种证据，空库路径一字未改。**为什么它比原计划更急**：核对时生产库已是 **155 关系 / 147 张表 / 601 行**（含店主账号），也就是"下一次发版必须清库"= 下一次发版会删掉这些。升级记录要求：前任 release、改动前的加密恢复点（清单 HMAC + 密文摘要/HMAC + 异地回执全部校验）、逐表行数见证（不得减少、关系不得消失）、关系数不得减少。命令见 RUNBOOK §11.2。**仍待观察**：这条路径的**首次实跑**（即下一次发版本身）——它同时是"升级能力"的验收。
3. **P1｜备份新鲜度缺少跨重启的可靠信号**：`backup_freshness` 仍只能读 systemd 运行时状态（重启后该属性为空）。已修成"报失败"而不是崩溃，但**重启后到下一次备份之间会误报一次**。干净做法是让备份把时间戳写进监控可读的文件（`PAWSHOP_MONITOR_BACKUP_TIMESTAMP_FILE` 机制已支持、**尚无写入方**），需要动 release 侧单元；注意 `/var/backups/pawshop` 是 `0700 pawshop-backup`，监控用户读不到。

**已结项（同日）**：定时备份的异地同步（`ExecStartPost` 读不到 systemd 凭据 → 异地副本静默落后）已随 release `9bac8dc` 修复并实测通过；`SKIP_SYSTEMD_CHECKS` 已删除，监控不再有任何跳过行。

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
