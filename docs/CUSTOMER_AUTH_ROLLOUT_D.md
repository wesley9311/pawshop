# CUSTOMER AUTH — ROLLOUT D 报告（标准升级激活 e59b097 + nginx 精确开放）

> 状态：**已执行完成，未自行标 OWNER VERIFIED**。等待 Owner 进入 Rollout E 浏览器验收。
> 日期：2026-10-05（UTC 2026-10-04）
> 目标 release：`e59b097ee1bdfd2643170b31c4b1db9ecab48520`（already_claimed 幂等 + 验证码限流，纯代码）
> 前任 release：`9e8cfcc869009a1bae7c863295767e70dc26a34a`

---

## 0. 为什么走升级路径而不是 code-only（进入 D 前的关键判定）

进入 D 前先做了只读 reconciliation（第三条 auth_identity 已确认是合法孤儿记录，见 §1）。随后尝试走 code-only 门禁，被**正确 fail-closed 拒绝**：

```
Code-only release refused because the prepared migration set changed.
```

根因（全部只读核实）：

| 事实 | 证据 |
|---|---|
| `e59b097` 相对 `9e8cfcc` 引入了新 migration 文件 `Migration20261004000000`（customer-auth 模块） | `git diff --name-only` 含 `src/modules/pawshop-customer-auth/migrations/...` |
| 该 migration 已由 `0eb7c4f`（Rollout B）正式执行到生产库 | `/var/lib/pawshop-release-evidence/0eb7c4f…/migration.json`：`tables 152→154`、`status=succeeded` |
| `e59b097` 与 `0eb7c4f` 的 migration set 完全一致 | 两者 `migration_set_sha256` 均为 `3d2597cad1fb1d9d807ba531006dd42d22a89d3bc27d76cfdca913c45ca9c5c4` |
| `9e8cfcc`（当前 active）不含 customer-auth 模块 | release 目录只有 connector/notification/paypal 三模块 |

→ 结论：**必须走 §11.2 标准升级路径，不能走 code-only**。`db:migrate` 预期 no-op（migration 已在库里，`mikro_orm_migrations` id=185）。

**Owner 决策：选项 A（标准升级激活）。**

---

## 1. Reconciliation（进入 D 前，只读）

第三条 `auth_identity`（`authid_01M43MAWV5SQ83EB2E0F6FBD79`）确认：

- provider = emailpass，entity_id = 占位邮箱 `x@y.com`
- `app_metadata` 空（无 user_id / customer_id），不匹配任何 user/customer，无 auth_verification
- 来源可解释：COMMERCE SERVICE RECOVERY 后 22:15 一次 127.0.0.1 HTTP sweep 用 curl/8.5.0 UA 调 `POST /auth/customer/emailpass/register` 注册 `x@y.com` 产生的孤儿 identity
- 判定：**合法既有记录，旧 baseline 过期** → 更新 baseline auth_identity=3，进入 D

---

## 2. 升级迁移（§11.2 步骤 3）

`run-production-upgrade-migration.sh`（`PAWSHOP_UPGRADE_CONFIRMED=1`），setsid 长活 + 日志判成败。

结果 `UPGRADE_EXIT=0`：

- Pre-upgrade restore point：`pawshop_production_20261004T162417262Z.manifest.json`
- **Relations before 154 (1591 rows) → after 154（不变）**
- `db:migrate` 全模块 `Skipped. Database is up-to-date`（**纯 no-op，无任何 pending migration**）
- 唯一 migration script 是 Medusa 自带 `create-super-admin-role.js`（框架内置）
- evidence：`migration.json` + `relations-before/after.json`（`relations_before_sha256 == relations_after_sha256 == d5c565f3…`）

迁移后数据核对（零变化）：

| 表 | 行数 | 判定 |
|---|---|---|
| order | 23 | ✅ 无变化 |
| customer | 13 | ✅ 无变化 |
| auth_identity | 3 | ✅ 无变化 |
| customer_claim_audit | 0 | ✅ 空表符合预期 |
| verification_rate | 0 | ✅ 空表符合预期 |
| auth_verification | 0 | ✅ 空表符合预期 |
| user | 1 | ✅ 无变化 |
| mikro_orm_migrations | 最新仍 185 = Migration20261004000000 | ✅ 无新 migration 被执行 |

---

## 3. 迁移后备份 + 隔离恢复演练（§11.2 步骤 4）

`run-first-production-backup-restore.sh upgrade e59b097… 12235bbf…`，结果 `BACKUPRESTORE_EXIT=0`：

