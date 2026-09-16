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

没做（及原因）：
- 未升级 Medusa 2.19→2.21 修复 77 个依赖漏洞：超出锁定范围，供应链变更是店主级决策。
- 未将本地 DB 商品改回 draft：店主数据，等确认（RISK-1 有精确修复 SQL）。
- 未执行生产 commerce 激活链：需要生产主机 root + 店主在场，且属于「必须人工审批」清单。
- 未创建监控：需要选择外部服务（店主决策），本轮只完成了 TODO 登记。
- 未做移动端/跨浏览器布局验证：无浏览器自动化执行证据，如实标 UNVERIFIED 而非猜测。

## 3. 交接后的建议动作（优先级序）

1. **P1**：店主确认 RISK-1 修复方案（一条 UPDATE，先 backup:real）。
2. **P1**：店主决策 Medusa 升级轮次（2.21.0 + 全量回归）或接受风险缓释（回环部署面小、无公网 API）。
3. **P1**：搭建监控（uptime + 备份失败告警最低集）。
4. **P2**：跨浏览器/移动端布局验证（可复用 `codex/pawshop-mobile-preview-fix` 分支经验）。
5. **生产激活**：按 RUNBOOK §4 在店主在场时执行证据门禁激活链。

## 4. 关键不变量（审查时请重点核对未被破坏）

- Store/Customer API 无条件 503 门禁仍在（`src/` 策略文件未被 WorkBuddy 触碰）。
- `.env*` 真实文件不在 Git；`.env.example` 无真实值。
- 生产脚本（ops/、_commerce/scripts/）未被 WorkBuddy 修改（除 WIP 保全提交外）。
- 无 force push、无历史重写、无生产数据操作。
- 分支 `codex/pawshop-real-operations` 未推送（ahead 1+，等店主/Codex 决定推送时机）。

## 5. 本地运行时注意

- Bash 工作目录在调用间可能重置：**始终用 `npm --prefix <绝对路径>` 或显式 cd**。
- 本机 curl 有代理干扰回环地址：测本地服务加 `--noproxy '*'`。
- 本地 PostgreSQL 在 54329（socket 目录在私有开发目录），psql 完整路径 `/opt/homebrew/Cellar/postgresql@17/17.11/bin/psql`。
- 私有凭据文件（commerce.env）使用时只进环境变量，**永不**回显或落盘到仓库。
