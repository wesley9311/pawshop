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

## 9. 监控与告警

实现：`_commerce/scripts/monitor-production.mjs`（策略层 `monitoring-policy.cjs` 可单测），systemd 定时器 `pawshop-monitor.timer`（每 5 分钟），配置 `/etc/pawshop-monitor/monitoring.env`（root:pawshop 0640，无 Secret）。

覆盖的 12 项检查：公网站 HTTPS 可用性、首字节延迟、安全响应头、HTTP→HTTPS 重定向、证书剩余天数（默认 ≥14 天）、commerce 健康、Store 路由关闭不变量、admin 未鉴权必须 401、PostgreSQL 回环连通、Redis 回环连通、备份新鲜度（默认 ≤36 小时）、根盘剩余空间（默认 ≥10%）。

```bash
# 手动运行（只读）
sudo systemctl start pawshop-monitor.service
journalctl -u pawshop-monitor.service -n 50 --no-pager

# 本地冒烟（不依赖 systemd）
cd _commerce
PAWSHOP_MONITOR_STOREFRONT_ORIGIN=https://pawlivora.com \
PAWSHOP_MONITOR_COMMERCE_ORIGIN=http://127.0.0.1:9000 \
PAWSHOP_MONITOR_DATABASE_PORT=54329 \
PAWSHOP_MONITOR_SKIP_SYSTEMD_CHECKS=1 \
PAWSHOP_MONITOR_STATE_FILE=/tmp/pawshop-monitor-state.json \
  node scripts/monitor-production.mjs
```

退出码：`0` 全部健康；`1` 有检查失败；`2` 检查失败且告警投递也失败。

告警通道：`PAWSHOP_MONITOR_ALERT_WEBHOOK`（HTTPS，可选）。未配置时 fail-closed：只在日志中记录 WARN，绝不假装已告警。相同告警签名 30 分钟内去重；恢复时发送一次 recovery。告警载荷只含检查名、状态与指标，不含任何秘密或响应体。

安装定时器（生产主机，root）：

```bash
install -o root -g root -m 0644 ops/commerce/pawshop-monitor.service /etc/systemd/system/
install -o root -g root -m 0644 ops/commerce/pawshop-monitor.timer /etc/systemd/system/
install -d -o pawshop -g pawshop -m 0700 /var/lib/pawshop-monitor
install -o root -g pawshop -m 0640 ops/commerce/monitoring.env.example /etc/pawshop-monitor/monitoring.env   # 填入真实值后
systemctl daemon-reload && systemctl enable --now pawshop-monitor.timer
```

## 10. 主机侧安全缺口修复（生产主机，root）

2026-09-16 对抗审查（`docs/ADVERSARIAL_REVIEW.md`）确认线上存在两项主机侧缺口。仓库内提供**机器校验** `npm run verify:production:strict`。

**执行状态：AR-6 与 AR-7 已于 2026-09-16 由 WorkBuddy 在生产主机执行并验证通过**——`verify:production:strict` 已由 FAIL 转为 PASS（`HSTS max-age 15552000s; www redirects to the apex origin`）。以下保留执行记录、验证命令与回滚方式。

- 主机：`47.254.26.124`（阿里云 SWAS，Ubuntu 24.04，nginx 1.24.0，托管 `pawlivora.com` + `www`，两者解析到同一 IP）
- 改动文件：`/etc/nginx/sites-available/pawshop`
- 改动前备份：`/root/pawshop-nginx-pawshop.bak-20260916T070651Z`（sha256 `4b239578…` → 改动后 `b4b816f2…`）
- 实际改动（4 行，加在 HTTPS 内容 `server` 块内、既有 `add_header` 之后）：

```nginx
  add_header Strict-Transport-Security "max-age=15552000" always;
  if ($host = www.pawlivora.com) {
    return 301 https://pawlivora.com$request_uri;
  }
```

### 10.1 缺 `Strict-Transport-Security`（AR-6）—— 已修复

**为什么必须与已有 `add_header` 同块**：Nginx 的 `add_header` 在子级作用域内**不继承**——只要某个 `location` 自己写了 `add_header`，该 `location` 就不再继承上级的头。本配置的 `location = /admin.html`、`location = /dashboard.html`、`location = /account.html`、`location /` 均未自定义 `add_header`，所以放在 `server` 级可正确下发到所有响应（含 404）。

验证（2026-09-16 实测，外部与本机 `--resolve` 双向确认）：

