# 对抗审查报告（Adversarial Review）

- 日期：2026-09-16（第三轮）
- 执行者：WorkBuddy
- 审查基线：`BASE_COMMIT` = `366cc0e3656eb2259e9f4e4002452f142d20a147`（接管前 HEAD）
- 审查范围：`git diff 366cc0e...HEAD` 覆盖的全部变更 + 仓库全历史 + 线上生产面（只读）
- 审查性质：**上线前防御性安全审查**。所有主动测试仅针对本项目本地运行时与自有生产域名，未触碰任何第三方系统。

---

## 1. 方法与取证原则

| 手段 | 说明 |
|---|---|
| 全历史对象扫描 | 遍历 `git rev-list --all --objects` 的 **720 个 blob**（703 个文本、17 个二进制跳过），按 13 类模式匹配密钥/凭据/成本字段 |
| 运行时对抗测试 | 对本地 `local-admin-only` 运行时发起门禁绕过尝试（大小写、百分号编码、双斜杠、点段、方法变体） |
| 决定性验证 | 从本地库取出**有效 publishable key**，在满足 Medusa 内置校验的前提下验证自定义门禁是否独立生效 |
| 真实浏览器验证 | 无依赖 CDP 驱动 headless Chrome，加载全部 11 个页面并捕获 CSP 违规、JS 异常、控制台错误 |
| 线上只读核实 | 仅对自有生产域名作 HTTP/TLS 响应头与内容指纹核对，无任何写操作 |

**重要工具约束（供后续复核者参考）**：本机 `grep` 的 `\|` 交替语法**不生效**（`grep -c "a\|b"` 恒为 0）。本轮早期因此产生过假性"无结果"，所有相关扫描已用 `-E` 重做。后续审查请使用 `grep -E`。

---

## 2. 环境可达性（诚实边界）

| 环境 | 可达性 | 本轮所做的事 |
|---|---|---|
| 本地开发（Medusa dev / PostgreSQL 54329 / 备份恢复 / 测试） | **完全可控** | 启停服务、跑测试、跑构建、备份+恢复演练、对抗测试 |
| 生产静态站（`https://pawlivora.com`） | **只读可达** | 响应头、页面状态、内容指纹、TLS 核对 |
| 生产主机（nginx / systemd / `/etc/pawshop`） | **可达（root SSH）** | 经店主授权执行主机侧操作：读取 nginx 配置、备份、写入 AR-6/AR-7 修复、`nginx -t` 校验、`systemctl reload nginx`（graceful）、双向验证。凭据为 `~/.ssh/pawshop_aliyun_ed25519`（主机 `47.254.26.124`）。**已执行变更，见 §4 AR-6/AR-7** |
| GitHub（Pages 设置 / 分支保护） | **不可达** | `gh` CLI 未安装；无法从本环境修改 Pages 配置 |
| 生产数据库 | **不存在** | commerce 未激活，无生产库可写；本轮对数据库的唯一写入是经店主批准的本地开发库一条 `UPDATE`（见第二轮报告） |

---

## 3. 发现汇总

严重度：P0 阻止上线 / P1 上线前应完成 / P2 可延后。

| ID | 严重度 | 领域 | 状态 |
|---|---|---|---|
| AR-1 | P1 | 安全头/前端 | **已修复** |
| AR-2 | P1 | 合规（隐私声明） | **已修复** |
| AR-3 | P1 | SEO/索引正确性 | **已修复** |
| AR-4 | P2 | 构建可审计性 | **已修复** |
| AR-5 | P2 | 前端缺陷 | **已修复** |
| AR-6 | P1 | 传输安全（HSTS） | **已修复（2026-09-16 生产执行）** |
| AR-7 | P1 | 规范主机/重复内容 | **已修复（2026-09-16 生产执行）** |
| AR-8 | P1 | 第二个公开部署面 | 待店主决策 |
| AR-9 | P2 | 首页交付方式 | 待主机侧优化 |
| AR-10 | P2 | SEO 基础 | 待处理（前置条件 AR-7 已完成） |
| AR-11 | P2 | 信息泄露 | 已登记（影响极低） |
| AR-12 | P2 | CSP 强度 | 已登记（需重构） |
| AR-13 | P2 | CI 覆盖 | 已登记 |
| AR-14 | P1 | 历史信息暴露 | 已登记（需店主决策，禁止重写历史） |
| AR-15 | P2 | 依赖漏洞 | 已登记（上游无补丁） |

