# PawShop 店主待办与链接清单

更新：2026-09-16（WorkBuddy 第五轮）
配套：`docs/REMAINING_WORK.md`（技术视角的未完成清单与优先级）、`docs/RUNBOOK.md`（可执行命令）、`PRODUCTION_HANDOFF_ZH.md`（路径与排错总索引）。

**这份文件的用途**：把"必须由店主本人出面"的事项集中成一份可照着点的清单——每条都给出**官方链接、逐条步骤、完成后把什么交给我、我拿到之后做什么**。
凡是**不需要你动手**的，都不在这份文件里；那部分见 §7。

图例：**只有你能做** = 涉及你的身份、账号归属、协议签署、付款；**我做** = 我直接在生产环境执行并给出证据。

---

## 0. 一页速览

| # | 事项 | 谁能做 | 你要做的动作 | 我需要你给我的东西 |
| --- | --- | --- | --- | --- |
| 1 | **告警通道**（P1） | 只有你（建机器人）+ 我做（接入） | 在飞书/Slack/Telegram 三者中**任选一个**，点出一个 webhook URL | 那一个 URL（安全交接方式见 §1.4） |
| 2 | **备份链**（P0） | 我做 + 你在阿里云建一个 RAM 用户 | 建一个只写备份前缀的 RAM 用户，导出 AccessKey | AccessKey ID + Secret（Secret 只显示一次） |
| 3 | OSS 生命周期三条规则 | 我做（需你确认保留期） | 只需确认"90 天/12 月/3 年"是否符合你的合规判断 | 一句确认 |
| 4 | 收款通道 | 只有你（身份与协议） | 申请空中云汇（第一候选）+ PingPong（备用） | 沙盒凭据（审核通过后） |
| 5 | 后台暴露方式（B2） | 我做（需你点头） | 看 §6 三个选项，认可推荐方案即可 | 一句"按 (b) 走" |
| 6 | `main` 分支合并与 CI | 我做 | 无需动手（建议商务激活后再合） | 无 |
| 7 | 正式上线前的合规/物流资料 | 只有你 | 企业邮箱、退货地址、客服责任人、经营主体 | 审核前提供 |

---

## 1. 告警通道（唯一"出事没人知道"的阻塞项）

**现状**：监控每 5 分钟跑 12 项检查，实测 12/12 通过。但**告警通道没配**，所以失败只会写进服务器日志，**不会通知任何人**——包括你。

**2026-09-16 我已补齐通道适配层**（见 §7），所以现在真的只差"你点出一个 URL"这一步。

三家任选其一即可，**推荐飞书**（你在国内，访问稳定、免费、手机上就能收到）。

### 1A. 飞书自定义机器人（推荐）

官方文档：<https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot>

1. 打开飞书，进入你想接收告警的群（建议**新建一个只有你的群**，例如"PawShop 运维"）。
2. 点群右上角 `...` → **设置** → **群机器人** → **添加机器人** → 选 **自定义机器人**。
3. 起个名字（如 `PawShop 告警`），点**添加**。
4. **安全设置**（重要，三个选项只选一个）：
   - ✅ **推荐：自定义关键词**，填 `PawShop`。我们的告警正文以 `[PawShop 告警]` / `[PawShop 恢复]` 开头，**必然命中关键词**。
   - 或者 **IP 白名单**，填 `47.254.26.124`（这是生产主机的真实出口公网 IP，我已在主机上实测确认）。
   - ⛔ **暂不要勾选"签名校验"**：它要求发送方用 `timestamp + "\n" + 密钥` 做 HMAC-SHA256 再 Base64，**当前监控实现还没做加签**，勾了会导致告警全部被拒（飞书错误码 9499）。如果你希望更安全、想开加签，告诉我，我补上签名支持（含单测）后再开。
5. 点**完成**，复制那条 **Webhook 地址**，形如：
   `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

### 1B. Slack Incoming Webhook

官方文档：<https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/>

1. 先在 <https://api.slack.com/apps> 点 **Create New App** → **From scratch**，起名 `PawShop Alerts`，选一个 workspace（免费版即可）。
2. 左侧 **Incoming Webhooks** → 把 **Activate Incoming Webhooks** 打开。
3. 页面下方点 **Add New Webhook to Workspace** → 选择接收频道（建议建一个私有频道）→ **Authorize**。
4. 复制生成的 Webhook URL，形如：
   `https://hooks.slack.com/services/<TEAM_ID>/<BOT_ID>/<TOKEN>`