```bash
curl -sI https://pawlivora.com/ | grep -i strict-transport-security   # Strict-Transport-Security: max-age=15552000
curl -sI https://pawlivora.com/ | grep -iE 'x-(content-type-options|frame-options)'  # 既有两头仍在
PAWSHOP_HTTPS_ORIGIN=https://pawlivora.com PAWSHOP_HTTP_ORIGIN=http://pawlivora.com npm run verify:production:strict
```

**回滚**：删除该 `add_header` 行 → `nginx -t` → `systemctl reload nginx`。注意 HSTS 一旦被浏览器缓存，在 `max-age` 到期前**无法通过服务端撤销**，因此 `max-age` 从 180 天起步、且**先不含** `includeSubDomains`。确认全部子域均为 HTTPS 后才升级为 `"max-age=31536000; includeSubDomains"`，最后才考虑 `preload` 与预加载列表提交。

### 10.2 `www` 未规范化到 apex（AR-7）—— 已修复

原状：`https://www.pawlivora.com/` 返回 **200** 且与 apex 内容 MD5 一致（`29aaa54a…`）→ 同一内容由两个主机名提供，构成重复内容。根因两条：HTTPS 内容块的 `server_name` 同时列出 `pawlivora.com` 与 `www.pawlivora.com`；80 端口块的重定向用 `$host`，把 `www` 原样保留了下来。

**实际采用做法**：没有新增独立 `server` 块，而是在既有 HTTPS 内容块内加一个 server 级 `if ($host = www.pawlivora.com) { return 301 https://pawlivora.com$request_uri; }`。理由：

1. 改动最小（1 行），避免新增块时 `listen [::]:443 ssl ipv6only=on` 在同端口重复声明导致的选项冲突；
2. 与 certbot 自己在 80 端口块生成的 `if ($host = …)` 模式一致，`certbot renew` 时不会被插件改写；
3. server 级 `if` 在 rewrite 阶段**先于** location 匹配执行，因此经 `www` 访问 `/admin.html` 也会先跳到 apex、再由 apex 返回 404——门禁不被绕过（已实测 `admin_status=404`）。

验证（2026-09-16 实测）：

```bash
curl -sI https://pawlivora.com/          # 200 + HSTS + X-Content-Type-Options + X-Frame-Options
curl -sI https://www.pawlivora.com/      # 301, Location: https://pawlivora.com/
curl -sI http://pawlivora.com/           # 301, Location: https://pawlivora.com/
curl -so /dev/null -w '%{http_code}\n' https://pawlivora.com/admin.html   # 404（门禁仍在）
```

**已知小瑕疵（已接受）**：`http://www.pawlivora.com/` 需两跳（`→ https://www → https://apex`），因为 80 端口块属 certbot 托管行，本轮未改动。HTTPS 侧已是**单跳**，搜索引擎抓取到的规范 URL 命中单跳，无实质 SEO 损失。若要收敛为一跳，把 80 端口块中 `$host = www.pawlivora.com` 那条的 `https://$host$request_uri` 改成 `https://pawlivora.com$request_uri` 即可（证书 SAN 已覆盖 `www`，安全）。

**回滚**：删除该 `if` 块 → `nginx -t` → `systemctl reload nginx`；或整体 `cp -a` 还原备份文件。

### 10.3 首页与 sitemap（AR-9 / AR-10，需先决策再动）

现状：`/` 返回 116 字节的 `index.html`（`<meta http-equiv="refresh">` 跳转到 `PawShop.html`）；`/sitemap.xml` 为 404。

**约束（重要）**：`scripts/production-probe.mjs` 断言 `/` 返回 **200**。因此不能用 `return 301` 把 `/` 重定向走，否则标准验证会失败。可选方案：

1. 让 `/` 直接返回首页内容而不跳转（`location = / { try_files /PawShop.html =404; }`），此时 `/` 与 `/PawShop.html` 需通过 `canonical` 明确其一为规范 URL；
2. 保持现状，仅补 `sitemap.xml` 并在其中只列 apex + `/PawShop.html` 的规范形式。

方案选定后再补 `sitemap.xml` 与 `canonical`，并把 `sitemap.xml` 加入 `ops/deploy-static.sh` 的 `public_paths`、在 `robots.txt` 中以 `Sitemap:` 声明。**10.2 已于 2026-09-16 完成（规范主机已确定为 apex），因此现在可以安全地把 apex 固化进 sitemap 与 canonical。**


日志纪律：可区分 DEBUG/INFO/WARN/ERROR；**永不**记录密码、token、完整 session、数据库 secret、客户明文。
