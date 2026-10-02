# FRONTEND MULTILINGUAL PHASE 2 — PRODUCT CONTENT LOCALIZATION

## 第一轮：只读审计（未改动任何 production 数据）

- 审计日期：2026-10-02
- 代码基线：`9987495`（`codex/pawshop-real-operations`）
- Medusa 版本：**2.21.0**（`@medusajs/medusa`、`@medusajs/product` 均 2.21.0）
- 数据来源：生产库 `pawshop`（`product` / `product_variant` / `product_option` / `product_option_value` / `image` 表直查）

---

## 1. 当前 published products 内容语言矩阵

生产库共 3 个 product，其中 **2 个 published**、1 个 draft：

| 字段 | Product A（English） | Product B（Chinese） |
|---|---|---|
| id | `prod_01M2X5ZANSGTFSAXQW73YR59K0` | `prod_01M38SZA4FNKKN7MSHE614YF7D` |
| status | published | published |
| handle | `corrugated-cat-lounger`（英文） | `猫抓板`（**中文 handle**） |
| title | `Large High-Density Corrugated Cardboard Cat Scratcher Bed`（en） | `红酒瓶猫抓板耐磨不掉屑立式剑麻绳猫抓柱磨爪逗猫猫咪玩具用品`（zh） |
| subtitle | `Cat Sofa and Lounger for All Seasons`（en） | **空**（NULL） |
| description | 英文一整段 | **空**（NULL） |
| options | `Default option` / `Default option value`（en） | `Default option` / `Default option value`（**en，未本地化**） |
| variants | `Default variant` / `PAW-1`（en） | `Default variant` / `100`、`PAW-CSL-HJ-001`（**variant title en，SKU 是 SKU 不译**） |
| metadata | `<null>` | `<null>` |
| images | 8 张自托管（含 `09-feature-overview-english-1x1.jpg`，**文件名明示"english"**） | 8 张 media 桶（含 `07-advantages-infographic`、`04-dimensions-63cm-track-base`，**中文文案图**） |

> 第三个 product `prod_01M3E8M2CC9F4RQAYQ0MNYBG7K` 是 draft（"Media Upload Verification"），不是客户可见，本审计不展开。

**结论矩阵**：两个 published 商品各自"单语"——A 是全英文，B 是全中文（且 subtitle/description 为空）。**没有任何一个商品同时拥有 en + zh 两套内容。**

---

## 2. mixed-language 根因

根因不是"国际化做了一半"，而是**当前 Medusa 产品模型本身就不支持多语言**：

1. **`product` 表的 `title` / `subtitle` / `description` 是单值 `text` 列**（`NOT NULL` / 可空），一个商品只有一个 title。谁录入就是谁的语言。
2. 商品 A 由早期英文录入路径建立（英文 title/handle/description + 英文 infographic 图）。
3. 商品 B 是店主在后台用中文录入（中文 title、中文 handle `猫抓板`、subtitle/description 留空、图片是中文卖点 infographic）。
4. **没有任何 locale/localized 字段**（见 §3），所以"英文 UI 下显示中文标题"是必然结果——前台 `store-api.js` 的 `normalizeProduct` 把 `raw.title` 原样透传，`PawShop.html` 用 `safeHtml(product.title)` 直接渲染，**中间没有任何按语言选择的逻辑**。
5. 前台 UI 的 i18n（Phase 1）**只覆盖界面文案**，明确"不改商品 title/subtitle/description"；商品内容从未进入 i18n 体系。

---

## 3. Medusa 产品模型是否已有 locale/localized 字段？

**没有。**

- `product` 模型（`@medusajs/product/dist/models/product.d.ts`）字段：`title`、`handle`、`subtitle`、`description`、`is_giftcard`、`status`、`thumbnail`、`weight/length/height/width`、`origin_country`、`hs_code`、`mid_code`、`material`、`discountable`、`external_id`、`collection_id`、`type_id`、`metadata`。
- 全库 `product` 模块 `grep -rniE 'locale|translation|i18n|language'` 返回 **0 命中**。
- `product_variant`、`product_option`、`product_option_value` 同样无 locale 字段，只有各自的 `metadata`（jsonb）。
- 唯一的可扩展点是 **`metadata`（jsonb）**——但当前两个 published 商品的 `metadata` 都是 `<null>`。

