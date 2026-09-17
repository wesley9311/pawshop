# PawShop 本地后台真实运营手册

本手册只适用于当前真实的本机运营环境。这里没有演示用户、假订单、模拟支付或示例商品。

## 安全边界

- 后台与数据库只监听 `127.0.0.1`，其他设备不能访问。
- 当前真实商品保持 `Draft`，公开前台不连接后台。
- 客户注册、购物车、订单和收款接口仍然关闭。
- 管理员密码、数据库密钥、加密备份和验证记录位于仓库外的私人目录。
- 不把供应商成本、物流内部报价、证件或未来客户资料提交到 GitHub。

## 启动并登录

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm --prefix _commerce run setup:local
npm --prefix _commerce run dev
```

打开 `http://127.0.0.1:9000/app`，使用私人目录中 `local-admin.txt` 保存的店主账号登录。不要截图或复制凭证到聊天、GitHub、客服消息中。

## 当前商品验收

后台应当只看到一个未发布商品：

- SKU：`PAW-CSL-NG-001`
- 售价：USD 29.90
- 图片：9 张
- 状态：Draft

每次修改后运行：

```bash
npm --prefix _commerce run catalog:verify
npm --prefix _commerce run foundation:verify
```

任何一项失败时不要发布商品，也不要连接公开前台。

## 真实加密备份与恢复核验

```bash
npm --prefix _commerce run backup:real
npm --prefix _commerce run restore:verify-real
```

第一条命令从正在使用的 `pawshop_dev` 数据库生成经过 HMAC 完整性认证的 AES-256 加密备份；它不会因为以后增加商品、客户、订单或管理员而拒绝备份。商品是否可以发布仍由 `catalog:verify` 独立判断。

第二条命令把备份真实恢复到临时独立数据库，逐表核对关键商品、价格、图片、管理员、客户和订单数据，写入不含明文业务数据的验证记录，然后默认删除临时数据库，避免营业后累积客户隐私副本。仅在排错确有需要时，才可显式设置 `PAWSHOP_KEEP_RESTORE_DB=1` 保留恢复库，并在排错后删除。

备份密钥只会在第一次、且尚无加密备份时生成；如果已有备份但密钥丢失，命令会硬性失败，不会静默生成一把无法解密旧备份的新密钥。密钥与备份在同一台电脑上仍不能替代异地备份；生产上线前必须增加独立设备或受控对象存储副本，并单独保管密钥恢复材料。

## 停止服务

开发后台在终端运行时按 `Control-C` 停止。PostgreSQL 当前不会自动随系统启动；需要停止时使用私人目录中的实际数据目录：

```bash
/opt/homebrew/opt/postgresql@17/bin/pg_ctl \
  -D "$HOME/Documents/PawShop_Private/development/postgres-17" stop
```

停止前先完成真实备份。不要手动删除数据库目录或备份文件。

## 生产 Ubuntu 服务（尚未启用）

首发采用原生 systemd，不使用 Docker。这里的模板专门面向当前 Ubuntu
服务器，不是通用 Linux 发行版模板。服务模板位于 `ops/commerce/`：

- `pawshop-commerce.service`：以无特权 `pawshop` 用户运行，只允许写入指定
  运行目录，并明确屏蔽备份目录和备份密钥，启动后必须通过生产身份、回环监听与关闭交易探测；
- `pawshop-backup.service`：以独立的 `pawshop-backup` 账号运行加密 PostgreSQL 备份；
- `pawshop-backup.timer`：每天执行一次并补跑错过的计划任务；
- `pawshop-backup-monthly.timer`：每月归档最近一份已验证密文，并补跑错过的月份任务；
- `pawshop-backup-yearly.timer`：每年归档最近一份已验证密文，并补跑错过的年度任务。
- `pawshop-restore-verify.service`：仅由管理员手动启动，以独立无特权账号和
  独立临时 PostgreSQL 集群验证 root 暂存的备份副本，绝不连接生产数据库。

首次主机准备只运行审查过的 `bootstrap-ubuntu-host.sh`。它固定并校验 Node
22.23.2 官方发布包哈希，验证 PostgreSQL 官方仓库签名密钥指纹，安装 PostgreSQL
17 与 Redis，并把两个数据服务限制到 IPv4 回环地址。针对 2 GB 套餐，PostgreSQL
使用 128 MB shared buffers 和最多 40 个连接，Redis 上限 96 MB；Medusa 运行时
使用 768 MB V8 heap、1 GB memory high 与 1200 MB hard limit，发布构建 heap 上限
为 1536 MB。Node 二进制是固定版本，不由 Ubuntu 自动更新；每次升级必须更新哈希、
重跑测试并重新审查。该脚本不会创建数据库业务角色、运行迁移、生成备份或对象存储
密钥，也不会安装或启用 Medusa systemd 单元。

