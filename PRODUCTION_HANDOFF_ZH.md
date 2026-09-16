# PawShop 生产环境交付与查找手册

更新日期：2026-09-16（WorkBuddy 第五轮，按主机实测重写）

这份文件是店主与 Codex 查看 PawShop 架构、数据位置、备份、部署和验收状态的**总索引**。
它可以提交到 GitHub，因为这里只记录路径、责任边界和操作入口，不记录密码、
AccessKey、客户明文、供应商隐私资料或支付凭据。

> **重要前提**：仓库里的文档是"意图与约定"，**服务器上的实际状态必须用只读命令验证**。
> 本文件已于 2026-09-16 按主机实测逐条核对；与上一版相比修正了多处路径漂移
> （上一版只描述了商务树，完全没有记录展示站那棵树）。发现文档与实测不一致时，
> **以实测为准，并回来改本文件**。

## 1. 先看哪里

| 想了解的内容 | 查阅入口 |
| --- | --- |
| **接下来还有哪些没做完、按什么顺序做** | `docs/REMAINING_WORK.md` |
| **只有店主本人能做的事（链接、点击步骤、交付方式）** | `docs/OWNER_ACTIONS_ZH.md` |
| 网站目前能做什么、哪些功能仍关闭 | `README.md` |
| 可执行的生产命令（发布/回滚/改 nginx/门禁） | `docs/RUNBOOK.md` |
| 对抗审查发现与处置（AR-1 ~ AR-15） | `docs/ADVERSARIAL_REVIEW.md` |
| 门禁结论与风险登记（RISK-1 ~ RISK-11） | `docs/RELEASE_GATES.md` |
| 每轮建设与真实验证结果 | `docs/WORKBUDDY_COMPLETION_REPORT.md` |
| 商务后台操作命令 | `_commerce/OPERATIONS_ZH.md` |
| 商务后台建设状态 | `_commerce/STATUS.md` |
| 旧站数据保留和迁移边界 | `MIGRATION_STATUS.md` |
| 上线前业务、物流、支付和隐私门槛 | `LAUNCH_READINESS.md` |
| **服务器、OSS、数据和凭据分别在哪里** | **本文件 §3** |

## 2. 当前真实状态（2026-09-16 实测）

### 已经做到

- 公开站点 `https://pawlivora.com` 是**不可交易的商品展示站**，线上 release `6dce5a4`。
- 客户注册、购物车、下单、支付和公开客户信息收集**仍然关闭**。
- **传输安全已补齐**：HSTS `max-age=15552000`，`www` 301 到 apex，`/admin.html` 等
  内部页仍是 404（跳转不会绕过路由门禁）。`verify:production:strict` 通过。
- **SEO 基础已补**：`sitemap.xml` 上线且为合法 XML（7 条 URL），`robots.txt` 已声明。
- **生产监控已上线并运行**：`pawshop-monitor.timer` 每 5 分钟跑一次，实测
  **12/12 通过**，状态文件 `/var/lib/pawshop-monitor/alert-state.json`。
- 陈旧 GitHub Pages 镜像已停用（返回 404），仓库本体仍为 PUBLIC。
- 服务器为阿里云美国（硅谷）2 GB，已装 Node 22、PostgreSQL 17、Redis、Nginx 1.24.0。
- 商品图片桶 `pawlivora-products-us-west-1` 已在商品媒体链路中；数据库备份桶
  `pawlivora-backups-us-west-1` 已建为私有桶并开启版本控制。

### 还没有做到（详见 `docs/REMAINING_WORK.md`）

- **加密备份链没有在跑**：`pawshop-backup.timer` 为 `disabled`，且即使启用也会因
  四处硬阻塞而失败（§3.4）。**当前生产库没有任何加密备份。**
- **商务后台尚未首次激活**：`/srv/pawshop-commerce/current` 不存在；店主管理员凭据
  文件 `/root/pawshop-production-owner-credentials.json` **不存在**。
- **生产库 `pawshop` 已创建但是空的**：`public` schema **0 张表**，首次迁移从未执行。
  所以目前确实**没有可丢的业务数据**。
