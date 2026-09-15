# PawShop 生产环境交付与查找手册

更新日期：2026-09-15

这份文件是店主查看 PawShop 架构、数据位置、备份、部署和验收状态的总索引。
它可以提交到 GitHub，因为这里只记录路径、责任边界和操作入口，不记录密码、
AccessKey、客户明文、供应商隐私资料或支付凭据。

## 1. 先看哪里

| 想了解的内容 | 查阅入口 |
| --- | --- |
| 网站目前能做什么、哪些功能仍关闭 | `README.md` |
| 生产环境和后台的详细操作命令 | `_commerce/OPERATIONS_ZH.md` |
| 每轮建设和真实验证结果 | `_commerce/STATUS.md` |
| 旧站数据保留和迁移边界 | `MIGRATION_STATUS.md` |
| 上线前业务、物流、支付和隐私门槛 | `LAUNCH_READINESS.md` |
| 服务器、OSS、数据和凭据分别在哪里 | 本文件 |

代码仓库中的说明是长期可追踪记录；服务器上的实际状态仍必须通过只读检查验证，
不能只凭文档推断服务已经启用。

## 2. 当前真实状态

- 公开站点 `https://pawlivora.com` 仍是不可交易的商品展示站。
- 客户注册、购物车、下单、支付和公开客户信息收集仍然关闭。
- 阿里云美国（硅谷）服务器已经升级为 2 GB，并安装了 Node 22、PostgreSQL 17、
  Redis 和现有 Nginx；商务后台尚未完成首次生产激活。
- 商品图片桶 `pawlivora-products-us-west-1` 已投入商品媒体链路。
- 数据库备份桶 `pawlivora-backups-us-west-1` 已创建为私有桶并开启版本控制。
- 每日备份保留 90 天的生命周期规则尚未提交；月度 12 个月和年度 3 年归档尚未实现。
- 专用备份 RAM 用户和 AccessKey 尚未最终创建、授权和写入服务器。
- 生产数据库首次迁移、首次加密备份、OSS 精确版本回读、隔离恢复和后台登录验收
  尚未全部完成。

因此，当前不存在真实顾客订单数据需要迁移，也不能把“服务器已安装”理解为
“已经可以收款营业”。

## 3. 代码、运行时和数据路径

### 店主 Mac

| 内容 | 路径 |
| --- | --- |
| PawShop Git 工作区 | `/Users/zhaoxiaomin/VScode/pawshop` |
| 本地后台私人目录 | `/Users/zhaoxiaomin/Documents/PawShop_Private/development` |
| 本地 PostgreSQL 数据 | `.../development/postgres-17` |
| 本地加密备份 | `.../development/backups` |
| 本地备份加密密钥 | `.../development/backup.key` |
| 本地后台账号文件 | `.../development/local-admin.txt` |

`PawShop_Private` 不能提交 GitHub、上传网盘或发到聊天中。查看凭据时只在自己的
电脑上打开，避免截图和屏幕共享。

### GitHub 与代码

GitHub 只保存程序、公开商品资料、模板、测试和不含秘密的运维文档。以下内容不得
进入 Git：生产密码、数据库内容、客户资料、身份证件、支付密钥、OSS Secret、
备份密钥、供应商成本和未公开物流报价。

生产代码从 `/srv/pawshop-source` 的干净完整 Git commit 构建，不直接从店主电脑的
未提交工作区发布。

### 阿里云生产服务器

| 内容 | 生产路径 | 说明 |
| --- | --- | --- |
| 固定生产源码 | `/srv/pawshop-source` | root 管理的干净 Git 源码 |
| 不可变发布版本 | `/srv/pawshop-commerce/releases/<完整 commit>` | 每个版本独立保留 |
| 当前运行版本链接 | `/srv/pawshop-commerce/current` | 原子切换和回滚入口 |
| Medusa 私有运行目录 | `/var/lib/pawshop` | 无特权服务账号使用 |
| PostgreSQL 生产库 | 数据库名 `pawshop`，仅 `127.0.0.1:5432` | 通过 PostgreSQL 访问，不手工修改数据文件 |
| PostgreSQL 系统数据目录 | 通常为 `/var/lib/postgresql/17/main` | 上线验收时再次核对实际配置 |
| 生产环境配置 | `/etc/pawshop/commerce.env` | `root:pawshop 0640`，含秘密，不可直接复制 |
| 内部秘密源文件 | `/etc/pawshop/internal-secrets.env` | 数据库、Redis、JWT、Cookie 秘密 |
| 商品媒体 OSS 凭据 | `/etc/pawshop/oss-access-key-id`、`/etc/pawshop/oss-secret-access-key` | root-only |
| 生产加密备份 | `/var/backups/pawshop` | `pawshop-backup` 私有目录，权限 0700 |
| 备份配置 | `/etc/pawshop-backup/backup.env` | 只读数据库账号连接信息 |
| 异地备份配置 | `/etc/pawshop-backup/backup-offsite.env` | 只含非秘密的桶和保留策略设置 |
| 数据库备份密钥 | `/etc/pawshop-backup/backup.key` | 绝不上传 OSS；丢失后旧备份无法解密 |
| 备份 OSS AccessKey | `/etc/pawshop-backup/backup-s3-access-key` | root-only，通过 systemd 临时注入 |
| 备份 OSS Secret | `/etc/pawshop-backup/backup-s3-secret-key` | root-only，通过 systemd 临时注入 |
| 首次管理员凭据 | `/root/pawshop-production-owner-credentials.json` | 0600，只在服务器私有终端查看 |
| 发布验收证据 | `/var/lib/pawshop-release-evidence/<完整 commit>` | 不含客户明文的迁移/恢复证据 |
| 隔离恢复工作区 | `/var/lib/pawshop-restore` | 验证完成后删除临时恢复数据库 |