软件包安装期间脚本会临时创建 `policy-rc.d`，阻止 Ubuntu 的安装脚本在安全配置与
监听验证之前自动启动 PostgreSQL 或 Redis；正常完成和异常退出都会删除该临时策略。
如果主机原本已有 `policy-rc.d`，脚本会拒绝覆盖并停止，保留现有主机策略。

初始化阶段的 Redis 只允许从本机 IPv4 回环访问，但这不是 Medusa 的最终生产认证
状态。启用 Medusa 前必须另行生成独立 Redis ACL 用户与强密码，把带认证信息的
`REDIS_URL` 写入仅服务账号可读的生产环境文件，并完成凭据轮换与拒绝匿名访问验证；
未通过该门槛时不得启动 Medusa、客户 API 或订单写入。

生产备份密钥和最小化备份环境必须位于 `/etc/pawshop-backup/`，备份必须位于
`/var/backups/pawshop/`，都不得放进 Git、静态站目录或发布目录。服务器升配与
系统盘扩容已经完成，但这些单元仍不得直接启用；必须先完成生产主机预检、
真实恢复核验和异地副本验证。

初始化脚本会创建并严格核验系统账号及私有目录；不要再手工重复执行 `useradd` 或
改变这些账号的主组、附加组、home 与 shell。生产数据库角色和异地备份条件就绪后，
才由 root 一次性生成备份密钥；不要把密钥打印到终端、日志或聊天中：

```bash
sudo sh -c 'umask 027; openssl rand -hex 32 > /etc/pawshop-backup/backup.key'
sudo chown root:pawshop-backup /etc/pawshop-backup/backup.key
sudo chmod 0640 /etc/pawshop-backup/backup.key
```

恢复验证脚本必须从随后选定并审查过的精确 release 安装到
`/usr/local/libexec/pawshop/`，不能从活动软链接或工作目录临时复制。

备份程序会拒绝符号链接、非 root 所有、非 `pawshop-backup` 组或不是精确 `0640`
权限的密钥。备份单元只读取独立的 `backup.env`，不读取包含后台 JWT、Cookie、
商品媒体存储等凭证的 `commerce.env`。数据库导出通过管道直接进入 OpenSSL；磁盘上只允许出现加密的
临时文件和最终备份，不允许出现明文数据库转储。

启用前还必须创建独立的 PostgreSQL 登录角色 `pawshop_backup`：不得是超级用户、
不得创建数据库或角色，只授予目标库 `CONNECT`、业务 schema `USAGE` 以及现有和未来
业务表/序列的只读权限；`pg_hba.conf` 只允许它从 `127.0.0.1/32` 使用
`scram-sha-256` 登录。数据库密码写入 `/etc/pawshop-backup/backup.env`，该文件及
`backup-offsite.env` 必须为 `root:pawshop-backup 0640`；两个对象存储密钥源文件必须为
`root:root 0600`。密码和密钥不得作为命令行参数、终端回显或聊天内容传递。首次启用前
由管理员逐项核对这些 owner/mode 和数据库授权，并用只读角色完成一次真实 `pg_dump`。

生产备份完成后，root 必须把选定且文件名完全匹配的一份 manifest、对应密文和
密钥复制到只读暂存目录；暂存文件统一为 `root:pawshop-restore 0640`。不得用
通配符，不得从聊天或下载目录取文件。完成暂存后才能手动执行恢复验证；该单元
不能设为开机启动或定时器：

```bash
sudo systemctl start pawshop-restore-verify.service
sudo systemctl status pawshop-restore-verify.service --no-pager
```

恢复程序不读取商务应用密码、不以 root 或生产 PostgreSQL 超级用户运行，
也不连接生产数据库。它以 `pawshop-restore` 无特权系统账号，在私有目录创建
一个仅 Unix socket 可达的临时 PostgreSQL 17 集群；解密流直接进入该集群的
`pg_restore`，因此没有明文 dump 文件，但恢复后的表和 WAL 会暂时以数据库
文件形式写入隔离目录。应使用加密磁盘，并确保至少 8 GiB、且不低于密文十倍
的可用空间。只有集群停止并删除后，才会写入不含客户明文的验证记录。

工作目录中的排他锁可以阻止并发验证。断电或强制终止会保留锁和隔离目录并让下次运行硬性
失败，管理员必须先确认没有残留进程、保存故障证据并人工清理；程序不会按名称
扫描或删除任何现有数据库。验证完成后，root 还必须删除只读暂存目录中的密钥
副本、manifest 和密文副本。

## 异地分层备份与本地保留策略