> Slack 官方明确写了这条 URL 等同于密钥（"Your webhook URL contains a secret"），所以它同样适用 §1.4 的交接纪律。另外从国内访问 Slack 可能需要稳定的网络环境，这也是我推荐飞书的原因。

### 1C. Telegram Bot

官方文档：<https://core.telegram.org/bots/api>（BotFather 入口：<https://t.me/BotFather>）

1. 在 Telegram 里找 **@BotFather**（认准蓝色认证勾），发 `/newbot`，按提示起两个名字：
   - 显示名：随意，如 `PawShop Alerts`
   - 用户名：必须**以 `bot` 结尾**且全局唯一，如 `pawshop_alerts_bot`
2. BotFather 会回一条消息，其中的 **token** 形如 `123456789:AAxxxxxxxxxxxxxxxxxxxx`。
3. 把 bot 拉进目标群（或直接私聊它并**先发一条消息**，否则下一步取不到）。
4. 浏览器打开 `https://api.telegram.org/bot<你的token>/getUpdates`，在返回 JSON 里找 `chat.id`：
   - 私聊是正数，如 `123456789`
   - 群/频道是**负数**，如 `-1001234567890`
5. 交给我**两样**：token + chat_id。

### 1.4 URL 怎么交给我（三选一；**不需要给我账号**）

先澄清一句：**不用给账号，也不用让我登录你的飞书 / Slack / Telegram。** 我需要的只是那一条 webhook URL——它的权限被限制在"只能往你那个群发消息"，而且你在群里删掉机器人就立刻作废；账号权限是全部，代价完全不成比例。所以**不要把账号密码、验证码、扫码登录交给我**。

三种交付方式，按省事程度排：

1. **剪贴板直取（最省事，推荐）**：你在飞书里点一下"复制"拿到 URL，然后跟我说一句"复制好了"。我在你本机执行 `pbpaste` 把它读出来，**读完立刻清空剪贴板**——URL 不进聊天记录、不落地成文件。
2. **本地文件**：存成 `~/.pawshop/alert-webhook.url`（一行，只有 URL 本身），告诉我"存好了"。我读走后**删除该文件**。
3. **你 SSH 上服务器自己写**（全程不经我手）：我给你一条 `read -s` 命令，你在服务器上粘贴回车；用 `read -s` 是为了不进 shell 历史。

Webhook URL 等同于"能往你频道里发消息"的写入凭据，看到它的人就能冒充你的运维告警，所以：

- ⛔ 请不要：贴进聊天、截图、提交到 Git、放进网盘。**Slack 官方会主动扫描并吊销泄露的 webhook**。
- 万一泄露了：在群里删掉这个机器人、重新添加一个新的，旧 URL 立即失效（约 1 分钟）。

### 1.5 我拿到之后做什么（不用你操心）

0. 先把**新版监控脚本**装到主机 `/usr/local/libexec/pawshop`（当前主机跑的还是旧版，没有通道适配层；旧版在没有 webhook 时行为一致，所以一直等真实 URL 一起更新，避免多跑一趟）。
1. 写入 `/etc/pawshop-monitor/monitoring.env`（只追加，保持 `root:pawshop 0640`，不进 Git）。
2. 按通道设置 `PAWSHOP_MONITOR_ALERT_PROVIDER`（`feishu` / `slack` / `telegram`），Telegram 另加 chat id。
3. **做一次真实投递验证**：制造一次必定失败的检查，确认①服务器日志出现 `alert webhook accepted the payload`，②**你的频道里真的收到那条消息**。两者缺一不算通过。
4. 把这次验证写进 `docs/RELEASE_GATES.md` 与运行手册。

---

## 2. 备份链（P0：现在生产库**没有任何加密备份**）

**现状**：`pawshop-backup.timer` 是 `disabled`，而且**即使启用也会失败**——有四处硬阻塞。库现在是空的（0 张表），所以暂时没有数据可丢，但**必须在开放下单前修好**。

| 阻塞 | 内容 | 谁能修 |
| --- | --- | --- |
| ① | 单元 `WorkingDirectory=/srv/pawshop-commerce/current/_commerce`，而 commerce 未激活，该路径不存在 | **我**（与监控同样的解耦思路） |
| ② | `/etc/pawshop-backup/backup-offsite.env` 缺失 | **我**（桶名/前缀/保留期文档里已有既定值，你确认即可） |
| ③ | `LoadCredential` 需要 `/etc/pawshop-backup/backup-s3-access-key` 与 `backup-s3-secret-key`，都缺失 | **只有你能做**（要在你的阿里云账号里建 RAM 用户） |
| ④ | 单元 `Requires=postgresql.service`，而该 meta 单元是 `inactive`（真正跑的是 `postgresql@17-main.service`） | **我** |