- **告警 webhook 仍未配置**：监控目前是 **log-only**，失败只写 journal 与本地 state，不会主动通知任何人。
  适配层已于 2026-09-16 补齐（飞书/Slack/Telegram/generic 四家方言 + 厂商域名钉住 + "HTTP 200 但内部报错=未投递"判定，
  端到端实测 10/10 通过，`cd _commerce && npm run test:alert-delivery` 可复跑），**只差店主提供 URL**——
  获取步骤见 `docs/OWNER_ACTIONS_ZH.md` §1，接入与验证见 `docs/RUNBOOK.md` §9.3。
- 监控里有两项**临时跳过**（commerce 三项 + 备份新鲜度），commerce 激活后必须去掉。
- OSS 三条生命周期规则、异地备份配置、生产定时器仍未最终落地。

因此，当前**不存在真实顾客订单数据**，也不能把"服务器已安装"理解为"已经可以收款营业"。

## 3. 代码、运行时和数据路径

### 3.1 店主 Mac

| 内容 | 路径 |
| --- | --- |
| PawShop Git 工作区 | `/Users/zhaoxiaomin/VScode/pawshop` |
| 本地后台私人目录 | `/Users/zhaoxiaomin/Documents/PawShop_Private/development` |
| 本地 PostgreSQL 数据 | `.../development/postgres-17` |
| 本地加密备份 | `.../development/backups` |
| 本地备份加密密钥 | `.../development/backup.key` |
| 本地后台账号文件 | `.../development/local-admin.txt` |
| 生产 SSH 私钥 | `~/.ssh/pawshop_aliyun_ed25519`（comment `pawshop-production-2026-09`） |

`PawShop_Private` 不能提交 GitHub、上传网盘或发到聊天中。查看凭据时只在自己的
电脑上打开，避免截图和屏幕共享。

### 3.2 服务器上有**两棵互不相干**的源码树（上一版文档漏了这一节）

这是最容易搞错的地方。展示站与商务后台**各有自己的一棵树、自己的发布目录**：

| 用途 | 生产源码（git 检出） | 发布目录 | 当前链接 | 部署脚本 |
| --- | --- | --- | --- | --- |
| **展示站**（现状重点） | `/srv/pawshop/source` | `/srv/pawshop/releases/<40位SHA>` | `/srv/pawshop/current` | `ops/deploy-static.sh` |
| **商务后台**（未激活） | `/srv/pawshop-source` | `/srv/pawshop-commerce/releases/<40位SHA>` | `/srv/pawshop-commerce/current`（**不存在**） | `ops/commerce/deploy-commerce.sh` |

- 两棵树的 origin 都是 `https://github.com/wesley9311/pawshop.git`，**匿名 fetch**
  （主机没有 credential helper，也没有 `/root/.git-credentials`）。
  → 因此把仓库**转为私有会立刻打断发布链**，需先部署 token。
- `deploy-static.sh` 要求源码树**正好在目标 SHA 且工作树干净**，用 `git archive`
  白名单打包 → 原子切换 `current` → `nginx -t` → reload → 边界探测，任一步失败自动回滚。
- 发布白名单**拒绝** `admin.html` / `dashboard.html` / `account.html` / `_commerce` /
  `.env` 进入 release，也拒绝符号链接。
- 多个商务脚本**硬编码** `/srv/pawshop-commerce/releases/<sha>`（如
  `create-production-owner.mjs`、`verify-tracked-release.mjs`），这是被强制的约定，
  不要改动它。

### 3.3 展示站运行时与配置