结论：**Medusa 2.21.0 原生没有商品内容多语言**，必须自建。

---

## 4. 推荐的最小可靠 en-US / zh-CN 商品内容结构（放在哪）

### 方案对比

| 方案 | 说明 | 结论 |
|---|---|---|
| A. `product.metadata.localized` | 把翻译塞进 product 的 jsonb metadata | ✅ **推荐**：不改表结构、不动 Medusa 模型/迁移、不碰库存/价格/订单/SKU，天然"单一事实源 + 内容分层" |
| B. 新建 `product_translation` 表 | 独立表 `(product_id, locale, title, subtitle, description, ...)` | 更规范，但需要**新增 migration + 模型 + 自定义读写 API**，属于"数据模型/迁移设计"（High），超出第一轮"最小可靠"范围 |
| C. 复制商品（一套 en 一套 zh） | 两个独立 product | ❌ **明确否决**：会复制 SKU/库存/价格，违反"单一事实源"铁律 |

### 推荐：方案 A —— `product.metadata` 里的 `localized` 键

结构（每个商品在 `metadata` 里放一个 `localized` 对象）：

```jsonc
{
  // product.metadata（product 主表）
  "localized": {
    // 默认语言源 = product.title/subtitle/description 本身（不重复）
    "default_locale": "zh-CN",          // 该商品主源语言
    "zh-CN": {                          // 缺省时回落到主字段，可留空对象
      // title/subtitle/description 就是主字段，这里只放"与主字段不同"的覆盖
    },
    "en-US": {
      "title": "Red Wine Bottle Cat Scratching Post ...",
      "subtitle": "Vertical sisal scratching post ...",
      "description": "..."              // 可选
    }
  }
}
```

### 关键设计约束（遵循"单一事实源"）

- **`title`/`subtitle`/`description`/`handle`/`sku`/`variant`/库存/价格 = 主字段，永不复制**。
- **`localized` 只存"非默认语言"的客户可见覆盖**（title/subtitle/description + option/variant 的展示名）。
- **默认语言 = 主字段本身**，不在 `localized` 里重复存一份，避免双写漂移。
- **variant title / option value 的本地化**：variant/option 各自有 `metadata`，同样放 `localized` 键；但本轮最小范围可先只做 product 级（title/subtitle/description），variant/option 留到回填阶段一并处理（当前它们都是英文 "Default option"/"Default variant"，本就是中性占位）。
- **handle 不本地化**（URL 标识，保持英文或原样，避免换 handle 破坏 SEO/链接）。中文 handle `猫抓板` 属于历史数据问题，单独评估是否重命名（见 §8 风险）。

---

## 5. English locale fallback 规则（en-US）

1. `localized.en-US.title` 存在且非空 → 用它。
2. 否则回落到 `title`（主字段）。
3. 若 `title` 是中文且没有 en 覆盖 → **在回填完成前，宁可显示一个诚实的占位（如英文兜底文案），也绝不把中文原样吐给 English 用户**（见 §6）。
4. `subtitle`/`description` 同理：缺 en 覆盖且主字段为中文时，**不显示中文**（subtitle 空可省略，description 空可省略），而不是透传中文。

## 6. Chinese locale fallback 规则（zh-CN）

1. `localized.zh-CN.title` 存在且非空 → 用它。
2. 否则回落到 `title`（主字段）。
3. 因为商品 B 的主字段本就是中文，zh 用户**零成本**；商品 A（英文）在 zh 下要么有 `localized.zh-CN` 覆盖，要么**暂时显示英文原文**（英文标题对中文用户是可接受的降级，比"空"或"机器翻译"都好）。