每日生产备份成功后，同一个主进程继续执行异地同步（`run-scheduled-backup.mjs`
先 `backup-production.mjs`、再 `sync-production-backups.mjs`；**不能用
`ExecStartPost`**，原因见 `docs/RUNBOOK.md` §9.4：单元带私有挂载命名空间时，
`ExecStartPost` 进程读不到 systemd 注入的凭据）。同步只上传
已经在本机加密的数据库密文及经过 HMAC 认证的 manifest，绝不上传
`backup.key`。每日对象键固定在 `pawshop/database-backups/daily/`。每月与年度任务
不再执行数据库导出，而是复用最近一次已认证的加密日备份，分别写入
`pawshop/database-backups/monthly/YYYY-MM/` 与
`pawshop/database-backups/yearly/YYYY/`。每个周期有一份 HMAC 签名凭证，补跑或
人工重试时只核验记录的精确版本，不重复归档。运行代码中不存在
远程删除 API。

异地桶上线前必须同时满足：开启版本控制；生命周期按前缀分别设置每日 90 天、
月度 365 天、年度 1095 天，且不得存在覆盖整个 Bucket 的 90 天规则；上传凭证明
确没有删除对象、删除版本、修改生命周期或修改桶
策略的权限；服务端默认加密已开启。上述生命周期与禁删权限属于上线前人工证据门槛，
不能只凭环境变量声明。访问密钥和秘密密钥分别存放在 root-only
的 `/etc/pawshop-backup/backup-s3-access-key` 与
`/etc/pawshop-backup/backup-s3-secret-key`，通过 systemd `LoadCredential` 临时提供，
不得写进环境文件。

同步程序检查桶版本控制，上传后按上传返回的精确版本 ID 完整回读新对象并核对
SHA-256，然后为密文和 manifest 记录版本 ID 与带 HMAC 的本地收据。后续每次运行
会对收据中记录的精确版本执行 HEAD，核对大小与哈希元数据。网络、权限、版本或
认证失败会立即停止后续清理并让 systemd 单元失败；未进入清理的套件全部保留，
正在删除的单套可能只剩密文，但最新套件和至少 7 套保留规则不受影响。告警需由后续外部监控接收。
所有网络操作共享 24 分钟硬截止时间，SDK 同时限制连接、空闲 socket 和单请求时间，
并在结束时关闭客户端。

本地至少保留最新 7 套；只有超过 14 天、不是 `latest.json` 指向、已有有效
签名收据且本轮再次确认对应远端版本存在的完整备份套件才可删除。本地删除
顺序为收据、manifest、密文，避免中断后留下一个看似完整但实际缺密文的套件。
远端保留由桶生命周期控制，PawShop 运行凭证没有删除权限。

每日同步、月度归档和年度归档共用排他锁；不得绕过 systemd 并发直接运行。断电或强制终止可能保留锁，
此时后续运行会硬性失败，管理员应先确认没有同步进程并保留故障证据，再人工移除锁。

## 后台中英文切换

Medusa 2.19 自带简体中文与英文界面。登录后可直接打开侧栏的
`语言 / Language`，点击“简体中文”或“English”，整个管理界面会立即切换并在
当前浏览器保存选择；也可在“个人资料 → 编辑 → 语言”使用 Medusa 原生选择器。
这个设置只翻译后台按钮、菜单和提示，不会自动翻译商品标题、详情、物流条款或
顾客可见内容。简体中文属于社区翻译，关键订单、退款和金额操作上线前仍需与英文
原文做一次双语校对。

## 商务后台原子发布与回滚（尚未启用）

首次部署或后续升级都先运行 `prepare-commerce-release.sh`。它只从固定、干净且
root 管理的 `/srv/pawshop-source` 构建指定完整 commit，产出 root 只读的候选版本；
不会改动 `current` 链接，不会安装、启动或启用任何 systemd 单元，也不会读取生产
密钥或运行数据库迁移。候选版本准备成功不等于可以激活。

候选版本同时包含经审查的 `ops/commerce` 运维文件。首次安装先运行
`install-commerce-runtime.sh`；它只从精确的不可变候选版本复制 systemd 单元和恢复
程序，发现既有文件、活动单元或已启用单元就停止，并在结束时再次证明所有商务单元
仍处于未启用、未运行状态。

`ops/commerce/deploy-commerce.sh` 不再重新构建，也不从工作目录取文件。它只接受已经
准备好的完整 commit 候选版本，并要求 `/var/lib/pawshop-release-evidence/<commit>/`
下存在 root-only、只读且绑定同一 commit 的迁移证据与加密备份/隔离恢复证据，然后
才通过临时软链接加 `mv -T` 原子切换 `current`。服务重启及其
生产验证失败时，脚本自动恢复上一版本并再次启动；只有确认旧链接和服务均恢复后
才删除失败版本。若恢复本身失败，两套版本都保留并输出 CRITICAL，不会制造悬空链接。
旧的成功版本不会自动删除。