不得用文件管理器批量复制 PostgreSQL 数据目录，也不得手工修改 `commerce.env` 中的
单个密码而不同步关联服务。所有变更应通过审查过的脚本完成。

### OSS 对象存储

| Bucket | 用途 | 对象路径 |
| --- | --- | --- |
| `pawlivora-products-us-west-1` | 商品图片 | 由商品媒体服务生成和管理 |
| `pawlivora-backups-us-west-1` | 加密数据库备份 | `pawshop/database-backups/` |

远端备份包含两类文件：

- `pawshop_production_<UTC时间>.dump.enc`：AES-256 加密的完整数据库备份；
- `pawshop_production_<UTC时间>.manifest.json`：文件大小、哈希和认证信息，不含业务明文。

服务器还会在 `/var/backups/pawshop/latest.json` 记录最新备份指针，并为成功上传和
精确版本回读的对象保存本地签名收据。运行时备份账号不得拥有删除对象、删除版本、
修改生命周期或修改 Bucket 策略的权限。

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
| 每日加密备份 | 90 天滚动 | 脚本已具备每日备份；OSS 生命周期尚未提交 |
| 月末完整快照 | 12 个月 | 待实现 |
| 年度完整快照 | 暂定 3 年 | 待经营主体、税务和销售地区要求明确后实现 |

每日 90 天规则只应清理每日备份。月度和年度快照必须放在可区分的前缀或使用独立标签，
避免被每日规则同时删除。数据库规模和费用应每月检查；不能为了省钱牺牲最低恢复能力，
也不能无依据地永久保存客户隐私。

## 6. 出现问题时先查什么

| 问题 | 第一检查点 | 第二检查点 |
| --- | --- | --- |
| 网站打不开 | Nginx 与 HTTPS 生产验证 | DNS、服务器和代理路径 |
| 后台打不开 | SSH 隧道、`pawshop-commerce.service` | Medusa 日志与回环端口 |
| 商品图片失败 | 商品媒体 Bucket 和 RAM 权限 | `/etc/pawshop/commerce.env` 配置 |
| 每日备份失败 | `pawshop-backup.service` 状态 | `/var/backups/pawshop` 与备份日志 |
| OSS 没有新备份 | 异地配置和 systemd credential | OSS 版本控制、权限与网络 |
| 数据恢复失败 | manifest/HMAC/密文三者是否匹配 | 隔离恢复服务和磁盘空间 |
| 发布失败 | `/var/lib/pawshop-release-evidence/<commit>` | 当前链接与保留的上一版本 |
| 数据疑似误删 | 立即停止写操作并保存证据 | 先恢复到隔离库，禁止直接覆盖生产库 |
| 支付对账不一致 | 支付服务商交易记录和 webhook | PawShop 订单事件和人工对账记录 |

排错时不得把生产环境文件、数据库导出、AccessKey、客户行记录或完整日志粘贴到聊天。
先做脱敏摘要；确需检查时在服务器上运行最小范围只读命令。

## 7. 正式验收必须留下什么

上线完成后，本文件和 `_commerce/STATUS.md` 应记录以下结果，但不记录秘密和客户明文：

- 已部署的完整 Git commit；
- 生产服务、监听地址、开机自启和资源占用；
- 数据库首次迁移结果；
- 首份加密备份的时间、哈希证据和 OSS 精确版本回读结果；
- 隔离恢复成功、关键表数量核对和临时恢复库已删除；
- 店主真实登录以及商品、订单、客户管理页面验收；
- 商品草稿上传、图片持久化和发布前审批结果；
- 公共注册、购物车、下单和支付仍关闭或已按哪一份批准单独开放；
- 支付成功、失败、取消、重复 webhook、退款和对账测试；
- 物流、税费、退货地址、隐私条款、客服与事件响应责任人；
- 域名、服务器、OSS、RAM、支付和邮件等外部账号的归属与恢复方式。

最终交付不是一张“完成”截图，而是代码版本、可复现命令、服务器实际证据、恢复演练、
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
