# Agent 交接说明（AGENT_HANDOFF）

写给：Codex（恢复额度后的独立审查者）/ 任何后续接手的工程 agent。
写于：2026-09-16，WorkBuddy 工程推进轮结束时。

## 1. 审计入口

```bash
cd /Users/zhaoxiaomin/VScode/pawshop
BASE_COMMIT=366cc0e3656eb2259e9f4e4002452f142d20a147
git diff $BASE_COMMIT...HEAD        # WorkBuddy 全部变更
git log --oneline $BASE_COMMIT..HEAD
```

**提交结构约定**：
- `13616a9` — Codex 接管时未提交的 WIP 保全快照（12 修改 + 6 新文件，分层异地备份收尾）。**这不是 WorkBuddy 的创作**，是现场保护；其内容后来被 62 项 commerce 测试整体覆盖验证（全部通过）。
- 之后的提交 = WorkBuddy 变更：`.gitignore` 追加 `.workbuddy/`、新增 `docs/` 六份文档。**没有修改任何生产代码**。

## 2. WorkBuddy 本轮做了什么 / 没做什么

### 第一轮（勘察 + 证据固化）

做了（全部有 exit code 证据）：
1. PHASE 0 现场保护：记录 BASE_COMMIT、WIP 固化、无 stash/未推送/tag。
2. 根目录：npm ci / build / check（security+html+14 tests）全绿；audit prod 0 漏洞。
3. `_commerce`：npm ci / 62 tests / tsc --noEmit / medusa build 全绿。
4. 本地运行时验证：dev server 起停、health 200、foundation:verify 通过、独立 curl 复核路由边界（/app 200、/admin/* 401、/store/* 拒绝）。
5. 本地备份 + 恢复演练通过，确认无临时库残留。
6. 线上展示站 verify:production 通过（只读）。
7. 安全静态审查：密钥模式 git grep 零命中、.env.example 占位符复核、localhost 仅存在于本地 CORS 策略（by design）。
8. 发现并记录 3 项 RISK（见 RELEASE_GATES.md §风险登记），**未擅改数据**。
9. 写 docs/ 六份文档（本文件 + PROJECT_STATE / ARCHITECTURE / RELEASE_GATES / RUNBOOK / WORKBUDDY_COMPLETION_REPORT）。

### 第二轮（经店主批准的三项优先处置）

10. **RISK-1 数据漂移闭环**：先备份（`pawshop_dev_20260916T054523011Z`），再单条条件 UPDATE 命中 1 行把本地商品切回 `draft`；`catalog:verify` 转通过。这是**唯一的数据库写操作**，已获店主明确批准。
11. **生产监控落地**（`5b4d056`）：`monitoring-policy.cjs`（纯策略）+ `monitor-production.mjs`（12 项检查）+ 8 项单测 + 加固 systemd 单元/定时器 + 无 Secret 配置模板。真实冒烟 10/12（2 项失败：HSTS 真实缺口、本机无 Redis）。
12. **Medusa 2.19.0 → 2.21.0**（`f679161`）：九个包同步升级、lockfile 重建、全量回归通过（70/70 测试、类型检查、构建、运行时、监控冒烟）。**结论：漏洞计数未变**（73 个，单一 lodash 根因，上游无补丁）。
13. 新发现 **RISK-5**：线上缺 HSTS（监控发现 + 独立 curl 复核）。

### 没做（及原因）

- 未做破坏性删除：旧 `_commerce/node_modules`（741MB）移到 `/tmp/pawshop-commerce-node_modules-2.19.bak` 作为回滚备份，未删除。
- 未执行 `npm audit fix --force`：会把 `@medusajs/file-s3` 降到 `0.0.3`，有害。
- 未安装生产监控定时器、未改生产 Nginx HSTS：需生产主机 root（人工审批范围）。
- 未执行生产 commerce 激活链：需生产主机 root + 店主在场。
- 未做移动端/跨浏览器布局验证：无浏览器自动化执行证据，如实标 UNVERIFIED 而非猜测。
- Webhook 真实投递未做端到端验证（需真实端点），该路径仅单测覆盖。

## 3. 交接后的建议动作（优先级序）

1. **P1**：生产主机补 HSTS + 安装监控定时器（RUNBOOK §9），由监控确认转绿。
2. **P1**：配置真实告警 webhook 并做一次端到端投递验证。
3. **P1**：店主决策 RISK-4（公开 Git 历史含供应商成本字段）如何处置。
4. **P2**：追踪 lodash 上游补丁；开放任一公网 Store API 前重评 RISK-2。
5. **P2**：跨浏览器/移动端布局验证（可复用 `codex/pawshop-mobile-preview-fix` 分支经验）。
6. **生产激活**：按 RUNBOOK §4 在店主在场时执行证据门禁激活链。

## 4. 关键不变量（审查时请重点核对未被破坏）

- Store/Customer API 无条件关闭门禁仍在（`src/` 策略文件未被 WorkBuddy 触碰）。
- `.env*` 真实文件不在 Git；`.env.example` 与新增的 `monitoring.env.example` 均无真实值。
- 既有生产脚本（`ops/*.sh`、`_commerce/scripts/*.mjs` 原有文件）未被 WorkBuddy 修改；第二轮只**新增**监控模块文件。
- 第二轮唯一的数据库写操作是经店主批准的 1 条 UPDATE（本地开发库，RISK-1）。
- 无 force push、无历史重写、无生产数据操作。
- 分支 `codex/pawshop-real-operations` 未推送，等店主/Codex 决定推送时机。

## 5. 本地运行时注意（含踩坑记录）

- Bash 工作目录在调用间可能重置：**始终用 `npm --prefix <绝对路径>` 或显式 cd**。
- 本机 curl 有代理干扰回环地址：测本地服务加 `--noproxy '*'`。
- 本地 PostgreSQL 在 54329（socket 目录在私有开发目录），psql 完整路径 `/opt/homebrew/Cellar/postgresql@17/17.11/bin/psql`。
- 私有凭据文件（commerce.env）使用时只进环境变量，**永不**回显或落盘到仓库。
- **批量删除保护**：`rm -rf node_modules` 会被安全策略拦截。需要重建依赖树时改为 `mv node_modules /tmp/<bak>`（可回滚），不要硬删。
- **Medusa 全家族升级必须重建 lockfile**：npm 增量解析会因旧树/旧 lock 报 ERESOLVE，需先移走 `node_modules` 与 `package-lock.json` 再 `npm install`。
- 勿运行 `npm audit fix --force`（会把 `@medusajs/file-s3` 降到 0.0.3）。