发布前要求发布文件系统至少有 8 GiB 可用空间；npm 缓存和历史成功版本不会由
脚本自动删除，必须在确认目标版本不再承担回滚用途并保留审计记录后人工清理。
`/etc/pawshop/commerce.env` 只允许单行、不加引号且不含空白、反斜杠或单双引号的
值；URL 中的特殊凭据必须先按 URL 规则编码，避免脚本解析值与 systemd 实际加载值不同。
当前这套严格环境文件和主机预检只支持已经评审的 `single-host-private` 单机私有拓扑；
未来改为托管数据库或托管 TLS 时，必须先扩展并重新审查字段契约，不能直接改变量绕过。

RAM 商品媒体 AccessKey 由所有者完成安全核身并分别存入 root-only 文件后，使用固定
脚本生成一次生产环境文件：

```bash
sudo -n bash /srv/pawshop-source/ops/commerce/provision-production-environment.sh
```

脚本只接受 `/etc/pawshop/internal-secrets.env`、`/etc/pawshop/oss-access-key-id` 和
`/etc/pawshop/oss-secret-access-key` 三个权限严格的输入，不会 `source` 或执行其中内容，
也不会在输出中打印密钥。若 `/etc/pawshop/commerce.env` 已存在会直接拒绝覆盖，密钥轮换
必须另做协调审查。成功生成后仍固定 `PAWSHOP_MIGRATIONS_CONFIRMED=0`，不会启动服务；
只有后续真实备份恢复、迁移及发布证据全部通过后才进入激活阶段。

发布脚本绝不自动运行数据库迁移。每次上线前必须先完成加密备份、真实恢复验证、
迁移审查，并确认新旧版本与当前数据库 schema 的兼容边界；只有完成这些步骤后才可
设置一次性的 `PAWSHOP_RELEASE_ACTIVATION_CONFIRMED=1`。手动回退使用
`rollback-commerce.sh`，必须指定仍保留的完整 SHA，并在确认数据库向后兼容后设置
`PAWSHOP_ROLLBACK_COMPATIBLE=1`。这两个确认变量不是证据本身，操作记录必须保存
对应的备份、恢复、迁移和验证结果。

当前阿里云轻量服务器已升级为控制台标称 2 GB 的套餐；Ubuntu 实测
`MemTotal: 1651800 kB`，因此主机门槛使用至少 `1600000 kB` 的系统报告值，同时
仍会拒绝原 1 GB 套餐。40 GB 云盘已完成分区和 ext4 在线扩容，扩容前分区表保存在
服务器 root 私有目录。

### 首次生产后台激活顺序

以下步骤必须针对同一个完整 Git SHA，不能跳步，也不能把示例确认变量长期写进环境文件。
商品、顾客、订单和支付的公网接口在这轮始终保持关闭。

1. 在干净且 root 所有的 `/srv/pawshop-source` 更新到待发布 SHA，执行
   `prepare-commerce-release.sh`，再用 `verify-release-manifest.mjs` 取得该候选的
   `RELEASE_CONTENT_SHA256`。
2. 明确设置一次性 `PAWSHOP_FIRST_MIGRATION_CONFIRMED=1`，运行
   `run-first-production-migration.sh`。它只接受空生产数据库并保持服务未启动。
3. 确认对象存储备份桶已开启版本控制、至少 90 天保留策略，且备份 RAM 凭据无删除权限；
   明确设置一次性 `PAWSHOP_FIRST_BACKUP_RESTORE_CONFIRMED=1`，运行
   `run-first-production-backup-restore.sh RELEASE_ID RELEASE_CONTENT_SHA256`。成功标准包含
   加密备份、指定版本完整回读、隔离 PostgreSQL 恢复和临时集群删除。
4. 运行 `provision-production-owner-credentials.mjs owner@pawlivora.com`。凭据只写入
   `/root/pawshop-production-owner-credentials.json`（0600），密码不进入命令参数或日志。
5. 只有两份证据均通过后，明确设置一次性
   `PAWSHOP_RELEASE_ACTIVATION_CONFIRMED=1` 并运行 `deploy-commerce.sh`。首次启动失败会
   恢复无 `current` 链接状态，并把迁移门禁重新关闭。
6. 明确设置一次性 `PAWSHOP_PRODUCTION_ADMIN_FINALIZATION_CONFIRMED=1`，运行
   `finalize-production-admin.sh RELEASE_ID`。它必须完成真实管理员登录以及商品、订单、顾客
   管理接口验证，随后才启用开机自启和每日加密异地备份定时器。

运营者查看首次生成的后台账号时，应在服务器私有终端执行
`sudo less /root/pawshop-production-owner-credentials.json`，不得截图、提交 Git、粘贴到聊天或
存入浏览器同步笔记。完成首次登录后应尽快在密码管理器中保存，并在支持的后台安全设置中
启用 MFA；支付接入仍需另行评审和真实沙箱/小额闭环验证。