---

## 4. 已修复项（AR-1 ~ AR-7）

> **上线状态**：AR-1~AR-5 的修复已随展示站 release `a74aab3` 于 2026-09-16 正式发布到生产（`/srv/pawshop/current` 已切换，上一 release `012666fc…` 保留可回滚）。线上实测这 7 个页面均返回 200 且带 CSP 与 favicon，软 404 在真实浏览器中为 `noindex`，0 CSP 违规。AR-6/AR-7 属主机配置变更，亦已生效。详见 `docs/WORKBUDDY_COMPLETION_REPORT.md` 第四轮。

### AR-1（P1）CSP 仅覆盖 2 个页面 → 现覆盖全部 10 个页面

- **证据（修复前）**：`check-security.mjs` 只对 `PawShop.html`、`product.html` 断言 CSP；`index.html`、`shipping.html`、`returns.html`、`privacy.html`、`terms.html` 及 3 个退役页均无 CSP。
- **风险**：这 5 个页面由 `ops/deploy-static.sh` 的 `public_paths` 明确发布到生产；退役页虽然生产 404，但**在 GitHub Pages 镜像上公开可访问**（见 AR-8）。无 CSP 意味着失去一层纵深防御。
- **修复**：为 8 个缺失页面补 CSP。因这 8 个页面无脚本、无内联样式、无外部引用（已逐项核实），施加的策略比首页**更严格**：

  ```
  default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:;
  font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'
  ```

  （3 个退役页含内联 `<style>`，其 `style-src` 为 `'unsafe-inline'`，`script-src` 仍为 `'none'`。）
- **回归护栏**：`check-security.mjs` 由"检查 2 个页面"升级为**断言仓库内每个 HTML 页面都必须含 CSP**，并把禁用内容扫描面扩展到全部公开页面。输出改为 `Security regression check passed (10 pages, 12 files scanned).`
- **验证**：真实浏览器加载全部 11 个页面 → **零 CSP 违规、零 JS 异常**；`index.html` 的 meta 跳转在 CSP 下正常工作（这是本次最大的回归风险，已实测排除）。

### AR-2（P1）隐私声明与事实不符 → 已修正为可验证的准确表述

- **证据**：`privacy.html` 原文称 *"The site is hosted on GitHub Pages and loads public product media and interface assets from third-party content delivery services."*
- **实测**：
  - 生产域名 `https://pawlivora.com` 响应头为 `Server: nginx/1.24.0 (Ubuntu)`，**不是** GitHub Pages；
  - `catalog.json` 图片全部为 `assets/products/cat-lounger/*.jpg`，与站点**同源**，页面无任何外部域名引用 → 主站**不使用**第三方 CDN。
  - 但 `https://wesley9311.github.io/pawshop/` **确实在线**，且 `PawShop.html` 指纹 `501a6afd…` 与 `origin/main` 完全一致，该旧版 `catalog.json` 含 `"images":[{"…":"https://i.ibb.co/…"}]` → 镜像站**确实**使用第三方图床。
- **结论**：原文对**主站**是错误陈述，对 **Pages 镜像**才成立——而声明没有区分二者。
- **修复**：改为对两个真实公开面都成立的事实描述（自有服务器 + 同源资源、不使用第三方 CDN；并如实披露 Pages 静态镜像及其第三方图床）。标题由 `Public hosting and media` 改为 `Hosting and media`。
- **可逆升级路径**：若店主决定披露具体托管厂商名，替换 `Hosting and media` 段中"a self-managed cloud host"即可，其余措辞无需变动。

### AR-3（P1）`product.html` 软 404 可被索引 → 已修复

