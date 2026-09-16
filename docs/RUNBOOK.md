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

退出码：`0` 全部健康；`1` 有检查失败；`2` **已尝试投递、但告警通道没有接受**。注意区分：被去重窗口抑制的那一轮是 `1` 而不是 `2`——"刻意不发"不等于"告警坏了"（该缺陷已于 2026-09-16 修正）。

告警通道（2026-09-16 补齐通道适配，见 §9.3）：由 `PAWSHOP_MONITOR_ALERT_PROVIDER` 指定通道类型，`PAWSHOP_MONITOR_ALERT_WEBHOOK` 指定 HTTPS 地址，两者都可选。未配置时 fail-closed：只记录 WARN，绝不假装已告警。相同告警签名 30 分钟内去重；恢复时发送一次 recovery。告警正文只含检查名、状态与指标，不含任何秘密、环境值或响应体。

**执行状态：定时器已于 2026-09-16 由 WorkBuddy 在生产主机安装并验证通过**（`pawshop-monitor.timer` enabled+active，实测 16:30:13 一次调度运行 **12/12 通过**）。以下为执行记录、验证与回滚。

### 9.1 为什么要从 `/usr/local/libexec/pawshop` 运行（2026-09-16 修正）

单元原先的 `WorkingDirectory=/srv/pawshop-commerce/current/_commerce` **永远无法满足**：该链接只在商务 release 激活后才存在，而 `releases/` 里现有的 `79a045c` 早于监控模块，**根本不含 `monitor-production.mjs`**。依赖方向是反的——监控是"商务上线前就该存在的安全网"。

同时，`pawshop-monitor.*` **不在任何安装/部署脚本的清单里**（`install-commerce-runtime.sh` 与 `deploy-commerce.sh` 都未列出它），是独立单元，因此改为从固定 libexec 目录运行**不会影响商务部署契约**。改动后 `deploy-commerce.sh` 与 `install-commerce-runtime.sh` 已同步把 `monitor-production.mjs`、`monitoring-policy.cjs` 纳入校验/安装清单，防止主机与 release 漂移。

```bash
# 主机侧（root）——已执行
git -C /srv/pawshop/source fetch --quiet origin
git -C /srv/pawshop/source checkout --quiet <目标SHA>          # 必须是已推送的提交
for s in monitor-production.mjs monitoring-policy.cjs; do
  install -o root -g root -m 0555 "/srv/pawshop/source/_commerce/scripts/$s" "/usr/local/libexec/pawshop/$s"
  cmp -s "/srv/pawshop/source/_commerce/scripts/$s" "/usr/local/libexec/pawshop/$s"
done
install -d -o root -g pawshop -m 0750 /etc/pawshop-monitor
install -d -o pawshop -g pawshop -m 0700 /var/lib/pawshop-monitor
# 写入 monitoring.env（见 §9.2），owner root:pawshop 0640
for u in pawshop-monitor.service pawshop-monitor.timer; do
  install -o root -g root -m 0644 "/srv/pawshop/source/ops/commerce/$u" "/etc/systemd/system/$u"
  cmp -s "/srv/pawshop/source/ops/commerce/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl start pawshop-monitor.service                        # 先单跑一次，确认 Result=success
systemctl enable --now pawshop-monitor.timer                   # 通过后才启用调度
```

**注意**：不要用 `ops/commerce/monitoring.env.example` 直接 `install` 成 `monitoring.env`（示例里含占位注释，且生产需要按 §9.2 增删行）；示例文件仅作字段说明。

验证：

```bash
systemctl list-timers pawshop-monitor.timer --no-pager
systemctl show pawshop-monitor.service --property=Result --property=ExecMainExitTimestamp
journalctl -u pawshop-monitor.service -n 25 --no-pager -o cat | grep -E "monitoring (passed|failed)"
cat /var/lib/pawshop-monitor/alert-state.json
```

### 9.2 上线首阶段的临时跳过（**激活商务后必须删除**）

`/etc/pawshop-monitor/monitoring.env` 当前含两行：

```ini
PAWSHOP_MONITOR_SKIP_COMMERCE_CHECKS=1
PAWSHOP_MONITOR_SKIP_SYSTEMD_CHECKS=1
```

- `SKIP_COMMERCE_CHECKS`：商务后台未激活时，`commerce_health` / `store_api_closed` / `admin_requires_auth` 三项记为"显式跳过"，**每次运行都会打一条 WARN**，检查详情也写明"skipped by explicit configuration"，避免把"跳过"误读成"已验证"。
- `SKIP_SYSTEMD_CHECKS`：备份链未启用时跳过 `backup_freshness`。

两者都是**临时状态**：商务激活并启用备份后删掉这两行，监控应变成 12/12 且全部为真实检查。**留着会掩盖真实的 commerce 宕机与备份中断。**

**回滚整个监控**：`systemctl disable --now pawshop-monitor.timer`（保留单元与配置，随时可再启用）。

日志纪律：可区分 DEBUG/INFO/WARN/ERROR；**永不**记录密码、token、完整 session、数据库 secret、客户明文。

### 9.3 告警通道适配与投递验证（2026-09-16 新增）

