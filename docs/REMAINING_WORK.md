# PawShop 未完成清单与操作顺序

更新：2026-09-16（WorkBuddy 第五轮）
配套阅读：`docs/OWNER_ACTIONS_ZH.md`（**需要店主本人出面的项：链接、点击步骤、交付方式**）、`PRODUCTION_HANDOFF_ZH.md`（路径与排错总索引）、`docs/RUNBOOK.md`（可执行命令）、`docs/ADVERSARIAL_REVIEW.md`（对抗审查发现）。

图例：**P0** 阻塞上线 / **P1** 上线前应完成 / **P2** 可延后。**归属** 指谁能做：
**Agent** = 可自主执行并验证；**店主** = 必须本人（身份、协议、账号归属、付款）；**共同** = Agent 执行、店主在场确认。

---

## A. 生产环境现状与剩余项

### 已完成的（本轮及前一轮）

| 项 | 证据 |
| --- | --- |
| HSTS + www→apex 301 | `verify:production:strict` PASS；`max-age=15552000`；`www` 301 到 apex |
| 展示站发布 | release `6dce5a4`；`/srv/pawshop/current` 指向它；上一版 `a74aab3` 保留可回滚 |
| sitemap.xml + robots 声明 | 线上 200、XML 合法、7 条 URL；`Sitemap:` 已写入 robots.txt |
| 监控定时器 | `pawshop-monitor.timer` enabled+active，每 5 分钟；实测 16:30:13 跑通 **12/12** |
| 陈旧 GitHub Pages 镜像（AR-8） | 已停用，镜像 URL 返回 404；仓库仍为 PUBLIC |
| 隐私声明事实性 | 已改为"自管主机、同源资源、无第三方 CDN"；日期 2026-09-16 |

### 未完成

| # | 项 | 级别 | 归属 | 说明与前置条件 |
| --- | --- | --- | --- | --- |
| A1 | **告警 webhook 未配置** | P1 | 店主 → Agent | 监控目前是 **log-only**：失败只写 journal 与本地 state，不会主动通知任何人。**2026-09-16 已补齐通道适配层**：飞书/Slack/Telegram/generic 四家的报文方言、厂商域名钉住、以及"HTTP 200 但内部报错 = 未投递"的判定都已实现，并有本地端到端实测（`npm run test:alert-delivery`，10/10）。**现在只剩你要给我一个 URL 这一步**——获取方式与逐条点击步骤见 `docs/OWNER_ACTIONS_ZH.md` §1，接入步骤见 `docs/RUNBOOK.md` §9.3。**不要把 webhook URL 直接贴到聊天里**：它等同于一个写入凭据。 |
| A2 | **加密备份链未启用** | **P0** | 共同 | `pawshop-backup.timer` 存在但 disabled，且现在**即使启用也会失败**，有四处硬阻塞：<br>① `pawshop-backup.service` 的 `WorkingDirectory=/srv/pawshop-commerce/current/_commerce` —— commerce release 未激活，该路径不存在；<br>② `/etc/pawshop-backup/backup-offsite.env` 缺失；<br>③ `LoadCredential` 需要的 `/etc/pawshop-backup/backup-s3-access-key`、`backup-s3-secret-key` 缺失；<br>④ 单元 `Requires=postgresql.service`，而该 meta 单元是 `inactive`（真正在跑的是 `postgresql@17-main.service`）。<br>**当前后果：生产库没有任何加密备份。** 库现在是空的（见 A4）所以暂时无数据可丢，但**必须在开放下单前解决**。 |
| A3 | 监控有两项**临时跳过** | P1 | Agent | `/etc/pawshop-monitor/monitoring.env` 里 `PAWSHOP_MONITOR_SKIP_COMMERCE_CHECKS=1` 与 `PAWSHOP_MONITOR_SKIP_SYSTEMD_CHECKS=1`。前者让 3 项 commerce 检查记为"显式跳过"，后者让备份新鲜度检查跳过。**commerce 激活并启用备份后必须删掉这两行**，否则真实的 commerce 宕机与备份中断会被掩盖。删掉后监控应变成 12/12 且全部为真实检查。 |
| A4 | 生产库 `pawshop` 存在但**空** | 提示 | Agent | 库已创建，但 `public` schema **0 张表**——首次迁移从未执行。这正是"目前没有可丢数据"的原因。 |
| A5 | commerce release 从未部署 | P0 | 共同 | `/srv/pawshop-commerce/current` 不存在；`releases/` 里有 3 个旧构建，其中 `79a045c` 早于监控模块，不含 `monitor-production.mjs`。这是 A2、B1 的共同根因。 |