- **证据**：`/product.html`、`/product.html?id=999999`、`/product.html?id=abc` 均返回 **HTTP 200**，标题 `PawShop - Product`，正文渲染 `Product not found.`，且无任何 `noindex` → 任意 `?id=` 值都是可索引的软 404。
- **修复**：`product.html` 增加静态 `<meta name="robots" content="index, follow">`，并在渲染逻辑中按状态切换：
  - 商品存在 → `index, follow`
  - **目录已成功加载**但无匹配商品 → `noindex, follow`，标题改为 `Product not found - PawShop`
  - 目录加载失败 → **保持** `index, follow`（避免一次临时故障导致有效商品页被去索引）
- **验证（真实浏览器）**：
  - `/product.html?id=1` → `robots=index, follow`，PDP 渲染 9644 字节
  - `/product.html?id=999999` → `robots=noindex, follow`，`title="Product not found - PawShop"`
  - 单元测试覆盖三种状态（含加载失败分支）

### AR-4（P2）Tailwind 扫描正文产生凭空规则 → 构建已可复现

- **证据**：新增 CSP 后在 `privacy.html` 写下 *"A **static** preview mirror…"*，`npm run build` 随即生成 `.static{position:static}`——因为 `tailwind.config.js` 的 `content: ['./*.html']` 会扫描**全部 HTML 的原始文本（含正文散文）**。
- **风险**：提交的样式产物会随无关文案变动而漂移，"构建产物 == 源码状态"这一可审计前提被破坏。
- **修复**：`content` 收窄为 `['./PawShop.html', './product.html']`——已核实**只有这两个页面引用** `assets/tailwind.css`（4 个内容页用 `policy.css`，退役页用内联 `<style>`）。
- **安全证明**：比对改动前后产物，仅移除 **1 个** token（即凭空产生的 `.static`），**0 个新增**；且脚本断言"被移除的 token 均未被这两个页面引用"通过。
- **结果**：`assets/tailwind.css` 与已提交版本**字节完全一致**，连续两次构建均无漂移。

### AR-5（P2）5 个页面未声明 favicon → 产生生产 404

- **证据**：`index.html` 与 4 个内容页无 `<link rel="icon">`，浏览器按惯例探测 `/favicon.ico` → 404，控制台报错。（`favicon.svg` 本身返回 200。）
- **修复**：为 5 个页面补齐 `<link rel="icon" href="favicon.svg" type="image/svg+xml">`。
- **验证**：清零访问日志后重跑浏览器全量检查，**49 次请求中 404 数为 0**，控制台错误清零。

### AR-6（P1）生产缺 `Strict-Transport-Security` —— 已于生产修复

- **证据（修复前）**：`curl -sI https://pawlivora.com/` 只返回 `X-Content-Type-Options: nosniff` 与 `X-Frame-Options: DENY`，**无 HSTS**。缺失 HSTS 意味着首次访问仍可被 SSL-strip 降级。
- **门禁先行**：新增 `npm run verify:production:strict`（`scripts/verify-production-strict.mjs`），断言 HSTS 存在且 `max-age ≥ 15552000`。修复前实测：`Strict production verification failed: HTTPS root is missing a Strict-Transport-Security max-age directive.`
- **为何不并入 `verify:production`**：该命令承载"部署是否成功"的语义，把主机侧缺口混进去会污染部署判定。严格校验独立存在，主机修好后即可提升为硬门禁。
- **修复（2026-09-16，生产主机 root）**：在 `/etc/nginx/sites-available/pawshop` 的 HTTPS 内容 `server` 块内、既有 `add_header` 之后加入 `add_header Strict-Transport-Security "max-age=15552000" always;`。改动前已 `cp -a` 备份至 `/root/pawshop-nginx-pawshop.bak-20260916T070651Z`；经 `nginx -t` 通过后 `systemctl reload nginx`（graceful，无中断）。
- **修复后实测**：`Strict-Transport-Security: max-age=15552000` 已下发；既有 `X-Content-Type-Options` / `X-Frame-Options` 仍在；`verify:production:strict` **转为 PASS**。
- **回滚**：删该行 → `nginx -t` → reload。注意 HSTS 被浏览器缓存后，在 `max-age` 到期前无法由服务端撤销，故从 180 天起步、先不含 `includeSubDomains`。