---

## 7. 如何避免把中文源标题直接显示给 English 用户

**三层防线（按优先级）：**

1. **数据层**：回填 `localized.en-US` 覆盖所有中文主字段商品。回填完成前，中文商品在 en 下没有合法内容。
2. **读取层（`store-api.js::normalizeProduct`）**：加一个纯函数 `localizedText(product, lang, field)`，规则：
   - 取 `product.metadata.localized[lang][field]`；
   - 无则取主字段；
   - **若主字段含 CJK（`/[\u4e00-\u9fff]/`）且当前 lang 是 `en` 且无 en 覆盖 → 返回空/兜底**（不放行中文）。
3. **展示层**：`PawShop.html` 渲染 title/subtitle/description 前，先按当前 `lang` 选文案；CJK 检测兜底保证"英文 UI 绝不出现中文商品文案"。

> 兜底文案本身走 UI i18n 表（例如 en 下 `localization_pending: 'Details coming soon'`，zh 下 `'详情即将上线'`），**不用机器翻译直接面向客户**。

---

## 8. 如何避免为国际化复制出两套独立商品/SKU/库存

- **方案 A（metadata 内嵌）天然避免复制**：翻译是 product 的一层 metadata，商品/SKU/库存/价格/订单/支付/履约全部仍是同一条记录。
- **硬约束清单**：
  - 不新增第二个 product / 不复制 variant / 不复制 inventory item。
  - SKU 仍是 `PAW-CSL-NG-001` 这类单一标识（商品 B 的 `100` / `PAW-CSL-HJ-001` 是 SKU，**永不翻译**）。
  - `localized` 只含 title/subtitle/description（+ 未来 variant/option 展示名），**绝不含 sku/price/stock/handle**。
  - 前台购物车/结算/订单仍引用 `variant.id`/`product.id`，与本地化层完全解耦。
  - 不碰 PayPal / fulfillment / notification（这些引用的是 product/variant id + 金额，与展示文案无关）。

---

## 9. migration / backfill 方案

### 现状
- `product.metadata` 已存在（jsonb，可空），**无需新增 migration**（方案 A 零 schema 变更）。
- 需要的是**数据回填**（backfill），不是 DDL。

### backfill 脚本（一次性，可幂等重跑）
1. 枚举所有 `published` product。
2. 对每个 product，用脚本检测主字段语言（`title` 是否含 CJK）。
3. 生成 `metadata.localized`：
   - 中文商品（B）→ 缺 `en-US` 覆盖。**en-US 的 title/subtitle/description 由店主人工提供**（不机器翻译），脚本只做"写入占位 + 待办清单"，不自动生成译文。
   - 英文商品（A）→ 缺 `zh-CN` 覆盖。同上，zh 覆盖可选（英文主字段已可降级显示）。
4. 回填后 `localized.default_locale` 标记主源语言。
5. 提供 **owner 待办清单**：哪些商品还缺哪种语言的译文，由店主在后台/表格补齐后再次跑回填。

> 关键：**译文是人工创作（不做运行时机器翻译）**。脚本负责"结构 + 占位 + 审计"，不负责"翻译内容"。

---

## 10. 前端读取方案

1. **`store-api.js`**：
   - `normalizeProduct` 增加 `localized` 处理：新增 `localizedText(raw, lang, field)` 纯函数（读 `raw.metadata.localized[lang][field]` → 回主字段 → CJK 兜底）。
   - `PRODUCT_FIELDS` 已默认带 `metadata`（Medusa 默认返回 `*metadata`？需确认）——若未返回，需在 fields 里显式加 `*metadata`。
   - 输出给页面的字段结构：`title/subtitle/description` 已是"按 lang 选好"的值（在 `normalizeProduct` 时传入当前 `lang`），或额外返回 `localized` 原始对象让页面自己选。**推荐前者**：`PawStore.products(regionId, limit, { lang })` 透传语言，`normalizeProduct(raw, lang)` 直接返回选中语言的文案。
