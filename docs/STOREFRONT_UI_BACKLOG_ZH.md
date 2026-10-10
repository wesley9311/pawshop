# 交给 Codex：登录窗已改在本地，正式站还是旧的

店主验收的唯一地址是 `https://pawlivora.com`。他 2026-10-10 多次打开这个站的登录/注册，看到的仍是旧页面：窗口很宽，「发送验证码」是横贯整窗的黑条，购物车没货时右上角还有黑点「0」。

这些在本地仓库里已经改过，**没有提交，也没有发布**。Codex 不要推倒重写，不要把窗口拉回 680px。先核对工作区里的 `PawShop.html` 是否已是下面的样子；若是，就提交并发布到正式站。若被别的提交盖掉了，按下面的样子改回去再发布。

## 登录/注册必须长这样

文件：`PawShop.html`。

- `#accountPanel` 宽 792px、高 978px（小屏用 `min(792px, calc(100vw - 32px))` 和 `min(978px, calc(100dvh - 32px))`，并加同样的 max-width / max-height，`flex: none`）。这是店主 2026-10-10 按参考图定的尺寸，不要改回 340px 或 680px。没有拖宽把手，不读 `pawshop_account_width`。
- 「发送验证码」「验证并登录」「密码登录」用 `w-full py-3 bg-slate-900 text-white text-sm font-medium rounded-lg`，按钮横贯窗口，和图里一样。
- 登录、验证码、订单、资料、安全的流程不要改。

店主打开 `https://pawlivora.com`，点右上角人头，应看到约 792×978 的登录窗，按钮横贯窗口。屏幕更小则缩进视口。只改本地文件不算完成。

## 怎么发到 pawlivora.com

发布在生产服务器上，用 root 跑 `ops/deploy-static.sh`。脚本要求源码树正好在目标的 40 位提交号上，工作区干净。只提交店面相关文件，不要把无关的 `_commerce` 未跟踪文件提交进去。

本地已改、应一并带上的文件：

- `PawShop.html`（登录窗，以及同一批已写好的店面修复：手机搜索、空搜索文案、分类高亮、结账输入框撑满、空购物车不显示 0、弹层 Esc 和滚动、加购热区、运费选中边框、运费文案、耳机图标改为联系我们）
- `shipping.html`（运费改为「结算时计算」，不要改回「统一运费」）
- `tests/storefront.test.mjs`
- `docs/STOREFRONT_UI_BACKLOG_ZH.md`

发布环境变量按仓库现有约定：`PAWSHOP_SOURCE_DIR` 指向服务器上的检出（`/srv/pawshop/source`），`PAWSHOP_RELEASE_ID` 为完整提交号，`PAWSHOP_HTTPS_ORIGIN=https://pawlivora.com`，`PAWSHOP_HTTP_ORIGIN=http://pawlivora.com`。细节见 `docs/RUNBOOK.md` 第 3 节。发布后用浏览器打开正式站核对登录窗，不要只看本地文件。

## 发布之后还可以做、但这次没做的

不要整站改版，不要换配色，不要动支付和 `_commerce`。做完跑 `npm test` 和 `npm run check:html`。

1. 商品要有自己的网址。详情现在是首页上的弹层，`product.html` 会跳回首页。给每件商品一个可打开的地址，例如 `PawShop.html?product=<id>`。刷新、后退、复制链接都停在该商品。商品不存在时显示找不到。加购、规格、数量行为不变。
2. 首屏缩短。Hero 现在是 `py-16 lg:py-24`。只减少上下留白，让 1366×768 左右能看到第一排商品。不要加新的大图或口号。
3. 选中规格后显示该规格的价格。`priceHtml()` 现在一直用最低价，多规格时显示 “From / 起价”。选定后显示该规格单价；只有还没选定且价格不同时才显示 “From”。购物车行的单价不要改坏。
4. 主按钮圆角统一成 `rounded-lg`。结账「确认并支付」现在是更方的 `rounded`。只改圆角。先确认 `assets/tailwind.css` 里已有 `rounded-lg`，不要为了一个类重编整份 CSS。
5. 政策页只对齐字色。`shipping.html`、`returns.html`、`faq.html`、`privacy.html`、`terms.html` 继续用 `policy.css`，保持单栏文档，不要做成第二个商店首页。深灰字 `#0f172a`，每页能回到 `PawShop.html`。运费页不要改回「统一运费」。