### AR-7（P1）`www` 未规范化 → 重复内容 —— 已于生产修复

- **证据（修复前）**：`https://www.pawlivora.com/` 返回 **200**（非 301/308），且与 apex 内容 **MD5 完全一致**（`29aaa54af4011c159782ba4df983b5f2`）→ 同一内容由两个主机名提供。根因：HTTPS 内容块 `server_name` 同时含 apex 与 `www`；80 端口块重定向用 `$host`，把 `www` 原样保留。
- **前置核实**：证书 SAN 已覆盖 `pawlivora.com` **与** `www.pawlivora.com`（Let's Encrypt，有效期至 2026-12-06，`certbot.timer` 自动续期）→ 在 www 上做 HTTPS 跳转不会中断 TLS。两主机名均解析到同一 IP `47.254.26.124`。
- **修复（2026-09-16，生产主机 root）**：在同一 HTTPS 内容块内加 server 级 `if ($host = www.pawlivora.com) { return 301 https://pawlivora.com$request_uri; }`。选此做法（而非新增独立 server 块）是因为改动最小，且与 certbot 自生成的 `if ($host = …)` 模式一致，续期时不会被改写；server 级 `if` 先于 location 匹配，故经 `www` 访问 `/admin.html` 也先跳 apex 再 404，**门禁未被绕过**（实测 `admin_status=404`）。
- **修复后实测**：`https://www.pawlivora.com/` → `301`，`Location: https://pawlivora.com/`；apex 仍 `200`；`http://pawlivora.com/` → `301` 到 `https://pawlivora.com/`。
- **已知小瑕疵（已接受）**：`http://www.pawlivora.com/` 需两跳（80 端口块属 certbot 托管行，本轮未改）。HTTPS 侧已是单跳，规范 URL 无实质 SEO 损失。
- **回滚**：删该 `if` 块 → `nginx -t` → reload；或还原备份文件。

---

## 5. 待处理项（AR-8 ~ AR-15）

### AR-8（P1，需店主决策）陈旧 GitHub Pages 镜像仍在公开服务已被撤回的声明

- **证据链**：

  | 产物 | MD5 |
  |---|---|
  | `origin/main` PawShop.html / catalog.json | `501a6afd…` / `64482cb6…` |
  | **Pages 站** PawShop.html / catalog.json | `501a6afd…` / `64482cb6…`（**与 main 完全一致**） |
  | 工作分支 PawShop.html | `8de3ad55…` |
  | **线上 pawlivora.com** PawShop.html | `8de3ad55…` |

  Pages 自动发布的是**陈旧的 `main`**，而生产跑的是工作分支。该旧版 `catalog.json` 公开包含：
  - `"stock": 100`（未经验证的库存声明）
  - `"originalPrice": 39.9`（未经验证的参考价/折扣声明）
  - `"availability": null`（**缺失** `prelaunch` 门禁）
  - 图片指向 `https://i.ibb.co/...`（第三方图床）

  而 `scripts/check-security.mjs` 与 `ops/deploy-static.sh` **都明令禁止** `stock` / `originalPrice` / 非 `prelaunch` 进入公开目录——即该镜像正在公开违反项目自身的数据边界契约。
- **补充探测（限缩影响面）**：`ops/`、`docs/`、`tests/`、`scripts/`、`package.json`、`PRODUCTION_HANDOFF_ZH.md`、`_commerce/` 在 Pages 上**均为 404**；`README.md`、`config.js`、`safe.js` 为 200。`admin.html` 返回 200，但内容为当前的无害占位页（1859 字节，`pawshop2026` / `github_pat_` / `costCNY` 等敏感模式**零命中**）→ **无凭据泄露**。
- **影响**：面向美国市场（`config.js` 的 `primaryMarket: 'US'`）公开挂着一个已撤回的折扣/库存声明，属合规风险；同时构成 SEO 重复内容；且该面完全不在任何门禁覆盖内。
- **修复选项**（均需店主决策，本轮未执行）：
  1. **把 `main` 更新到已验证状态**（合并工作分支或开 PR）→ Pages 自动重新发布为正确内容。注意：这会让 Pages 与生产一致，但仍保留第二个公开面。
  2. **关闭 GitHub Pages** → 消除第二个公开面。需 GitHub 仓库设置操作（本环境无 `gh` CLI，无法代办）。
  3. 维持现状并接受风险（**不推荐**：公开的未验证折扣声明）。

