// PawShop 站点配置(部署后只需改这一个文件)
//
// WAITLIST_NOTIFY_EMAIL:预售登记通知邮箱。
// 填你的邮箱后,顾客每次在前台点"Reserve yours free",
// 提交内容会实时发到这个邮箱(首次提交后 FormSubmit 会给你
// 发一封激活邮件,点一次激活即永久生效,免费,无需注册)。
// 留空则不发送,登记只存在顾客自己的浏览器里(你收不到)。

const WAITLIST_NOTIFY_EMAIL = "";

// SERVERCHAN_SEND_KEY:Server酱推送密钥(大陆访客的通知通道,推送到微信)。
// 获取:手机/电脑打开 sct.ftqq.com → 微信扫码登录 → 复制 SendKey 填到这里。
// 每次顾客预留,你的微信会立刻收到推送(免费版每天5条,验证期够用)。
// 海外访客走上面的邮箱通道,两边互为备份。

const SERVERCHAN_SEND_KEY = "";

// TAX_RATE:商品详情页"含税"显示用的综合税率(0=不显示)。
// 例 0.039 = $19.99 商品显示 "含税 $0.78/个"。
// 注意:这是固定展示税率;按顾客地区实时计税需要 P1 后端接税表。
const TAX_RATE = 0.039;
