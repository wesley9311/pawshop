# PawShop 架构说明

更新：2026-09-16（WorkBuddy，基于代码实测，非假设）

## 1. 总体拓扑

PawShop 由两个独立部署单元组成，之间**当前没有任何运行时连接**：

```
┌─────────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ 公开展示站（可上线单元 A）                     │   │ 商务后端（未激活单元 B）                    │
│                                             │   │                                          │
│  静态 HTML ×8 + catalog.json + assets/      │   │  Medusa 2.19.0 (Node 22, TypeScript)     │
 │  Tailwind 3.4 构建产物                      │   │  PostgreSQL 17 + Redis（回环专用）         │
│  无后端、无用户数据、无支付                    │   │  Admin-only：Store/Customer API 503 门禁  │
│                                             │   │  S3 兼容 OSS（商品图 + 加密备份）          │
│  部署：阿里云 SWAS + Nginx + 原子 release    │   │  部署：/srv/pawshop-commerce/releases/    │
│  （ops/deploy-static.sh）                    │   │  <SHA> 不可变目录 + current 符号链接       │
│  域名：https://pawlivora.com                 │   │  systemd: pawshop-commerce.service        │
└─────────────────────────────────────────────┘   └──────────────────────────────────────────┘
        GitHub Pages 镜像 main（_config.yml，排除 _commerce/）
```

## 2. 公开展示站（单元 A）

- **页面**：`PawShop.html`（主页）、`product.html`（详情）、`privacy.html`、`terms.html`、`shipping.html`、`returns.html`；`account.html`/`admin.html`/`dashboard.html` 仅作为 404 契约的退役占位（线上必须 404）。
- **数据**：`catalog.json`（单一活跃商品，字段经 `check:security` 白名单校验：禁止 stock/originalPrice/costCNY/supplier/paymentLink 等私有字段）。
- **安全**：CSP 内联于 PawShop.html 与 product.html；`check:security` 拒绝 demo 密码、浏览器 token、假订单成功文案、客户端支付选项。
- **构建**：`npm run build` = Tailwind minify + Font Awesome 图标拷贝。
- **发布**：`ops/deploy-static.sh` —— 仅打包白名单文件、拒绝符号链接、原子切换 `/srv/pawshop/current`、Nginx 配置校验通过才 reload、线上 HTTPS 边界检查失败即回滚上一 release。

## 3. 商务后端（单元 B，admin-only 地基）

- **框架**：Medusa.js 2.19.0，双模式配置（`_commerce/medusa-config.ts` + `src/lib/local-policy.cjs` / production policy）。
- **模式门禁**：`PAWSHOP_MODE` = `local-admin-only`（本地）或 `production-admin-only`（生产）；Store 与 Customer API 无条件 503，直到店主单独批准开放。
- **本地运行**：`scripts/run-local.mjs` 读取 `~/Documents/PawShop_Private/development/commerce.env`（仓库外私有），绑定 127.0.0.1:9000。
- **生产运行**：`scripts/run-production.mjs` 要求 TLS PG/Redis、独立 secret、HTTPS storefront origin、回环 admin origin；systemd 以无特权 `pawshop` 用户运行，768MB V8 堆 / 1200MB 硬限。
- **文件存储**：`@medusajs/file-s3` → 阿里云 OSS `pawlivora-products-us-west-1`。
- **数据库**：PostgreSQL 17，SCRAM-SHA-256，仅回环；迁移由 `PAWSHOP_MIGRATIONS_CONFIRMED` 门禁（默认 0=fail-closed）。
- **备份体系**（本地已验证，生产未安装）：
  - 每日：`pg_dump → AES-256-CBC/PBKDF2 加密 → SHA-256+HMAC manifest → 本地私有目录`；
  - 异地：systemd credentials 注入 OSS AccessKey，上传后按精确 version ID 回读校验，运行时凭据无删除权限；
  - 分层：`daily/`（90 天）、`monthly/YYYY-MM/`（12 个月）、`yearly/YYYY/`（3 年）独立前缀 + 独立 timer；
  - 恢复：`restore-verify-real`（本地）/ `pawshop-restore-verify.service`（生产，一次性隔离集群，不连生产库）。
- **发布与回滚**：`prepare-commerce-release.sh`（Git 精确身份 + 干净树门禁 + 不可变 release 目录）→ `deploy-commerce.sh` / `finalize-production-admin.sh`（证据链门禁：迁移字节+备份回执+隔离恢复回执同源绑定）→ `rollback-commerce.sh`（保留 release + DB 兼容门禁 + 原子切换）。

## 4. 环境变量与秘密边界

| 环境 | 位置 | 内容 |
| --- | --- | --- |
| 本地开发 | `~/Documents/PawShop_Private/development/commerce.env`（0600，仓库外） | 本地 DB/Redis/admin 凭据 |
| CI | `.github/workflows/quality.yml` 内联 fixture（`.invalid` 域名、dummy secret） | 仅构建测试用 |
| 生产 | `/etc/pawshop/commerce.env`（root:service 0640）+ `/etc/pawshop/internal-secrets.env` + OSS 凭据 root-only 文件 | 真实秘密，永不入 Git |
| 示例 | `_commerce/.env.example`、`ops/commerce/*.env.example` | 占位符 only（已人工复核无真实值） |

`.gitignore` 覆盖：`_commerce/.env*`（保留 example）、`node_modules`、`.workbuddy/`、私有数据目录。

## 5. CI

`.github/workflows/quality.yml`：PR / push main 触发；根目录 `npm ci + build + check`，`_commerce` `npm ci + test + check:types + build:ci`（fixture env）。本机已全部复现通过。

## 6. 已知架构限制（如实记录）

1. 展示站与 commerce 后端尚未集成（刻意的上线门禁，不是缺陷）。
2. 生产 Redis 处于 pre-ACL 状态；Medusa 激活前必须完成专用 ACL 凭据门禁。
3. 生产 commerce 尚未激活：`/srv/pawshop-source` 钉在 `16cb875`，未跑激活链。
4. 监控/告警层不存在（无 uptime、无错误聚合）。
