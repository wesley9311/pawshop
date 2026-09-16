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
| 生产每日 | `pawshop-backup.timer` | pg_dump→加密→`/var/backups/pawshop` + OSS `daily/` | 90 天 | ⏳ **凭据与配置已就绪并实测**；首次备份待 release（§11） |
| 月度 | `pawshop-backup-monthly.timer` | 复用最近已验证日备份 → OSS `monthly/YYYY-MM/` | 12 个月 | ⏳ 同上（WIP 保全） |
| 年度 | `pawshop-backup-yearly.timer` | 复用最近已验证日备份 → OSS `yearly/YYYY/` | 3 年 | ⏳ 同上（WIP 保全） |

**密钥纪律**：备份密钥（`backup.key`）绝不与密文同存一处；OSS 运行时凭据无删除权限；丢失密钥=旧备份不可解密。

**离线（OSS）凭据与两条闸门（2026-09-17 完成）**

- RAM 身份 `pawshop-backup-writer` + 策略 `pawshop-backup-writer-policy`：只允许在 `pawlivora-backups-us-west-1/pawshop/database-backups/*` 上 `PutObject` / `GetObject` / `GetObjectVersion`，并**显式拒绝** `DeleteObject*`、`DeleteBucket`、`PutBucketLifecycle`、`PutBucketVersioning`、`PutBucketPolicy`、`PutBucketAcl`、`PutBucketReplication`。
- 密钥**恰好一把**，写在 `/etc/pawshop-backup/backup-s3-access-key` 与 `backup-s3-secret-key`（`root:root 0600`），只由 `pawshop-backup.service` 通过 `LoadCredential` 读取。
- 两个闸门是**实测过的**，不是"填个 1"：`PAWSHOP_BACKUP_S3_VERSIONING_CONFIRMED=1`（`GetBucketVersioning` → `Status=Enabled`）、`PAWSHOP_BACKUP_S3_DELETE_DISABLED=1`（用该凭据发 `DeleteObject` → **403 AccessDenied**，且读 `?lifecycle` 同样 403）。
- **凭据自检（换密钥或新环境后跑一次）**：`ops/commerce/verify-offsite-credential.mjs`，在主机上以 root 运行。它打印四行判定（能写、能拿到版本号、能回读且内容一致、`DeleteObject` 必须 403）和一行越权检查，**不打印任何密钥**。

```bash
# 主机侧（root）。它会写入一个小对象；本凭据故意删不掉它，用管理凭据清理，
# 或加 PAWSHOP_OFFSITE_CHECK_KEEP=1 让它随 daily 层到期。
install -o root -g root -m 0555 /srv/pawshop-source/ops/commerce/verify-offsite-credential.mjs \
  /usr/local/libexec/pawshop/verify-offsite-credential.mjs
/usr/bin/node /usr/local/libexec/pawshop/verify-offsite-credential.mjs
```

**2026-09-17 实测记录**：五项全部通过（`PutObject 200` / `HeadObject 200 + versionId` / `GetObject 内容匹配` / `DeleteObject 403 AccessDenied` / 读 `?lifecycle` 403），校验对象随后用管理凭据彻底删除（HEAD 返回 404）。

**OSS 生命周期规则（2026-09-17 写入并回读核对）**：`daily/` 90 天、`monthly/` 365 天、`yearly/` 1095 天，三条各自只匹配自己的前缀；原有一条"全桶清理非当前版本（3 天）"规则予以保留，但**去掉了它的 `Expiration` 元素**——OSS 不允许前缀重叠的规则有同种动作类型（`InvalidRequest: Overlap for same action type Expiration`）。副作用：被生命周期删掉的当前版本留下的删除标记不会自动清理（零字节元数据，不影响数据与费用）。回滚素材：`/root/pawshop-offsite.env.bak-20260917` 与当时的配置导出。

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