**为什么需要适配层**：三家聊天平台的机器人**只接受各自的消息结构**，而监控原来发的是自定义 JSON（`pawshop-monitor-alert-v1`）。直接把 URL 填进去会得到一个"看起来通了、其实一条都没送到"的告警通道：

| 通道 | 期望的请求体 | 原样发自定义 JSON 的结果 |
| --- | --- | --- |
| Slack Incoming Webhook | `{"text": "..."}` | HTTP 400 `invalid_payload` |
| 飞书自定义机器人 | `{"msg_type":"text","content":{"text":"..."}}` | **HTTP 200 + `code` 非 0**（最难发现的一种失败） |
| Telegram Bot API | `{"chat_id": ..., "text": ...}` | HTTP 400 `Bad Request` |
| 内部端点（generic） | 原始 v1 JSON | 正常（保持向后兼容） |

因此现在按 `PAWSHOP_MONITOR_ALERT_PROVIDER` 生成对应报文，并且**投递是否成功以对方确认为准**：飞书要求 `code=0`（或 v1 的 `StatusCode=0`），Telegram 要求 `ok=true`，其余以 HTTP 状态为准。**HTTP 200 但内部报错，一律判为未投递 → 退出码 2**，不会再被记成"已投递"。

每一家的 webhook 还被**钉在厂商域名上**（`hooks.slack.com` / `open.feishu.cn`、`open.larksuite.com` / `api.telegram.org`），写错或被换掉的地址会在启动时直接报错，而不是把主机状态发到别处。自定义或自建端点请用 `generic`。

**本地端到端复跑（不需要生产主机、不需要真实 URL）**

```bash
cd _commerce
npm run test:alert-delivery     # 10 项判定全绿；把上述四家的报文逐条打到收端上核对
```

该夹具会起一个真 HTTPS 接收端，按四家的真实应答（含"200 + 错误码"陷阱）回包，并用 `dns-stub.mjs` 只把厂商域名解析到本地，**webhook URL 仍保留真实域名**，所以域名钉住策略照样生效。它证明的是"方言与判定正确"，**不**证明"你的通道存在"。

**拿到真实 webhook 之后的接入步骤（生产主机，root）**

```bash
# 1) 只追加这两行（不要整份覆盖），并保持 owner/权限不变
#    PAWSHOP_MONITOR_ALERT_PROVIDER=feishu|slack|telegram|generic
#    PAWSHOP_MONITOR_ALERT_WEBHOOK=https://...
#    （telegram 另需 PAWSHOP_MONITOR_TELEGRAM_CHAT_ID=<chat id>）
install -o root -g pawshop -m 0640 monitoring.env.new /etc/pawshop-monitor/monitoring.env

# 2) 语法自检：配置错误必须在启动阶段就炸，而不是跑一轮才发现
sudo -u pawshop env $(grep -v '^#' /etc/pawshop-monitor/monitoring.env | xargs) \
  /usr/bin/node /usr/local/libexec/pawshop/monitor-production.mjs

# 3) 真实投递验证：制造一次必定失败（证书阈值不可能满足），确认对方真的收到
sudo systemctl start pawshop-monitor.service
journalctl -u pawshop-monitor.service -n 20 --no-pager -o cat | grep -E "alert webhook|monitoring (passed|failed)"
```

第 3 步要求日志出现 `alert webhook accepted the payload` **且**你在自己的频道里看到那条消息——两者缺一都不算通过（这就是"真实投递验证"）。如果日志是 `did not accept the payload (status 200)`，说明报文或通道类型不对，按 §9.3 表逐项核对。

**Webhook URL 的安全交接**：URL 等同于一个写入凭据（拿到就能往你的频道发消息），所以**不要贴到聊天里**。交付方式二选一：① 由店主在服务器上交互式写入（用 `read -s` 或编辑器，避免进 shell 历史）；② 存到本地文件后由 Agent 读取并 `scp` 上去。写入后不要 `git add`、不要截图。

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

### 10.3 首页与 sitemap（AR-9 / AR-10）

**sitemap 已于 2026-09-16 完成**（采用"保持现状 + 只补 sitemap"的方案）：新增 `sitemap.xml`，只列 apex 上的 7 个已发布页面；`robots.txt` 增加 `Sitemap:` 行；`sitemap.xml` 已加入 `ops/deploy-static.sh` 的 `public_paths`。线上实测 200、XML 合法、7 条 URL。

**`canonical` 有意未加**：10.2 完成后 `www` 已 301 到 apex，陈旧镜像（AR-8，`wesley9311.github.io/pawshop/`）也已停用返回 404，重复内容面已消失，`canonical` 成为冗余。若将来重新启用任何第二主机名或镜像，再补。

**`/` 仍保持现状**：`/` 返回 116 字节的 `index.html`（`<meta http-equiv="refresh">` 跳转到 `PawShop.html`）。`scripts/production-probe.mjs` 断言 `/` 返回 **200**，因此**不能**用 `return 301` 把 `/` 重定向走，否则标准验证会失败。

若将来要去掉这次客户端跳转，改用 `location = / { try_files /PawShop.html =404; }` 让 `/` 直接返回首页内容；此时 `/` 与 `/PawShop.html` 内容相同，必须同时补 `canonical` 明确规范 URL，并核对探测脚本与 sitemap 的语义后再发布。