| 内容 | 生产路径 | 说明 |
| --- | --- | --- |
| Nginx 站点配置 | `/etc/nginx/sites-available/pawshop` | 已软链到 `sites-enabled/`；HSTS 与 www→apex 在此 |
| Nginx 备份 | `/root/pawshop-nginx-pawshop.bak-<UTC时间>` | 每次改配置前 `cp -a` 留档 |
| TLS 证书 | `/etc/letsencrypt/live/pawlivora.com/` | SAN 含 apex + www；`certbot.timer` 自动续期 |
| 生产监控配置 | `/etc/pawshop-monitor/monitoring.env` | `root:pawshop 0640`；不含秘密（webhook 除外） |
| 监控脚本（发布无关） | `/usr/local/libexec/pawshop/monitor-production.mjs`、`monitoring-policy.cjs` | `root:root 0555` |
| 监控告警状态 | `/var/lib/pawshop-monitor/alert-state.json` | `pawshop:pawshop 0700` 目录；告警抑制用 |
| systemd 单元 | `/etc/systemd/system/pawshop-*.service`、`pawshop-monitor.timer` | 见 §3.4 |

**监控为什么放在 libexec 而不是 release 里**：监控是"商务后台还没上线时就必须存在"的
安全网。它原先指向 `/srv/pawshop-commerce/current/_commerce`，而该链接只有在商务
release 激活后才存在——依赖方向是反的，所以 2026-09-16 改为从固定的 libexec 目录运行。
`pawshop-monitor.*` 不在任何安装/部署脚本的清单里，是**独立单元**，因此这个改动
不会影响商务部署契约。

### 3.4 商务后台运行时（**尚未激活**）

| 内容 | 生产路径 | 实测状态 |
| --- | --- | --- |
| Medusa 私有运行目录 | `/var/lib/pawshop` | 存在 |
| PostgreSQL 生产库 | 库名 `pawshop`，仅 `127.0.0.1:5432` | **存在但 0 张表** |
| 实际在跑的 PostgreSQL 单元 | `postgresql@17-main.service` | active；注意 meta 单元 `postgresql.service` 是 inactive |
| 商务环境配置 | `/etc/pawshop/commerce.env` | 存在，`root:pawshop 0640` |
| 内部秘密 | `/etc/pawshop/internal-secrets.env` | 存在 |
| 商品媒体 OSS 凭据 | `/etc/pawshop/oss-access-key-id`、`oss-secret-access-key` | 存在，`0600 root` |
| Redis | `127.0.0.1:6379` | active，需认证 |
| 备份配置 | `/etc/pawshop-backup/backup.env` | 存在（仅只读库连接等非秘密项） |
| 备份密钥 | `/etc/pawshop-backup/backup.key` | 存在；**绝不上传 OSS，丢失后旧备份无法解密** |
| 异地备份配置 | `/etc/pawshop-backup/backup-offsite.env` | **缺失** |
| 备份 OSS 凭据 | `/etc/pawshop-backup/backup-s3-access-key`、`backup-s3-secret-key` | **缺失** |
| 本地备份目录 | `/var/backups/pawshop` | 存在，`pawshop-backup:pawshop-backup 0700` |
| 首次管理员凭据 | `/root/pawshop-production-owner-credentials.json` | **缺失**（后台未激活） |
| 发布验收证据 | `/var/lib/pawshop-release-evidence/<sha>` | **缺失** |

**启用备份前必须先解决的四处阻塞**（否则 `pawshop-backup.service` 必然失败）：

1. 单元 `WorkingDirectory=/srv/pawshop-commerce/current/_commerce` —— 该链接不存在；
2. `/etc/pawshop-backup/backup-offsite.env` 缺失；
3. `LoadCredential` 所需的两个 `backup-s3-*` 文件缺失；
4. 单元 `Requires=postgresql.service`，而该 meta 单元是 `inactive`（真正在跑的是
   `postgresql@17-main.service`）。

不得用文件管理器批量复制 PostgreSQL 数据目录，也不得手工修改 `commerce.env` 中的
单个密码而不同步关联服务。所有变更应通过审查过的脚本完成。

### 3.5 OSS 对象存储

| Bucket | 用途 | 对象路径 |
| --- | --- | --- |
| `pawlivora-products-us-west-1` | 商品图片 | 由商品媒体服务生成和管理 |
| `pawlivora-backups-us-west-1` | 每日加密备份 | `pawshop/database-backups/daily/` |
| `pawlivora-backups-us-west-1` | 每月归档 | `pawshop/database-backups/monthly/YYYY-MM/` |
| `pawlivora-backups-us-west-1` | 每年归档 | `pawshop/database-backups/yearly/YYYY/` |