---

## B. 商务后台（Medusa）激活 —— 下一个里程碑

这是 Codex 方案里"先激活生产后台并验证商品草稿上传"那一步，也是 A2/A3/A5 的统一解锁点。

**激活链（`docs/RUNBOOK.md` §4，全部为已审查脚本）**

1. 更新 `/srv/pawshop-source` 到目标 commit（它是**商务**构建源，与展示站的 `/srv/pawshop/source` 是两棵独立的树）。
2. `prepare-commerce-release.sh` → 产出 `/srv/pawshop-commerce/releases/<sha>`（带 manifest + evidence）。
3. `install-commerce-runtime.sh` 安装 8 个单元 + libexec —— 注意该脚本是**首次安装**语义：它要求 `current` 不存在、单元不存在、libexec 为空。本机已存在 4 个单元与 2 个 libexec 文件，**所以它会在前置检查处直接拒绝**，需要先由店主审阅现有 4 个单元的去留。
4. `run-first-production-migration.sh` 执行首次迁移（会写迁移门禁）。
5. `finalize-production-admin.sh` / `create-production-owner.mjs` 建店主账号 → `/root/pawshop-production-owner-credentials.json`（现在**不存在**）。
6. `verify-production-admin.mjs` 验证登录与商品草稿上传。
7. `deploy-commerce.sh` 激活（`PAWSHOP_RELEASE_ACTIVATION_CONFIRMED=1`）→ 建 `current` + 重启服务。

**需要店主先拍板的一件事（B2）**：后台暴露方式。RUNBOOK 的既定设计是**回环 + SSH 隧道**（`127.0.0.1:9000`，不对外）。这最安全，但也意味着**浏览器里的中文运营台无法直接调 Admin API**（浏览器在你自己电脑上，够不到服务器的回环口）。三条路：

- **(a) 保持回环 + SSH 隧道**，运营台只在店主本机跑。最安全，但"随时随地用"很别扭。
- **(b) 同源反向代理**：nginx 在 pawlivora.com 下开 `/admin-api/` → `127.0.0.1:9000`，加 IP 白名单或 Basic Auth，再叠 Medusa 自身鉴权。**运营台能用，攻击面从 0 变成 1**，但可控。推荐作为运营台的前置。
- **(c) 直接公网暴露 Admin API**：不推荐。

**我的判断：走 (b)**，但要在运营台开工前先定，否则运营台做完发现调不通。

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

1. **店主提供告警 webhook** → Agent 接入并做一次真实投递验证（A1）。
2. **确定后台暴露方式 B2**（建议方案 b）。
3. **激活商务后台**（B1 全链）→ 此时 A2/A3/A5 一并解锁：回填 commerce 环境检查、启用备份链、删掉两行 skip。
4. **做首次加密备份 + 隔离恢复演练**（A2 收尾）。
5. **中文运营台**（C），从只读看板起步。
6. **收款通道沙盒接入**（D），通过后再考虑真实扣款。
7. 视情况合并 `main`（E2）。

每一步之后都跑一遍 `docs/RUNBOOK.md` §4 的全量门禁（根 `check` + `build`、commerce 测试/类型/构建、真实浏览器检查、`verify:production` 与 `verify:production:strict`）。