### AR-9（P2）首页靠客户端 meta 跳转

- **证据**：`https://pawlivora.com/` 返回 `Content-Length: 116`，内容是 `index.html` 的 `<meta http-equiv="refresh" content="0;url=PawShop.html">`；`PawShop.html` 才是真实首页。
- **影响**：SEO 权重传递不如服务端 301；无 JS/禁用刷新时体验差。
- **注**：这是为兼容 GitHub Pages（无法做服务端重定向）而做的可移植选择，`_config.yml` 亦印证。建议在主机侧改为服务端重写（详见 RUNBOOK §9.3），仓库内保留 meta 兜底。

### AR-10（P2）缺 `sitemap.xml`

- **证据**：`https://pawlivora.com/sitemap.xml` → **404**；`robots.txt` 200。
- **为何本轮未添加**：sitemap 的 URL 集合依赖 AR-7/AR-9 的规范主机与首页决策（`www` vs apex、`/` vs `/PawShop.html`）。在规范化方案确定前提交 sitemap 会把一个即将改变的规范选择固化下来。建议与 AR-7 一并处理。

### AR-11（P2）`X-Powered-By: Express` 信息泄露

- **证据**：本地运行时响应含 `X-Powered-By: Express`（Medusa 默认未关闭）。
- **影响**：**极低**——生产为回环监听 + SSH 隧道，无公网暴露面。登记备查。

### AR-12（P2）两个动态页依赖 CSP `script-src 'unsafe-inline'`

- **证据**：`PawShop.html` / `product.html` 的 CSP 含 `script-src 'self' 'unsafe-inline'`，因页面大量使用内联 `onclick=` 属性与内联 `<script>`。
- **影响**：削弱 CSP 对注入类 XSS 的防护。**当前实际风险低**：目录数据全部经 `PawSafe` 包装转义（`safeHtml/safeUrl/safeIcon/safeId/safeToken`），页面不采集也不提交任何用户数据（唯一 `fetch` 是本地 `catalog.json`），且 CSP 已设 `form-action 'none'`。
- **加固路径**：把内联事件处理器改为 `addEventListener` + 外置脚本，改用 nonce/hash。属重构，登记为 P2。

### AR-13（P2）CI 不覆盖工作分支

- **证据**：`.github/workflows/quality.yml` 触发条件为 `pull_request` 与 `push: branches: [main]`。当前工作分支 `codex/pawshop-real-operations` 的推送**不触发 CI**（除非存在 PR）。
- **影响**：分支上的提交缺少自动化校验信号。
- **建议**：开 PR 以启用 CI，或把 `codex/**` 纳入触发分支。

### AR-14（P1，需店主决策）公开 Git 历史含供应商成本字段

- **复核证据**：全历史扫描命中 `costCNY` 共 **39 个 blob**；`git log --all -S costCNY` 命中 8 个提交，其中 `catalog.json` 相关 3 个（`5eef94b`、`23202af`、`5efc128`）。实际泄露内容为真实成本数据（如 `"costCNY": 23` 与 `"price": 29.9` 并存 → 直接暴露毛利）。
- **当前状态**：工作树已清除，且 `check-security.mjs` 将 `costCNY/supplier/supplierLink/paymentLink` 列为公开目录禁止字段（永久防护）。
- **处置**：仓库为公开 GitHub 仓库，历史对任何克隆者可见。因"重写 Git 历史"被明确禁止，本轮**只登记不处置**。选项：转私有仓库 / 经店主批准后用 `git filter-repo` 重写并协调所有克隆方 / 评估后接受。

### AR-15（P2）传递依赖漏洞（上游无补丁）