远端备份包含两类文件：

- `pawshop_production_<UTC时间>.dump.enc`：AES-256 加密的完整数据库备份；
- `pawshop_production_<UTC时间>.manifest.json`：文件大小、哈希和认证信息，不含业务明文。

服务器还会在 `/var/backups/pawshop/latest.json` 记录最新备份指针，并为成功上传和
精确版本回读的对象保存本地签名收据。运行时备份账号不得拥有删除对象、删除版本、
修改生命周期或修改 Bucket 策略的权限。

### 3.6 阿里云 RAM 收口现状（2026-09-16）

- 旧的 OSS AccessKey 已确认禁用并移入回收站；
- 新的 OSS AccessKey 保持启用，且此前已通过真实写入/读取/删除测试；
- **没有**永久清空回收站，仍保留可恢复边界。

## 4. 顾客隐私会不会进入备份

会。正式开放客户注册和下单后，为了能够完整恢复订单，数据库备份必然包含当时数据库
中的客户和订单信息，例如姓名、邮箱、收货地址、电话（如果结账确实需要）、订单商品、
金额、物流状态和支付服务商返回的交易标识。

这不代表 PawShop 可以无限期保存所有资料。应遵守以下边界：

1. 结账页面只收集履约、客服、风控和法定义务真正需要的字段。
2. PawShop 不保存完整银行卡号、CVV 或支付账户密码；敏感支付信息由合规支付服务商处理。
3. 生产数据库只允许本机后台服务通过专用账号访问，管理后台通过 SSH 隧道访问。
4. 本地和 OSS 数据库备份都必须先加密；解密密钥不上传到同一个 OSS Bucket。
5. 隔离恢复数据库仅用于验证，验证结束后删除，不额外积累客户明文副本。
6. 客户查询、更正、导出和删除流程在开放收集前必须完成；订单和财税记录如依法需要
   保留，应与可删除的营销/账户资料分开处理。
7. 备份过期删除应使用分层策略，不能只保留一条会清空所有历史的规则。

当前后台的客户和订单接口仍关闭，真实生产库也尚未开始收集顾客资料。

## 5. 建议的分层保留策略

| 层级 | 建议保留 | 状态 |
| --- | --- | --- |
| 每日加密备份 | 90 天滚动 | 独立前缀和定时任务已实现；**OSS 生命周期待提交；定时器未启用** |
| 每月完整快照 | 12 个月 | 独立前缀和断电补跑定时任务已实现；**同上** |
| 年度完整快照 | 暂定 3 年 | 独立前缀和断电补跑定时任务已实现；**同上** |

月度和年度任务复用最近一份已加密、已认证的日备份，不会额外生成明文或重复执行
`pg_dump`；同一月份或年份的重跑只核验已记录的精确 OSS 版本。三条生命周期规则必须
只匹配各自前缀，禁止创建覆盖整个 Bucket 的 90 天删除规则。数据库规模和费用应每月检查；
不能为了省钱牺牲最低恢复能力，也不能无依据地永久保存客户隐私。

## 6. 出现问题时先查什么