告警通道（通道适配见 §9.3）：由 `PAWSHOP_MONITOR_ALERT_CHANNELS` 指定**多条**通道（`provider:https://…` 逗号分隔），单通道的旧写法 `PAWSHOP_MONITOR_ALERT_PROVIDER` + `PAWSHOP_MONITOR_ALERT_WEBHOOK` 仍支持。未配置时 fail-closed：只记录 WARN，绝不假装已告警。相同告警签名 30 分钟内去重；恢复时发送一次 recovery。告警正文只含检查名、状态与指标，不含任何秘密、环境值或响应体。

**执行状态：2026-09-17 已在生产接入飞书 + Slack 双通道并完成真实投递验证**（告警与恢复各一条，四条全部送达）。配置在 `/etc/pawshop-monitor/monitoring.env`（`root:pawshop 0640`），换通道只需改那一行。

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

因此现在按通道生成对应报文（`PAWSHOP_MONITOR_ALERT_CHANNELS` 里每条 `provider:URL` 自带的 provider 决定方言），并且**投递是否成功以对方确认为准**：飞书要求 `code=0`（或 v1 的 `StatusCode=0`），Telegram 要求 `ok=true`，其余以 HTTP 状态为准。**HTTP 200 但内部报错，一律判为未投递 → 退出码 2**，不会再被记成"已投递"。

每一家的 webhook 还被**钉在厂商域名上**（`hooks.slack.com` / `open.feishu.cn`、`open.larksuite.com` / `api.telegram.org`），写错或被换掉的地址会在启动时直接报错，而不是把主机状态发到别处。自定义或自建端点请用 `generic`。

**多通道（2026-09-17 新增）**

```ini
PAWSHOP_MONITOR_ALERT_CHANNELS=feishu:https://open.feishu.cn/open-apis/bot/v2/hook/XXXX,slack:https://hooks.slack.com/services/<TEAM_ID>/<BOT_ID>/<TOKEN>
```

- 告警**发往每一条通道**，**任一条被对方确认即算送达**（`exit 1`）；**全部失败**才算"告警系统坏了"（`exit 2`）。
- 只送达了一部分时，日志会**点名**没确认的通道：`alert reached 1/2 channels; no acknowledgement from: slack`。这条 WARN 是故意的：一条死掉的通道绝不能躲在另一条后面。
- 每次运行都会记录通道清单（**只有标签，没有 URL**）：`alert channels configured: feishu, slack`。
- **两种写法不能同时出现**：同时设置 `PAWSHOP_MONITOR_ALERT_CHANNELS` 与 `PAWSHOP_MONITOR_ALERT_WEBHOOK` 会在启动期直接报错（而不是猜一个）。
- 单通道的旧写法仍然支持（`PAWSHOP_MONITOR_ALERT_PROVIDER` + `PAWSHOP_MONITOR_ALERT_WEBHOOK`），用于只有一条通道的场景。
- 同一平台可以出现多次，日志里会区分：`feishu`、`feishu#2`。

**消息信封是一条不变量，不要改**（2026-09-17 实测教训）

**所有**消息（告警与恢复）都以 `[PawShop 告警]` 开头，状态写在其后：

```
[PawShop 告警] 1/12 项检查失败                <- 失败
[PawShop 告警] 已恢复: 12/12 项检查全部通过      <- 恢复
```

原因：飞书自定义机器人的"自定义关键词"过滤是**按消息正文匹配**的。实测线上群的过滤词是 `[PawShop 告警]`（含方括号），而恢复通知原来是 `[PawShop 恢复]` 开头 → **飞书返回 HTTP 200 + `code:19024 Key Words Not Found`**。后果是一种最糟的不对称：**告警永远送到、恢复永远送不到**，而且只看状态码会判成"已投递"。

所以：**改文案时，两种消息必须保留同一个前缀**。`_commerce/tests/monitoring.test.cjs` 有一条断言锁住它（`recovery must open with the envelope`）。若关键词过滤被改成别的词，**必须取自这个前缀**（`PawShop` 或 `[PawShop 告警]` 都可以）。

**本地端到端复跑（不需要生产主机、不需要真实 URL）**

```bash
cd _commerce
npm run test:alert-delivery     # 15 项判定全绿；把四家的报文逐条打到收端上核对
```