### 2.1 你在阿里云要做的（约 5 分钟）

- RAM 控制台：<https://ram.console.aliyun.com/users>
- 创建 RAM 用户官方文档：<https://help.aliyun.com/zh/document_detail/450503.html>

步骤：

1. 用主账号登录 <https://ram.console.aliyun.com/>，左侧 **身份管理 → 用户 → 创建用户**。
2. 登录名称填 `pawshop-backup-writer`；访问方式勾 **使用永久 AccessKey 访问**（**不要**勾控制台访问，这个用户只给程序用）。
3. 创建完成后**立刻复制 AccessKey ID 和 Secret**——⚠️ **Secret 只在创建时显示一次，之后无法再查看**。
4. 左侧 **权限管理 → 权限策略 → 创建权限策略**，用可视化编辑只给这几项，资源限定到备份桶的备份前缀：
   - `oss:PutObject`（上传备份）
   - `oss:GetObject`（做精确版本回读验证）
   - `oss:ListObjects` / `oss:ListObjectVersions`（确认版本）
   - ⛔ **不给** `oss:DeleteObject*`、`oss:DeleteBucket*`、`oss:PutBucketLifecycle`：删除交给 OSS 生命周期规则，运行时账号不该有删备份的能力。
5. 把策略授权给 `pawshop-backup-writer`。
6. 把两样交给我（**同样不要贴聊天**，按 §1.4 的方式放本地文件）：AccessKey ID + Secret。

> 更安全的替代方案：用 STS 临时凭证 + 角色。那需要我先在主机侧加装 AssumeRole 支持，属于额外工作，**当前设计用的是长期 AccessKey + 严格前缀权限**。你如果想升级到 STS，说一声。

### 2.2 我做剩下的（拿到上面两样之后）

①④ 修单元依赖 → 写 `backup-offsite.env` → 用 root-only 的 `LoadCredential` 注入凭证（不落盘到别的文件、不进 Git）→ 手动跑一次备份 → 做**加密备份 + OSS 精确版本回读** → 再跑**隔离恢复演练**（恢复到临时库、核对表数量、删除临时库）→ 记录证据到 `/var/lib/pawshop-release-evidence/<sha>` → 才启用定时器。

---

## 3. OSS 生命周期规则（三条，只匹配各自前缀）

控制台：<https://oss.console.aliyun.com> → 选 `pawlivora-backups-us-west-1` → **数据管理 → 生命周期**

| 规则 | 前缀 | 建议动作 |
| --- | --- | --- |
| 每日 | `pawshop/database-backups/daily/` | 保留 90 天后删除 |
| 每月 | `pawshop/database-backups/monthly/` | 保留 12 个月后删除 |
| 每年 | `pawshop/database-backups/yearly/` | 保留 3 年后删除（**暂定**，需你按财税要求确认） |

⛔ **绝对不要**创建一条覆盖整个 Bucket 的 90 天删除规则——那会把月度和年度归档一起清掉。

**归属**：规则本身**我能配置**（我有管理通道），但"到底该保留多久"是你的合规判断。你只需要确认上面三个数字；如果你对财税留存年限有不同要求（有些类目要求更长），现在告诉我，我按你说的设。

---

## 4. 收款通道

| 项 | 归属 | 说明 |
| --- | --- | --- |
| 申请空中云汇 **Airwallex**（第一生产候选） | 只有你 | 官网：<https://www.airwallex.com.cn> |
| 同步申请 **PingPong**（费率对照 + 备用通道） | 只有你 | 官网：<https://www.pingpongx.com> |
| 两家通过后**只接一家到生产**，另一家保留 | 你决定，我接线 | |
| **先沙盒测试，不开放真实扣款** | 共同 | |

**如实填写的纪律（重要，填错会被风控冻结）**

