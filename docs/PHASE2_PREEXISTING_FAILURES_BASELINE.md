# Phase 2 Loopback Acceptance — 既有失败 Baseline（发布前已存在）

> 目的：Owner 要求「现有 `order-lookup-fulfillment.test.cjs` 的 3 个既有失败必须保存『发布前已存在』的精确 baseline；本轮不得增加新的失败。不要顺手修它们。」
>
> 本文件记录发布前（HEAD=`9a2efb4`）该测试文件的精确失败状态，作为 Phase 2 sensitive release 时「未新增失败」的对照基准。

## 1. 精确 baseline

- 提交：`9a2efb4`（HEAD，Phase 2 代码尚未提交/推送前的既有状态）
- 测试文件：`_commerce/tests/order-lookup-fulfillment.test.cjs`（**自 HEAD 未改动**）
- 被引用的实现文件：`_commerce/src/api/store/pawshop-orders/[id]/route.ts`、`_commerce/src/lib/order-lookup.cjs`（**自 HEAD 未改动**）
- 运行结果：**26 项测试，23 pass / 3 fail**

## 2. 3 个既有失败（精确名称 + 序号）

| 序号 | 测试名 | 失败原因 |
| --- | --- | --- |
| 21 | `the route serializes fulfillments through the shared mapper` | 测试断言 route 调用 `mapFulfillments(order.fulfillments)`，与当前 route 源码实现不一致（源码漂移） |
| 22 | `the route requests the fulfillment whitelist and nothing else` | 测试断言 `...LOOKUP_FULFILLMENT_FIELDS` 展开，与当前 route 源码不一致 |
| 26 | `item quantity is defensively serialized, never undefined` | 测试断言 `Number.isFinite(Number(item.quantity))`，与当前 route 源码不一致 |

## 3. 结论

- 这 3 项失败**早于 Phase 2**（Phase 2 只新增 `pawshop-otp-email-auth` provider + 接线 + 前端 UI，未触碰 `pawshop-orders` 路由或 `order-lookup` 序列化）。
- Phase 2 的 `otp-email-auth.test.cjs`（新增 13 项）与 `production-modules.test.cjs`（更新 provider 集断言）**全部通过**，不在这 3 项失败之列。
- **发布门禁**：sensitive release 后重新跑 `order-lookup-fulfillment.test.cjs`，必须仍为 **23 pass / 3 fail**（同样的 3 项：21/22/26），不得新增失败。这 3 项失败**保持原样，不修复**。

## 4. 验证命令（复现 baseline）

```bash
cd _commerce
node --test tests/order-lookup-fulfillment.test.cjs 2>&1 | grep -E "not ok"
# 期望输出：
# not ok 21 - the route serializes fulfillments through the shared mapper
# not ok 22 - the route requests the fulfillment whitelist and nothing else
# not ok 26 - item quantity is defensively serialized, never undefined
```