- **证据**：`npm audit --omit=dev`（`_commerce`）：73 条（6 moderate + 67 high）。经 `--json` 拆解为**单一根因扇出**：`lodash@4.17.23` 经 `@graphql-codegen/plugin-helpers` 进入整个依赖链；lodash 已是当前最新版，两条 advisory 上游无修复版本。npm 建议的 `--force` 修复会把 `@medusajs/file-s3` 降到 `0.0.3`，属有害操作，已明确排除。
- **缓解依据**：生产为 admin-only + 回环监听 + Store/Customer API 无条件 503，无公网 API 面。
- **登记**：见 `docs/RELEASE_GATES.md` RISK-2。

---

## 6. 验证为安全的控制（正向结论）

以下均为**实测**结论，非推断。

### 6.1 Storefront 门禁（本项目最核心的信任边界）——决定性验证

对本地运行时发起绕过尝试，全部被拒（无任何 2xx）：

| 请求 | 结果 |
|---|---|
| `/store/products`、`/store/carts`、`/store/customers`、`/store/orders`、`/store/regions` | **503** `PawShop storefront APIs are not open.` |
| `/STORE/products`、`/Store/products` | 400（路径匹配不区分大小写，仍被拒） |
| `/%73tore/products`、`/st%6Fre/products`、`/store%2fproducts` | 404（无匹配路由，仍被拒） |
| `/store/products/../products`、`/./store/products`、`/store/./products` | 400（点段不构成绕过） |
| `/auth/customer/emailpass`、`/auth/customer/emailpass/register`、`/auth/customer/emailpass/reset-password`、`/auth/customer/google`（含 POST） | **503** |
| `POST /store/carts`、`POST /store/customers`、`POST /store/orders` | **503** |

**关键点**：无 key 时观察到的 400 来自 Medusa **内置** publishable-key 校验，而非我们的中间件。为排除"门禁只是搭了内置校验的便车"，从本地库取出**有效 publishable key** 并带上请求——

```
/store/products  -> 503 {"type":"not_allowed","message":"PawShop storefront APIs are not open."}
/store/carts     -> 503  （同上）
/store/customers -> 503  （同上）
/store/regions   -> 503  （同上）
/store/orders    -> 503  （同上）
```

**结论**：自定义 503 门禁在满足内置校验的前提下**独立生效**，storefront 关闭是真实控制。监控的 `storeRouteIsClosed(status)` 采用"非 2xx 即视为关闭"的判定，因此不会被 400/503 的差异误导 —— 设计稳健。

### 6.2 Admin 授权边界

| 请求 | 结果 |
|---|---|
| `GET /admin/products`、`/admin/users/me`、`/admin/orders` | **401** |
| `POST /admin/products`、`POST /admin/api-keys`（未鉴权） | **401** |
| `GET /auth/user/emailpass` | 401（端点可达，需凭据） |
| `GET /app`（管理 UI） | 200 |

### 6.3 CORS 与跨源读取

- 以 `Origin: https://evil.example` 发起预检与实际 `GET /admin/products` → 响应**不含** `Access-Control-Allow-Origin` → 浏览器阻断跨源读取。✓
- 会话 Cookie（Medusa 源码 `resolveSessionCookieSecurity`）：生产为 `sameSite: 'lax'` + `secure: true`，`httpOnly` 由 express-session 默认为 `true`；源码注释明确 `sameSite: 'none'` 被刻意避免（防 CSRF，关联 GHSA-jhvc-qx3m-6r3q）。✓

### 6.4 全历史密钥扫描（720 blob）

| 模式 | 命中 | 判定 |
|---|---|---|
| AWS / GitHub / OpenAI / 阿里云 / Slack / Google / 私钥 / JWT / Bearer | **0** | 无凭据 |
| 带口令连接串 | 49（去重后 4 个文件） | 全部为占位符或测试 fixture：`replace-me`、`build_fixture:not-a-credential`、`ci:fixture`、`$app_password` 变量插值、localhost 测试值 → **无真实凭据** |
| `costCNY` 等成本字段 | 39 | 真实商业数据泄露 → **AR-14** |

### 6.5 注入与破坏性操作

