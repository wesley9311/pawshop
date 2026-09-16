# PawShop 运维手册（Runbook）

更新：2026-09-16。所有涉及生产服务器的主机侧命令来自仓库内已审查脚本（`ops/`、`_commerce/scripts/`、`_commerce/OPERATIONS_ZH.md`）；本机（店主 Mac）命令已在 WorkBuddy 接管轮实际执行验证（标 ✅）。

## 0. 环境速查

| 项 | 值 |
| --- | --- |
| 仓库 | `/Users/zhaoxiaomin/VScode/pawshop`（GitHub: wesley9311/pawshop） |
| 公开域名 | https://pawlivora.com |
| 生产主机 | 阿里云美国（硅谷）SWAS 2 vCPU / 2GB / 40GB，Ubuntu 24.04 |
| 本地私有目录 | `~/Documents/PawShop_Private/development/`（凭据/备份/本地库，永不入 Git） |
| 本地 PG | 127.0.0.1:54329（socket: `~/Documents/PawShop_Private/development/postgres-socket`） |
| 本地后端 | 127.0.0.1:9000（`npm --prefix _commerce run dev`） |

## 1. 本地开发与验证（店主 Mac）

```bash
# 依赖 + 构建 + 全量检查（✅ 2026-09-16 全部 exit 0）
npm ci && npm run build && npm run check          # 14 tests + security + html
npm --prefix _commerce ci                         # 实际命令: npm --prefix _commerce ci 不存在，用下行
npm ci --prefix _commerce
npm test --prefix _commerce                       # 62 tests
npm run check:types --prefix _commerce            # tsc --noEmit
NODE_ENV=development PAWSHOP_MODE=local-admin-only \
DATABASE_URL=postgresql://ci:fixture@127.0.0.1:54329/pawshop_dev \
JWT_SECRET=<64字符fixture> COOKIE_SECRET=<64字符fixture> \
  npm run build:ci --prefix _commerce             # medusa build

# 启动本地后端（读私有 commerce.env）
npm run dev --prefix _commerce                    # http://127.0.0.1:9000/app
npm run foundation:verify --prefix _commerce      # ✅ 通过
npm run catalog:verify --prefix _commerce         # ⚠️ 当前失败，见 RISK-1（RELEASE_GATES.md）

# 本地备份与恢复演练（✅ 2026-09-16 通过）
npm run backup:real --prefix _commerce
npm run restore:verify-real --prefix _commerce    # 隔离库恢复+自动清理
```

## 2. 线上展示站验证（只读，任何时候可做）

```bash
PAWSHOP_HTTPS_ORIGIN=https://pawlivora.com \
PAWSHOP_HTTP_ORIGIN=http://pawlivora.com \
  npm run verify:production                       # ✅ 2026-09-16 通过（1 个活跃商品）
```

失败时按 `PRODUCTION_HANDOFF_ZH.md` §6 排查：Nginx → DNS → 代理路径。

## 3. 展示站发布与回滚（生产主机，root）

- 发布：`ops/deploy-static.sh` —— 白名单打包、原子切换 `/srv/pawshop/current`、Nginx 校验后 reload、线上边界检查失败自动恢复上一 release。
- 回滚：脚本内建失败回滚；手动回滚 = 将 `current` 指回上一保留 release 并 reload Nginx（参照脚本内的原子切换模式，勿直接 rm）。

## 4. Commerce 生产部署（生产主机，root，未激活状态）

标准链路（全部脚本已入库并有测试覆盖，**尚未在生产执行**）：

```bash
# 1) 主机 bootstrap（✅ 已于 2026-09-08 执行过，commit 16cb875）
ops/commerce/bootstrap-ubuntu-host.sh

# 2) 生产身份与运行时
ops/commerce/provision-production-identities.sh
ops/commerce/install-commerce-runtime.sh

# 3) 生产环境装配（fail-closed，写 /etc/pawshop/commerce.env）
ops/commerce/provision-production-environment.sh

# 4) 不可变 release 准备 + 休眠安装
ops/commerce/prepare-commerce-release.sh
ops/commerce/deploy-commerce.sh

# 5) 证据门禁激活（迁移→首备份→OSS 回读→隔离恢复→验收，全部同源绑定）
ops/commerce/run-first-production-migration.sh
ops/commerce/run-first-production-backup-restore.sh
ops/commerce/finalize-production-admin.sh
```