| 问题 | 第一检查点 | 第二检查点 |
| --- | --- | --- |
| 网站打不开 | `systemctl is-active nginx`；`verify:production` | DNS 解析、`/srv/pawshop/current` 指向、服务器负载 |
| 安全头/HSTS 丢失 | `verify:production:strict` | `/etc/nginx/sites-available/pawshop`；`nginx -t` |
| `www` 不再跳转 apex | `verify:production:strict` | nginx 里的 `if ($host = www...)` 是否仍在 |
| **想知道主机有没有出事** | `journalctl -u pawshop-monitor.service -n 50` | `/var/lib/pawshop-monitor/alert-state.json` |
| 监控报告失败 | journal 里的 `check <name> failed (…)` | 按失败项查对应系统；注意两项 skip 是临时状态 |
| **告警收不到，日志说 `did not accept…`** | `monitoring.env` 里 `PAWSHOP_MONITOR_ALERT_PROVIDER` 是否与 webhook 站点匹配 | 按 `docs/RUNBOOK.md` §9.3 的方言表逐项核对；四家方言可本地复跑验证 |
| **告警整轮没发但检查确实失败** | journal 里是否写着 `alert suppressed by the repeat window` | 那是 30 分钟去重窗口的**刻意静默**，不是故障；状态见 `/var/lib/pawshop-monitor/alert-state.json` |
| 监控没在跑 | `systemctl list-timers pawshop-monitor.timer` | `systemctl is-enabled pawshop-monitor.timer` |
| 后台打不开 | SSH 隧道、`pawshop-commerce.service` | Medusa 日志与回环端口；**先确认 `current` 链接是否存在** |
| 商品图片失败 | 商品媒体 Bucket 和 RAM 权限 | `/etc/pawshop/commerce.env` 配置 |
| 每日备份失败 | `pawshop-backup.service` 状态 | **先查 §3.4 的四处阻塞**；再看 `/var/backups/pawshop` |
| OSS 没有新备份 | 异地配置和 systemd credential | OSS 版本控制、权限与网络 |
| 数据恢复失败 | manifest/HMAC/密文三者是否匹配 | 隔离恢复服务和磁盘空间 |
| 发布失败 | `/srv/pawshop/releases/` 里的上一版是否仍在 | `readlink -f /srv/pawshop/current` |
| 数据疑似误删 | 立即停止写操作并保存证据 | 先恢复到隔离库，禁止直接覆盖生产库 |
| 支付对账不一致 | 支付服务商交易记录和 webhook | PawShop 订单事件和人工对账记录 |
| **站点内容与仓库不一致** | 主机 `/srv/pawshop/source` 的 `git rev-parse HEAD` | 与 `readlink -f /srv/pawshop/current` 对比；按 §5 做逐文件 sha256 比对 |

排错时不得把生产环境文件、数据库导出、AccessKey、客户行记录或完整日志粘贴到聊天。
先做脱敏摘要；确需检查时在服务器上运行最小范围只读命令。

## 7. 正式验收必须留下什么

上线完成后，本文件和 `_commerce/STATUS.md` 应记录以下结果，但不记录秘密和客户明文：

- 已部署的完整 Git commit（展示站与商务**各自**的）；
- 生产服务、监听地址、开机自启和资源占用；
- 数据库首次迁移结果；
- 首份加密备份的时间、哈希证据和 OSS 精确版本回读结果；
- 隔离恢复成功、关键表数量核对和临时恢复库已删除；
- 店主真实登录以及商品、订单、客户管理页面验收；
- 商品草稿上传、图片持久化和发布前审批结果；
- 公共注册、购物车、下单和支付仍关闭或已按哪一份批准单独开放；
- 支付成功、失败、取消、重复 webhook、退款和对账测试；
- 物流、税费、退货地址、隐私条款、客服与事件响应责任人；
- 域名、服务器、OSS、RAM、支付和邮件等外部账号的归属与恢复方式；
- **监控告警通道已接通并做过一次真实投递验证**（当前仍缺，见 §2）。

最终交付不是一张"完成"截图，而是代码版本、可复现命令、服务器实际证据、恢复演练、
店主验收和后续维护入口组成的闭环。

## 8. 店主应保管的私密交付物

店主需要在自己的密码管理器中保存以下条目，不放入本文件：

- 阿里云主账号与 MFA 恢复方式；
- 服务器登录凭据或 SSH 私钥；
- PawShop 生产管理员账号和恢复方式；
- OSS 商品媒体与备份 RAM 身份的用途、AccessKey ID、Secret 和轮换日期；
- 支付服务商、域名注册商、企业邮箱和社交平台账号；
- 数据库/Redis/备份密钥的离线恢复副本位置；
- 经营主体、物流、退货地址和客服负责人的有效资料。

Codex 可以继续维护代码和运行手册，但不能替代店主对账号归属、MFA、离线恢复材料、
支付结算和真实客户数据处理责任的控制。