- `_commerce` 内全部 `spawn` / `spawnSync` / `execFileSync` 均使用**参数数组**（无 shell 拼接）→ 无命令注入面。
- `ops/` 与 `_commerce/scripts/` 中**不存在** `DROP` / `TRUNCATE` / `DELETE FROM` / `chmod 777` / `curl | sh`；`rm -rf` 仅出现 7 处，全部作用于受控的 `$staging_dir` / `$work_dir` / `$release_dir` 并带 `--` 终止选项解析。
- 生产凭据处理：写入 root-only `0600` JSON，读取时校验 `O_NOFOLLOW` + 属主/属组/权限/大小，并有 `setgroups/setgid/setuid` 降权；`provision-production-owner-credentials.mjs` 明确**不打印**口令。
- `create-production-owner.mjs` 拼接 SQL 时插值 email，但 email 受严格正则约束（不允许引号）→ 无注入。

### 6.6 前端数据边界

- 唯一网络请求是 `fetch('catalog.json')`；**没有任何表单提交、支付、埋点、Cookie**；`config.js` 的 `inquiryEnabled: false`、`checkoutEnabled: false`。
- XSS 卫生：所有插值经 `PawSafe` 包装（`html/url/icon/token/id/quantity/catalog`）；`safe.url()` 拒绝非 http(s) 与跨源、`safe.catalog()` 按契约过滤（要求 `availability === 'prelaunch'`、拒绝含 `stock` 的条目）。购物车从 `localStorage` 恢复时用 `PawSafe.quantity()` 净化，`item.id`/`name`/`price` 全部回填自经 `safe.catalog()` 过滤的目录 → **localStorage 投毒无法构成 XSS**。
- `scripts/check-security.mjs` 持续禁止公开目录出现 `costCNY/supplier/supplierLink/paymentLink/stock/originalPrice` 与非 `prelaunch` 可用性。

### 6.7 生产静态站（只读核实）

`/`、`/PawShop.html`、`/product.html?id=1`、`/shipping.html`、`/returns.html`、`/privacy.html`、`/terms.html`、`/robots.txt`、`/favicon.svg`、`/policy.css`、`/assets/products/cat-lounger/01-hero-1x1.jpg` **全部 200**；`admin.html` / `dashboard.html` / `account.html` **404**（符合设计）；`sitemap.xml` 404（AR-10）；`http://` → `https://` **301**；含 `X-Content-Type-Options: nosniff` 与 `X-Frame-Options: DENY`。

---

## 7. 回归证据（本轮修复后重跑）

### 根目录（静态站）

```
npm run check        -> Security regression check passed (10 pages, 12 files scanned).
                        Public catalog boundary check passed.
                        node --test: tests 20 / pass 20 / fail 0
npm run check:html   -> exit 0 (html-validate, 9 pages)
npm run build        -> exit 0；assets/tailwind.css 与已提交版本字节一致，连续两次构建无漂移
```

### 真实浏览器（无依赖 CDP + headless Chrome）

```
[OK] /                          final=http://127.0.0.1:4173/PawShop.html   grid=1199B
[OK] /PawShop.html              grid=1199B（目录数据经 fetch 渲染成功）
[OK] /product.html?id=1         robots=index, follow        pdp=9644B
[OK] /product.html?id=999999    robots=noindex, follow      title="Product not found - PawShop"
[OK] /privacy.html /shipping.html /returns.html /terms.html
[OK] /admin.html /dashboard.html /account.html
BROWSER_CHECK: PASS     零 CSP 违规 · 零 JS 异常 · 49 次请求中 0 个 404
```

### commerce 后端

```
npm test             -> tests 70 / pass 70 / fail 0
npm run check:types  -> tsc --noEmit exit 0
npm run build:ci     -> exit 0（backend 4.20s / frontend 12.94s）
```

### 生产验证

首次运行（修复前）：

```
verify:production         -> PASS（语义未变，1 个活跃商品）
verify:production:strict  -> FAIL：HTTPS root is missing a Strict-Transport-Security max-age directive.
                             （这是 AR-6 的真实缺口被机器检出，属预期结果）
```

主机侧修复 **AR-6 + AR-7** 后重跑（2026-09-16）：