2. **`PawShop.html`**：
   - `bootstrap()` 取商品时把当前 `lang` 传给 `store.products(...)`。
   - `setLang()` 切语言后重拉/重渲染商品（或本地缓存原始 localized 再重选，二选一；最小实现=重选本地缓存）。
   - 渲染处 title/subtitle/description 改用已本地化的字段（渲染代码本身几乎不变）。
3. **variant/option 展示名**：第一阶段最小范围可先不动（它们当前是中性英文占位），第二阶段再在 variant/option 的 metadata 放 `localized`。

---

## 11. 测试方案

- **单测（`store-api` 层）**：`localizedText` 纯函数——
  - 有 `en-US` 覆盖 → 返回覆盖。
  - 无覆盖 + 主字段英文 → 返回主字段。
  - 无覆盖 + 主字段中文 + lang=en → 返回兜底（不泄露中文）。
  - zh 下英文主字段 → 返回主字段（可接受降级）。
  - `metadata.localized` 为 null/缺失 → 不崩，走主字段。
- **契约测试（`tests/storefront.test.mjs` 风格）**：mock `/store/products` 返回中文商品 + `metadata.localized.en-US`，断言 en 渲染英文、zh 渲染中文、en 下无 CJK 泄漏。
- **回归**：现有 65 条测试 + 新增 i18n 商品内容测试全绿；`check:security` / `check:html` 不破。
- **不新增 machine-translation 断言**（本方案不用机器翻译）。

---

## 12. 风险点

1. **中文 handle `猫抓板`**：URL/SEO 用中文 handle 不规范，且与"handle 不本地化"原则冲突。是否重命名为英文 handle（如 `wine-bottle-cat-scratcher`）需店主决策——改名会影响已生成的链接/SEO，本轮只标注、不改。
2. **`metadata` 是否被 Store API 默认下发**：需实测 `/store/products` 返回里是否含 `metadata`（Medusa 默认 `*fields` 可能不含 metadata，要在 `PRODUCT_FIELDS` 显式加 `*metadata`）。这是实现前要验证的技术前提。
3. **图片里的语言文字**：商品 A 有 `09-feature-overview-english`，商品 B 有中文 infographic 图。**`metadata.localized` 无法解决"图片里印了什么字"**——需要按 locale 选不同图片集，或重新出中性（无文字）图。这是超出"商品文案"的图片资产问题，单列待办。
4. **subtitle/description 为空**：中文商品 B 的 subtitle/description 是 NULL，即使加了 en 覆盖，主字段仍缺中文 subtitle/description——回填时要一并补。
5. **回填完成前的过渡期**：中文商品在 en 下会显示兜底占位（"Details coming soon"），属于诚实的临时状态，而非错误。店主需知晓。
6. **`localized` 写入路径**：通过 Admin API 或一次性脚本写 `metadata`，要避免覆盖 product 其它 metadata 键（当前是 null，无冲突，但脚本要 merge 而非 replace）。

---

## 13. 最小实施范围（Phase 2 第一轮建议）

**只做，不改 production 数据（本轮已完成只读审计）：**

1. ✅ 只读审计（本报告）。
2. 下一步（待店主确认后再动手）：
   - 验证 `/store/products` 是否下发 `metadata`。
   - `store-api.js` 加 `localizedText` + `normalizeProduct(raw, lang)` 读取层。
   - `PawShop.html` 传 lang + CJK 兜底渲染。
   - 单测 + 契约测试。
   - 提供 owner 待办：哪些商品缺哪种语言译文，人工补齐后跑 backfill 脚本写入 `metadata.localized`。

**明确不做（本轮）：**
- 不改任何商品 title/subtitle/description/图片（等店主补齐译文 + 拍板 handle 命名）。
- 不做机器翻译。
- 不做 Admin 多语言 UI。
- 不改 SKU/库存/价格/订单/PayPal/fulfillment/notification。