- 主体：**个体工商户**（⚠️ 营业执照下证后再提交，不要先填后补）
- 网站：`pawlivora.com`；业务：自营宠物用品独立站；首要市场：美国；发货地：中国大陆
- 客单价与预计月销售额按**冷启动的真实低额**填写
- ⛔ 不要填"已有大量订单""已有海外仓""已确定送达时效"，除非已经落实
- ⛔ **身份信息、银行卡、营业执照、短信验证码、最终协议一律你本人提交**；不要把密码、验证码、完整证件发到聊天里（打码截图可以问我）
- 参考：Airwallex 通常要求营业执照 + 法人身份 + 业务流水，审核门槛比纯平台收款工具高；PingPong 对中国卖家流程更轻。**两家并行申请互不阻塞**，这是稳妥做法。

**通道通过后我负责**：把沙盒凭据落到服务器（不进 Git）、接支付插件、跑通完整测试清单（成功 / 失败 / 取消 / **重复 webhook** / 退款 / 对账）。

---

## 5. 仓库与 CI（不需要你动手）

| 项 | 我的处理 |
| --- | --- |
| `main` 与工作分支分叉 | **建议商务后台激活跑通后再合并**，避免一次涌入过多变更。你说合我再合。 |
| CI 只在 `main` 触发 | 可选：把 workflow 扩到工作分支 |
| GitHub Pages | 已于 2026-09-16 停用（返回 404）。如需重开：<https://github.com/wesley9311/pawshop/settings/pages> |
| 仓库可见性 | 目前 **PUBLIC**。⚠️ 转私有前必须先给主机配 deploy token——主机的 `git fetch` 是**匿名**的，**转私有会立刻打断发布链**。 |
| 历史提交含 `costCNY`（AR-14） | **已决策：保持公开、不重写历史**。泄露范围只是历史提交里的采购成本，不是客户数据或凭据；`HEAD` 的 `catalog.json` 已干净，`check-security.mjs` 已把它列为禁止字段。 |

---

## 6. 后台暴露方式（B2）—— 需要你一句话

现状：Medusa 后台按设计只在**回环**上跑（`127.0.0.1:9000`，不对外）。这最安全，但**浏览器里的中文运营台够不到它**（你的浏览器在你电脑上，访问不到服务器的回环口）。三条路：

| 方案 | 说明 | 代价 |
| --- | --- | --- |
| (a) 保持回环 + SSH 隧道 | 运营台只在你本机跑 | 最安全，但"随时随地用"很别扭 |
| **(b) 同源反向代理（推荐）** | nginx 在 `pawlivora.com` 下开 `/admin-api/` → `127.0.0.1:9000`，叠加 IP 白名单或 Basic Auth，再叠 Medusa 自身鉴权 | 攻击面从 0 变 1，但可控；**运营台才能用** |
| (c) 直接公网暴露 Admin API | 最方便 | ⛔ 不推荐 |

**我的判断：走 (b)。** 这个决定必须在运营台开工前定，否则做完才发现调不通。你回一句"按 (b) 走"，我就往下执行；如果你更在意"绝不对公网开任何口"，那就走 (a)，运营台改成只在你本机运行。

---

## 7. 本轮（2026-09-16）我已自行完成、不需要你操作的

- **告警通道适配层**：飞书 / Slack / Telegram / generic 四家的报文方言、厂商域名钉住、"HTTP 200 但内部报错 = 未投递"的判定，全部实现。
- **端到端投递实测**：真 HTTPS 接收端按四家真实应答回包，**10 项判定全绿**，逐条核对了线上实际发出的字节。可用 `cd _commerce && npm run test:alert-delivery` 复跑。
- **修掉一个真实缺陷**：原先"检查持续失败 + 告警处于 30 分钟去重窗口"时，监控会退出码 2（= 告警系统坏了），把"刻意不发"误报成"告警坏了"。现已改为退出码 1。
- 监控单测由 9 项扩到 **12 项**，全绿。

## 8. 建议顺序（与 `docs/REMAINING_WORK.md` §F 一致）

1. **你给一个告警 URL**（§1）→ 我接入 + 真实投递验证 ← **当前唯一卡在你这边的 P1**
2. **你回一句后台暴露方案**（§6）
3. 我激活商务后台 → 一并解锁备份链与两张"临时跳过"的删除
4. **你建备份 RAM 用户**（§2.1）→ 我做首次加密备份 + 隔离恢复演练
5. 我开工**中文运营台**（从只读看板起步）
6. **你申请收款**（§4）→ 通过后我接沙盒
7. 视情况合并 `main`（§5）

每一步之后我都会跑一遍全量回归（根检查 + commerce 测试/类型/构建 + 真实浏览器检查 + `verify:production` 双档 + 监控实测）。