- 迁移后备份 manifest：`pawshop_production_20261004T162653309Z.manifest.json`
- 异地回读 + 隔离恢复演练通过（`restore_verified_at 2026-10-04T16:26:56Z`，`isolated_cluster_removed: true`，`status: succeeded`）

---

## 4. 合闸 + 激活（§11.2 步骤 5/6）

- 合闸：`write-production-migration-gate.mjs … enable` → gate 0→1 ✅
- 激活：`deploy-commerce.sh`（`PAWSHOP_RELEASE_ACTIVATION_CONFIRMED=1`）→ `DEPLOY_EXIT=0`
- `current` → `e59b097ee1bdfd2643170b31c4b1db9ecab48520`

激活后内部验证（未改 nginx 前）：

- commerce active、NRestarts=0、/health 200、storefront 200
- PostgreSQL/Redis/nginx active
- 监控 12/12（升级停机期间 3 项 commerce 探针瞬时 TypeError，激活后自愈）
- customer auth 模块在产物中（index.js/migrations/models/service.js），端点回环可达且行为正确
- admin auth 不回归（/admin/products 401）

---

## 5. nginx 精确开放 customer auth endpoints（D 步骤 4）

canonical 改动（commit `07bdd03`）：

- 新增 `ops/nginx/conf.d/pawshop-customer-ratelimit.conf`：`limit_req_zone … zone=pawshop_customer_login:10m rate=10r/m;`
- `ops/nginx/sites-available/pawshop`：新增 `location /auth/customer/` 与 `location /auth/verification/` 两个前缀块

部署到主机：

- 主机上精确插入两个前缀块（python 锚点替换，157→186 行）
- scp 限速区文件到 `/etc/nginx/conf.d/`
- `nginx -t` 通过，`systemctl reload nginx`（active，NRestarts=0）
- 主机 nginx 配置已备份：`/etc/nginx/sites-available/pawshop.bak-rollout-d-20261005T003852Z`

**边界严格遵守**：

- ❌ 未开放整个 `/auth/`（`GET /auth/`、`/auth/mfa/`、`/auth/nonexistent` 全部 404）
- ❌ 未影响 `/auth/user/*`（emailpass 401、google 200、callback 401，与改动前一致）
- ❌ 未提前做 My Orders、未改 PayPal/fulfillment/notification、未碰 CloudGull

---

## 6. 外部匿名/错误路径负向验证（D 步骤 5）

| 探测 | 结果 | 判定 |
|---|---|---|
| POST /auth/customer/emailpass/register（空 body） | 401 结构化错误 | ✅ 路由在线 |
| POST /auth/customer/emailpass（空 body） | 401 | ✅ |
| POST /auth/verification/request（匿名） | 401 | ✅ |
| POST /auth/verification/confirm（空 body） | 400 `Field 'code' is required` | ✅ 参数校验，路由在线 |
| GET /auth/（根） | 404 | ✅ 未放开整个 /auth/ |
| GET /auth/user/emailpass | 401 | ✅ admin 未受影响 |
| GET /auth/user/google | 200 | ✅ admin 未受影响 |
| GET /auth/mfa/ | 404 | ✅ 无 customer 入口 |
| GET /auth/nonexistent | 404 | ✅ |

---

## 7. 最终综合回归

- 展示站根 200、store API 200（带 pk）、admin API 401（匿名）、PayPal webhook 200
- 监控 **12/12 passed**
- commerce/nginx/postgresql/redis 全部 active，NRestarts=0，gate=1

---

## 8. 遗留观察（需 Owner 知悉，非本轮引入）

1. **canonical 与主机的 nginx connector drift**：canonical `ops/nginx/sites-available/pawshop` 含 `location /api/connector/v1/`（CloudGull）块，但主机 `/etc/nginx/sites-available/pawshop` **没有**该块，主机 conf.d 也**没有** `pawshop_connector` zone。即 CloudGull connector 的 nginx 反代**从未部署到主机**（CloudGull 未上线）。本轮按「不碰 CloudGull」约束，未处理此 drift，也未把 canonical 全文覆盖主机（那会引入未定义 zone 导致 `nginx -t` 失败）。
2. **升级停机期间的监控瞬时失败**：00:25/00:30 两次监控运行报 3 项 commerce 探针 TypeError（升级停机所致），激活后自愈，无需处置。
3. 主机 conf.d 现有 `pawshop-admin-ratelimit.conf` 权限为 `600`（root），其余为 `644`；本轮新增的 `pawshop-customer-ratelimit.conf` 设为 `644`。功能不受影响。

---

## 9. 下一步（等 Owner 授权）

Rollout E：production browser acceptance（真实浏览器验收 customer 注册/登录/验证码/我的账户全流程）。

**未自行标 OWNER VERIFIED。**
