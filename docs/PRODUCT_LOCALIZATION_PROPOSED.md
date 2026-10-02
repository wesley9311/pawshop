# FRONTEND MULTILINGUAL PHASE 2 — PRODUCT CONTENT LOCALIZATION
## Proposed localization payload / diff（DRY-RUN，未写入 production）

- 日期：2026-10-02
- 代码基线：`9987495`（本次实现改动的提交见后续）
- **状态：本文件是 dry-run 提案。production 的 `product.metadata` 仍为 `null`，未做任何写库。**
- 数据契约：`product.metadata.i18n`（零 schema 变更，沿用 `metadata` jsonb）。

---

## 0. 数据契约（本实现采用的最终结构）

```jsonc
{
  // product.metadata.i18n
  "default_locale": "en-US",          // 主字段语言（主字段 title/subtitle/description 即此语言，不重复存）
  "translations": {
    "zh-CN": {                        // 只存「非默认语言」的客户可见覆盖
      "title": "……",                  // 可选，缺省回落主字段
      "subtitle": "……",               // 可选
      "description": "……"             // 可选
    }
  }
}
```

约束（沿用审计 §4/§8，铁律不变）：
- **不复制商品/SKU/库存/价格**：翻译是 `metadata` 的一层，商品仍是同一条记录。
- `title/subtitle/description` 主字段永不复制；`handle`/`sku`/`variant`/库存/价格 永不进 `i18n`。
- `i18n` 只含 title/subtitle/description 的覆盖，**绝不含 sku/price/stock/handle**。
- 写入时 **merge 而非 replace**（当前 metadata 是 null，但脚本仍要按 merge 语义写，避免未来覆盖其它键）。

---

## 1. 两商品 proposed `metadata.i18n` diff

### 1.1 Product A（English，`prod_01M2X5ZANSGTFSAXQW73YR59K0`）

主字段（default_locale = `en-US`，保持不变）：
- title：`Large High-Density Corrugated Cardboard Cat Scratcher Bed`
- subtitle：`Cat Sofa and Lounger for All Seasons`
- description：`Designed for cats of all ages and sizes. The low-profile design makes it easier for short-legged and senior cats to get on and off, reducing the need to jump and providing a comfortable place to rest. Material: High-Density Corrugated Cardboard.`

**proposed 写入（补 zh-CN 覆盖）**：

```jsonc
{
  "i18n": {
    "default_locale": "en-US",
    "translations": {
      "zh-CN": {
        "title":   "«OWNER: 高密度瓦楞纸板猫抓板大床 —— 待店主人工撰写»",
        "subtitle":"«OWNER: 四季通用猫沙发与躺卧垫 —— 待店主人工撰写»",
        "description": "«OWNER: 中文完整描述 —— 待店主人工撰写»"
      }
    }
  }
}
```

> ⚠️ **译文需店主人工撰写**，不做机器翻译。`«OWNER: …»` 是占位标记，**不是**最终文案，**不得**按占位原样写入 production。

### 1.2 Product B（Chinese，`prod_01M38SZA4FNKKN7MSHE614YF7D`）

主字段（default_locale = `zh-CN`，保持不变）：
- title：`红酒瓶猫抓板耐磨不掉屑立式剑麻绳猫抓柱磨爪逗猫猫咪玩具用品`
- subtitle：`<null>`（缺）
- description：`<null>`（缺）

**proposed 写入（补 en-US 覆盖）**：

```jsonc
{
  "i18n": {
    "default_locale": "zh-CN",
    "translations": {
      "en-US": {
        "title":   "«OWNER: Red Wine Bottle Cat Scratching Post — vertical sisal post… 待店主人工撰写»",
        "subtitle":"«OWNER: 待店主人工撰写（当前主字段为空，en 下无内容则省略）»",
        "description": "«OWNER: 待店主人工撰写（当前主字段为空）»"
      }
    }
  }
}
```

> ⚠️ 商品 B 的 subtitle/description 主字段是 NULL，即使补了 en 覆盖，zh 下 subtitle/description 仍是空——回填时要一并补中文 subtitle/description（店主决策，见 §3 待办）。

---

## 2. 过渡期行为（回填完成前，前端已上线后）

| 场景 | 当前语言 | 结果 |
|---|---|---|
| 商品 B（中文） | en | 主字段含 CJK 且无 en 覆盖 → 标题回落为空 → 前端显示诚实占位 `Details coming soon`（**绝不显示中文**） |
| 商品 B（中文） | zh | 显示中文主字段（零成本） |
| 商品 A（英文） | zh | 无 zh 覆盖 → 显示英文主字段（可接受降级） |
| 商品 A（英文） | en | 显示英文主字段（零成本） |
| 任一商品 `metadata` 为 null/缺 `i18n` | 任意 | 不崩，走主字段 + CJK 兜底 |

---

## 3. Owner 待办（本轮 dry-run 遗留）

1. **商品 B 的 en-US 译文**（title 必填；subtitle/description 可选，主字段为空）。
2. **商品 A 的 zh-CN 译文**（title/subtitle/description 可选，缺则英文降级）。
3. **商品 B 的中文 subtitle/description**（当前主字段 NULL，与 i18n 无关的历史缺漏）。
4. **中文 handle `猫抓板` 是否重命名**（本轮不改，单独决策）。
5. **图片里的语言文字**（A 的 `09-feature-overview-english`、B 的中文 infographic）——`metadata.i18n` 无法解决图片内文字，需重出中性图或按 locale 选图，另列 backlog。

---

## 4. 写入方式（拿到店主译文后，再跑，本轮不跑）

一次性幂等 backfill（merge 语义，仅写 `metadata.i18n` 键，不动其它 metadata 键）：
- 经 Admin API `POST /admin/products/:id` 带 `metadata`，或一次性脚本 `UPDATE product SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{i18n}', $payload::jsonb) WHERE id=$id`。
- 写前 `SELECT id, title, metadata FROM product WHERE id IN (...)` 见证；写后回读对比。
- 不触发迁移、不删库、不动价格/库存/SKU/PayPal/fulfillment/notification。