## 5. Commerce 回滚（生产主机，root）

```bash
PAWSHOP_ROLLBACK_RELEASE_ID=<保留的完整40位SHA> \
PAWSHOP_ROLLBACK_COMPATIBLE=1 \
  ops/commerce/rollback-commerce.sh
```

- 前提：目标 release 仍保留在 `/srv/pawshop-commerce/releases/`；数据库 schema 兼容性已人工审查（`PAWSHOP_ROLLBACK_COMPATIBLE=1` 是显式声明门禁）。
- 脚本行为：flock 防并发、release 身份与权限校验、原子符号链接切换、失败恢复原链接。不删数据、不跑迁移。

## 6. 备份体系

| 层 | 触发 | 内容 | 保留 | 状态 |
| --- | --- | --- | --- | --- |
| 本地 | 手动 `backup:real` | AES-256 加密 dump + HMAC manifest → `~/Documents/PawShop_Private/development/backups/` | 本地清理保底 7 份 | ✅ 已验证 |
| 生产每日 | `pawshop-backup.timer` | pg_dump→加密→`/var/backups/pawshop` + OSS `daily/` | 90 天 | 未安装 |
| 月度 | `pawshop-backup-monthly.timer` | 复用最近已验证日备份 → OSS `monthly/YYYY-MM/` | 12 个月 | 未安装（WIP 保全） |
| 年度 | `pawshop-backup-yearly.timer` | 复用最近已验证日备份 → OSS `yearly/YYYY/` | 3 年 | 未安装（WIP 保全） |

**密钥纪律**：备份密钥（`backup.key`）绝不与密文同存一处；OSS 运行时凭据无删除权限；丢失密钥=旧备份不可解密。

**恢复**：
- 本地演练：`restore:verify-real`（✅ 2026-09-16 通过，临时库自动清理）。
- 生产：`pawshop-restore-verify.service`（手动触发、独立 OS 账号、一次性集群、不连生产库）。
- 真实灾难恢复：先恢复到隔离库核对，再由店主决策切换；禁止直接覆盖生产库。

## 7. 事件处理（Incident）

1. **网站打不开**：查 Nginx/HTTPS → DNS → `verify:production` 复测。
2. **后台打不开**：SSH 隧道 → `systemctl status pawshop-commerce` → Medusa 日志 → 回环端口。
3. **每日备份失败**：`systemctl status pawshop-backup.service` → `/var/backups/pawshop` → OSS 权限/网络；**当日修复并手动补跑**，连续失败按数据事件升级。
4. **数据疑似误删**：**立即停止写操作**、保留证据、恢复到隔离库核对、店主决策。
5. **发布失败**：查 `/var/lib/pawshop-release-evidence/<commit>` → 脚本已自动回滚则确认 `current` 指向；未回滚则按 §5 手动回滚。

## 8. Agent 自动化边界

**允许自动**：health check、smoke test（verify:production）、测试套件、备份完整性校验（只读）、无状态本地服务重启。

**必须人工审批**：删除生产 DB、破坏性 migration、删除 Storage/Backup、修改 IAM/支付账户、任何不可逆数据操作、生产 commerce 激活链的每一步。

## 9. 监控（当前缺失，TODO）

最低要求（未实现，列为上线前 P1）：
- uptime monitoring（外部探针 pawlivora.com）
- 5xx / API 错误率与延迟
- DB 连通性、备份 timer 成功/失败告警
- 证书到期检测

日志纪律：可区分 DEBUG/INFO/WARN/ERROR；**永不**记录密码、token、完整 session、数据库 secret、客户明文。