该夹具会起一个真 HTTPS 接收端，按四家的真实应答（含"200 + 错误码"陷阱）回包，并用 `dns-stub.mjs` 只把厂商域名解析到本地，**webhook URL 仍保留真实域名**，所以域名钉住策略照样生效。覆盖场景：单通道四家方言与判定、**双通道全通 / 一通一死 / 全死 / 飞书陷阱被另一条遮住**、抑制窗口，以及"两种写法同时出现必须拒绝启动"。它证明的是"方言与判定正确"，**不**证明"你的通道存在"——后者要靠下面的真实验证。

**真实投递验证（生产主机，root）**

```bash
# 1) 目标状态：/etc/pawshop-monitor/monitoring.env 里有一行
#    PAWSHOP_MONITOR_ALERT_CHANNELS=feishu:...,slack:...
#    安装时保持 root:pawshop 0640，并先备份旧文件
install -o root -g pawshop -m 0640 monitoring.env.new /etc/pawshop-monitor/monitoring.env

# 2) 覆盖项放进 root-only 文件：URL 与覆盖值都不进命令行、不进 shell 历史
cat > /root/pawshop-verify.env <<'EOF'
PAWSHOP_MONITOR_MIN_TLS_DAYS=99999
PAWSHOP_MONITOR_STATE_FILE=/var/lib/pawshop-monitor/verify-alert-state.json
EOF
chmod 0600 /root/pawshop-verify.env

# 3) 用与 systemd 单元完全相同的身份/环境跑一次（故意造一次失败）
/root/run-monitor-verification.sh /root/pawshop-verify.env; echo "exit=$? 期望 1"

# 4) 再跑一次“恢复正常”，验证恢复通知也能送达（沿用同一个 state 文件）
printf '%s\n' 'PAWSHOP_MONITOR_STATE_FILE=/var/lib/pawshop-monitor/verify-alert-state.json' \
  > /root/pawshop-verify-recover.env
/root/run-monitor-verification.sh /root/pawshop-verify-recover.env; echo "exit=$? 期望 0"

# 5) 收尾：删除覆盖文件与验证用 state（生产的 alert-state.json 全程未被触碰）
rm -f /root/pawshop-verify.env /root/pawshop-verify-recover.env \
      /var/lib/pawshop-monitor/verify-alert-state.json
```

**判定标准**：日志出现 `alert channel <label> accepted the payload`（每条通道各一行）**且**对应频道里真的看到那条消息——两者缺一都不算通过。若出现 `did not accept the payload (status 200)`，那是飞书在说正文没命中关键词（`19024`）或报文形态不对，按本节表格逐项核对。

**工具**：`ops/commerce/run-monitor-verification.sh`。它以 `setpriv --reuid=pawshop --regid=pawshop` 运行，所以身份、环境与定时器里那次运行一致；额外覆盖来自命令行给出的 root-only env 文件。**不要**为了验证把 URL 拼进命令行——那会同时进 `ps` 和 shell 历史。

**2026-09-17 实测记录**：飞书 + Slack 双通道，告警与恢复各一条，**四条全部送达**（日志四行 `accepted`，店主在群里看到），随后现场清理完毕；验证用的 state 与生产 state 分离。

**接入后的运维注意**

- 恢复通知也会进群（`[PawShop 告警] 已恢复: …`），这是有意的：让你知道"已经好了"，而不是只有坏消息。
- 30 分钟去重窗口按告警签名生效，**去重状态在各通道之间共享**，所以不会出现"飞书收到一次、Slack 又收到一次"的重复投递。
- **Webhook URL 的安全交接**：URL 等同于一个写入凭据（拿到就能往你的频道发消息），所以**不要贴到聊天里**，也**不需要店主交出任何账号**（账号权限远大于一条群机器人 URL，代价不成比例）。交付方式三选一：① 店主在本机复制到剪贴板后由 Agent 用 `pbpaste` 读取（读完清空剪贴板，URL 不落地）；② 存到本地文件后由 Agent 读取、`scp` 上去并删除本地文件；③ 店主自己在服务器上交互式写入（用 `read -s` 或编辑器，避免进 shell 历史）。写入后不要 `git add`、不要截图。详见 `docs/OWNER_ACTIONS_ZH.md` §1.4。

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

