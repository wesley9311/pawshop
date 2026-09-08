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
- `pawshop-backup.timer`：每天执行一次并补跑错过的计划任务。
- `pawshop-restore-verify.service`：仅由管理员手动启动，以独立无特权账号和
  独立临时 PostgreSQL 集群验证 root 暂存的备份副本，绝不连接生产数据库。

生产备份密钥和最小化备份环境必须位于 `/etc/pawshop-backup/`，备份必须位于
`/var/backups/pawshop/`，都不得放进 Git、静态站目录或发布目录。当前服务器
内存不足，这些单元不得安装或启用；后续必须先完成主机升级、生产恢复核验
和异地副本验证。

升级主机后，由 root 一次性建立私有目录和备份密钥；不要把密钥打印到终端、
日志或聊天中：

```bash
sudo install -d -o root -g pawshop -m 0750 /etc/pawshop
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin pawshop-backup
sudo install -d -o root -g pawshop-backup -m 0750 /etc/pawshop-backup
sudo install -d -o pawshop-backup -g pawshop-backup -m 0700 /var/backups/pawshop
sudo install -d -o pawshop -g pawshop -m 0700 /var/lib/pawshop
sudo sh -c 'umask 027; openssl rand -hex 32 > /etc/pawshop-backup/backup.key'
sudo chown root:pawshop-backup /etc/pawshop-backup/backup.key
sudo chmod 0640 /etc/pawshop-backup/backup.key
sudo useradd --system --home-dir /var/lib/pawshop-restore --shell /usr/sbin/nologin pawshop-restore
sudo install -d -o root -g pawshop-restore -m 0750 /var/lib/pawshop-restore
sudo install -d -o pawshop-restore -g pawshop-restore -m 0700 \
  /var/lib/pawshop-restore/work \
  /var/lib/pawshop-restore/verifications
sudo install -d -o root -g pawshop-restore -m 0750 /var/lib/pawshop-restore/input
sudo install -d -o root -g root -m 0755 /usr/local/libexec/pawshop
sudo install -o root -g root -m 0555 \
  /srv/pawshop-commerce/current/_commerce/scripts/restore-verify-production.mjs \
  /srv/pawshop-commerce/current/_commerce/scripts/backup-integrity.cjs \
  /usr/local/libexec/pawshop/
```

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

## 异地备份与本地保留策略（尚未启用）

每日生产备份成功后，`pawshop-backup.service` 调用异地同步程序。它只上传
已经在本机加密的数据库密文及经过 HMAC 认证的 manifest，绝不上传
`backup.key`。对象键固定在 `pawshop/database-backups/`，运行代码中不存在
远程删除 API。

异地桶上线前必须同时满足：开启版本控制；生命周期保留不少于 90 天（首发
建议 180 天）；上传凭证明确没有删除对象、删除版本、修改生命周期或修改桶
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

同步脚本使用排他锁；不得绕过 systemd 并发直接运行。断电或强制终止可能保留锁，
此时后续运行会硬性失败，管理员应先确认没有同步进程并保留故障证据，再人工移除锁。