```
verify:production         -> PASS（1 个活跃商品）
verify:production:strict  -> PASS：HSTS max-age 15552000s; www redirects to the apex origin.
curl -sI https://pawlivora.com/        -> 200 + HSTS + X-Content-Type-Options + X-Frame-Options
curl -sI https://www.pawlivora.com/    -> 301 Location: https://pawlivora.com/
curl -sI http://pawlivora.com/         -> 301 Location: https://pawlivora.com/
https://pawlivora.com/admin.html       -> 404（路由门禁未被跳转绕过）
```

展示站发布 **release `a74aab3`** 后（AR-1~AR-5 上线），再对**线上**跑真实浏览器与监控：

```
真实浏览器（headless Chrome，直接访问 https://pawlivora.com）：
  /                        -> OK，落到 PawShop.html，商品网格渲染 1199B
  /PawShop.html            -> OK，网格渲染
  /product.html?id=1       -> OK，PDP 渲染 9644B，robots=index, follow
  /product.html?id=999999  -> OK，robots=noindex, follow（软 404 修复在线上生效）
  privacy/shipping/returns/terms -> OK
  admin/dashboard/account  -> 404（线上按设计屏蔽；本地文件检查器记为 FAIL，属预期差异）
  CSP 违规 0；JS 错误 0
监控冒烟：storefront_security_headers -> ok（修复前为失败项）
          storefront_https_redirect  -> ok（301 -> https://pawlivora.com/）
          tls_certificate            -> ok（剩余 80 天）
```

发布前已逐文件 sha256 比对，确认**只变更 7 个文件**且 `catalog.json` 未变（无商品/内容变更）；上一 release `012666fc…` 保留，可一键回滚。

---

## 8. 本轮刻意未做的事（及原因）

1. **未改 80 端口块（certbot 托管行）**：`http://www` 因此保留两跳（`→ https://www → https://apex`）。HTTPS 侧已是单跳，故未为省一跳去改动 certbot 托管内容（详见 AR-7）。
2. **未动 `main` 分支、未改 GitHub Pages 设置**：AR-8 涉及公开面的增删，属店主决策。
3. **未重写 Git 历史**：AR-14 受明令禁止。
4. **未添加 `sitemap.xml`**：AR-7 已完成（规范主机定为 apex），前置条件已满足；但 `scripts/production-probe.mjs` 断言 `/` 必须返回 200，故 AR-9 的首页交付方式需先定方案，再与 AR-10 一并处理（见 `docs/RUNBOOK.md` §10.3）。
5. **未重构内联事件处理器**：AR-12 属 P2 重构，且当前无用户数据流，风险低。
6. **未升级/降级依赖**：AR-15 上游无补丁；npm 建议的修复有害。
7. **未做跨浏览器矩阵测试**：本轮用 headless Chrome 覆盖了功能与 CSP 正确性；Safari/Edge 与移动端视口仍未取得执行证据，门禁保持 FAIL 而非虚报 PASS。

---

## 9. 门禁变化（详见 `docs/RELEASE_GATES.md`）

| 门禁 | 变化 |
|---|---|
| TEST（根） | 14 → **20**（新增严格校验与软 404 行为测试） |
| SECURITY | CSP 覆盖面 2 → **10 个页面**，并由回归检查强制；隐私声明事实性错误已修正；**生产 HSTS 已补齐（AR-6）** |
| MOBILE | 仍为 **FAIL**，但本轮首次取得真实浏览器执行证据（Chrome，11 页面功能正确、无 CSP 违规）；跨浏览器/移动视口仍无证据 |
| SEO | 新增软 404 修复与 favicon 修复；**`www`→apex 已规范化（AR-7）**；sitemap 与 canonical 待补（AR-10，前置条件已满足） |
| HOST（新） | AR-6/AR-7 由"待主机侧修复"转为**已在生产执行并验证**；`verify:production:strict` 由 FAIL → **PASS** |
| PRODUCTION_DEPLOY | 标准验证 PASS；严格验证 **PASS**（修复 2 项主机侧缺口后） |
| DEPLOY（新） | AR-1~AR-5 由"仅仓库"转为**已发布到生产**（release `a74aab3`）；发布前逐文件哈希比对确认只动 7 个文件且 `catalog.json` 未变；线上真实浏览器 0 CSP 违规 |