## 11. 商务后台激活序列（关键路径，生产主机，root）

**顺序是设计强制的，不要跳步。** `run-first-production-backup-restore.sh` 只接受"**已迁移、未激活**"状态（`/srv/pawshop-commerce/current` 必须不存在、`pawshop-commerce.service` 必须没在跑、且 `migration.json` 已存在），并要求先产出一份通过「离线精确版本回读 + 隔离恢复演练」的加密备份，**之后**才允许激活。

**前置：待批准的提交必须先推送。** 主机的 `git fetch` 是**匿名**的，且 `run-first-production-migration.sh` / `run-first-production-backup-restore.sh` 都要求 `/srv/pawshop-source` 正好停在 release 提交上（`git rev-parse HEAD` == release ID，且工作树干净）。所以：

```bash
# 0) 主机取到目标提交（在 Agent 机器上先推送；主机侧 root）
git -C /srv/pawshop/source fetch --quiet origin
git -C /srv/pawshop-source fetch --quiet origin
git -C /srv/pawshop-source checkout --quiet <RELEASE_SHA>    # 必须是已推送的提交
git -C /srv/pawshop-source status --porcelain                # 必须为空
```

> ⚠️ **`79a045c` 用不了**：它里面没有 `write-production-backup-restore-evidence.mjs`（首次备份的证据写入器是后来才加的），所以必须准备一个**新** release。

```bash
# 1) 准备不可变 release（产出 release ID 与内容摘要）
bash /srv/pawshop-source/ops/commerce/prepare-commerce-release.sh <RELEASE_SHA>
#    记下输出里的 RELEASE_ID 与 RELEASE_CONTENT_SHA256

# 2) 首次数据库迁移（产出 /var/lib/pawshop-release-evidence/<sha>/migration.json）
PAWSHOP_RELEASE_ID=<RELEASE_SHA> PAWSHOP_FIRST_MIGRATION_CONFIRMED=1 \
  bash /srv/pawshop-source/ops/commerce/run-first-production-migration.sh

# 3) 首次加密备份 + 离线回读 + 隔离恢复演练（产出 backup-restore.json）
PAWSHOP_FIRST_BACKUP_RESTORE_CONFIRMED=1 \
  bash /srv/pawshop-source/ops/commerce/run-first-production-backup-restore.sh \
  <RELEASE_SHA> <RELEASE_CONTENT_SHA256>

# 4) 只有 3 成功后才允许激活
bash /srv/pawshop-source/ops/commerce/deploy-commerce.sh <RELEASE_SHA> <RELEASE_CONTENT_SHA256>

# 5) 激活后：删掉监控里那两行临时跳过，让 12 项检查全部变成真实检查
#    删 PAWSHOP_MONITOR_SKIP_COMMERCE_CHECKS 与 PAWSHOP_MONITOR_SKIP_SYSTEMD_CHECKS
#    （见 §9.2），然后启用备份定时器
systemctl enable --now pawshop-backup.timer
systemctl list-timers 'pawshop-*' --no-pager
```

**第 3 步会真正验证备份链**：它跑真实备份 → `sync-production-backups.mjs` 用 `LoadCredential` 注入的凭据上传到 `oss://pawlivora-backups-us-west-1/pawshop/database-backups/daily/` → 精确版本回读比对摘要 → 再把密文恢复到一次性隔离集群并核对。任何一步失败都不会留下"以为有备份"的状态。

**已知会留在桶里的无害对象**：`pawshop/database-backups/daily/.pawshop-credential-check.txt`（约 28 字节，`ops/commerce/verify-offsite-credential.mjs` 自检时写入）。写入它的凭据**故意没有删除权限**（这正是被验证的能力），所以它会随 `daily/` 的 90 天规则自然到期；想立刻清掉就用管理凭据删。

**回滚**：`ops/commerce/rollback-commerce.sh`（切换 `current` 并重启）；监控与告警不依赖 commerce，激活失败不会影响站点与监控。
