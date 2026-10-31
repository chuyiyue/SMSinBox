# SMSinBox

自部署的短信收件箱。手机把短信 POST 到 Cloudflare Worker，内容写入 D1，你在网页里查看、搜索，并复制验证码。

管理员登录后可以添加其他用户。每个人只看到自己的设备和短信，没有公开注册页。Worker 同时提供 API 和静态页面。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/chuyiyue/SMSinBox)

部署按钮使用 GitHub 上默认分支的代码。本地改动需要先推送到该仓库，按钮才会带上这些改动。按钮不会代替下面的数据库迁移和密钥设置。

## 部署

需要 Node.js 20+ 和 Cloudflare 账号。

```bash
npm install
npx wrangler login
npx wrangler d1 create smsinbox
```

把命令输出的 `database_id` 写进 `wrangler.jsonc` 的 `d1_databases`：

```jsonc
"database_id": "这里换成创建结果里的 UUID"
```

`database_id` 可以留空。Wrangler 4 不强制填写；若 `wrangler deploy` 提示缺少数据库，再按上面的方式创建并填上。

接着迁移数据库、设置管理员密钥并部署：

```bash
npx wrangler d1 migrations apply smsinbox --remote
printf '%s' '你的用户名' | npx wrangler secret put ADMIN_USERNAME
printf '%s' '一段足够长的密码' | npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

`secret put` 会读取标准输入，避免密码出现在 shell 历史里。两个密钥都要设置。部署完成后打开 Worker 的 `*.workers.dev` 地址，用这两个值登录。第一次成功登录会在 D1 里创建管理员。

可选：把短信正文、验证码和原始请求体用 AES-GCM 加密后再写入 D1。不设置时保持明文，已有短信不用迁移。密钥是 32 字节的 base64，用 secret 覆盖空的 `CONTENT_KEY` 变量：

```bash
openssl rand -base64 32 | npx wrangler secret put CONTENT_KEY
```

更换或清空这个密钥之后，之前加密的短信无法再解密，收件箱会显示无法解密。部署含 `0003_message_encryption.sql` 或 `0004_users.sql` 的版本后，同样需要再执行一次数据库迁移。

之后如果改了 `ADMIN_PASSWORD`，用新密码再登录一次即可。程序会在用户名与密钥一致时更新保存的口令哈希，并把这个账号设为管理员、取消停用。只改密钥、还没用新密码登录之前，旧密码仍然有效。升级到多用户之后，已有账号的角色默认是普通用户，需要用这对密钥再登录一次才会变成管理员。

自定义域名可以在 Cloudflare 控制台里给这个 Worker 加路由，接口和页面都在同一个域名下。

### 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

打开 Wrangler 打印的本地地址。本地是 HTTP，会话 Cookie 不会带 `Secure`；部署到 Cloudflare 之后是 HTTPS，Cookie 会带 `Secure` 和 `HttpOnly`。

## 接收短信

创建设备后，页面只显示一次 token。请求：

```http
POST /api/v1/sms
Authorization: Bearer <设备 token>
Content-Type: application/json
```

成功时返回 `{ "ok": true, "id": "...", "code": "123456" }`。没有识别出验证码时 `code` 为 `null`。同一设备、同一发件人、同一段规范化正文，在同一分钟内再报一次，返回 200，并带 `"duplicate": true`，不会再插一条。

也接受 `application/x-www-form-urlencoded`。字段别名：`from` / `sender`，`content` / `text` / `msg` / `body` / `sms`，`timestamp` / `receive_time`，以及 `device`、`sim`、`to`。没有时间戳，或时间超出当前时间前后合理范围时，用服务器收到请求的时间。不带时区的 `YYYY-MM-DD HH:mm:ss` 按 UTC 解析。

每个 token 每分钟最多 60 次，超出返回 429。

### Android SmsForwarder

1. 安装 [SmsForwarder](https://github.com/pppscn/SmsForwarder)，允许读取短信。
2. 发送通道里新增 Webhook，方法用 POST。
3. URL 填 `https://<你的域名>/api/v1/sms`。
4. 请求头：
   - `Authorization: Bearer <设备 token>`
   - `Content-Type: application/json`
5. 请求体使用这个模板：

```json
{"from":"{{FROM}}","content":"{{SMS}}","timestamp":"{{RECEIVE_TIME}}","device":"{{DEVICE_NAME}}","sim":"{{CARD_SLOT}}"}
```

6. 新建转发规则：收到短信时发到该通道。可以用关键字「验证码」减少无关短信。

不同版本的设置项名称可能略有差别，关键是 POST、Bearer 头和上面的 JSON 模板。

### iOS 快捷指令

分版本步骤、通知含义和限制见 [docs/ios-setup.md](docs/ios-setup.md)。新建设备时，页面同时给出一次性 Bearer token 和一次性推送链接。iOS 只复制推送链接，贴进快捷指令。刷新后链接不再显示，丢掉就在该设备上轮换。设备页还可以下载模板，并给设备发送测试短信。导入、立即运行和通知只能在你的 iPhone 上确认。

`shortcuts/` 里有两份未签名文件。主路径只有第一份：

- `SMSinBox-iOS.shortcut`：唯一的新安装模板。导入时只问「推送链接」，默认空。动作是 POST JSON 到这条链接，标头只有 `Content-Type: application/json`，字段为 `from`、`content`、`timestamp`、`device` 为 `iOS`。文件里不写设备地址，也不写 Bearer。正文为空时通知并不发送。Sender 为空时仍发送，`from` 写成「（发件人为空）」。返回里的「请求过于频繁」通知 429，「推送链接无效」或「推送链接已撤销」通知 401，没有 `ok` 时通知网络失败。自动化条件在手机上设置：「信息包含一个空格」最接近全部短信，但没有空格的短码匹配不到；只要验证码时用「验证码」或 `code`，不要另装一套主快捷指令。
- `SMSinBox-iOS-code.shortcut`：旧的关键词模板，只为收藏夹里的 `?variant=code` 保留。正文不含「验证码」或 `code` 时不发送。设备页不再提供第二个下载按钮。导入时填写 Webhook URL 和设备 token，请求 `POST /api/v1/sms`，头是 `Authorization: Bearer <token>`。已经装在手机里的旧快捷指令不用改。

登录后从设备页下载默认模板。下载结果不含推送密钥，也不能用来上报。设备页和文档同样不是推送地址。

这些文件未签名。`shortcuts sign` 只在 macOS 上提供，Linux 下无法生成签名快捷指令，仓库里也不会放伪造的签名。iOS 15 及更高版本经常拒绝未签名文件。请在 iPhone 上导入。iCloud 分享链接尚未发布，见 `docs/ios-setup.md`。被拒绝时按该文档手动添加「获取 URL 内容」，URL 填推送链接，不要加 Authorization。

推送链接不校验 HMAC。同一台设备如果填了签名密钥，Android 的 Bearer 仍然要签名。推送链接等同设备密钥，不要发到聊天或工单。

iOS 27 及以上从导入的快捷指令展开触发器，打开自动化开关，并关闭「运行前确认」。iOS 26 及以下在「自动化」里点「+」→「信息」→「立即运行」，再关闭「运行前询问」。两边的自动化默认都是关闭的。手机重启后要先解锁一次。

部署读取推送链接列的 Worker 之前，先用仓库里已有的 `npx wrangler d1 migrations apply smsinbox --remote`（本地用 `--local`）把 `0005_device_push.sql` 应用到数据库。先迁移再部署是安全的。

### 可选 HMAC

设备不填签名密钥时，只校验 Bearer token。填写了密钥之后，每个请求都必须带：

- `X-Timestamp`：Unix 秒或毫秒
- `X-Signature`：`HMAC-SHA256(X-Timestamp 的原始字符串 + 原始请求体, secret)`，十六进制或 base64

时间与服务器相差不能超过 5 分钟。SmsForwarder 和快捷指令的默认模板不会签名，给这两类客户端使用时不要填密钥。

## 推送

设备页可以给当前用户添加 Telegram、企业微信群机器人、Bark 和邮件。短信成功入库之后才推送；重复上报不会再推一次。某个渠道超时或返回错误时，只记下失败，收件箱里的短信仍然保留。

- Telegram：bot token 和 chat id。请求发往 `api.telegram.org`。
- 企业微信：群机器人 Webhook，主机必须是 `qyapi.weixin.qq.com`。
- Bark：device key。服务器留空时用 `https://api.day.app`，也可以换成你自己的公网 Bark 地址。
- 邮件：二选一。Webhook 收到 JSON `{ "to", "from", "subject", "text" }`；或者 SMTP，只支持 465 端口的隐式 TLS。

渠道配置写在你自己的 D1 里。列表接口只返回掩码。日志不记录短信正文、bot token、Webhook key 或邮箱密码。每个用户最多 10 个渠道。部署新版本后执行一次 `npx wrangler d1 migrations apply smsinbox --remote`（本地用 `--local`），把 `0002_notify.sql` 应用到数据库。

## 网页

- `/login.html`：用户名和密码登录。居中卡片。
- `/`：收件箱。左侧固定深色侧边栏，右侧浅色内容区。新短信在前，可按设备、号码和关键词筛选；侧边栏设备列表和顶部搜索也会筛选。页面通过 `GET /api/v1/events` 的 SSE 接收新短信：服务端按 `created_at` 和短信 id 记住游标，大约每 2 秒查一次 D1，连接大约保持 25 秒后主动结束，浏览器会带上 `Last-Event-ID` 自动重连。标签页切到后台时断开。另外每 30 秒补拉一次第一页，避免重连间隙漏消息。列表是行式的，验证码 chip 可一键复制，点击行在桌面展开详情、在窄屏打开抽屉。
- `/devices.html`：设备卡片显示名称、平台（来自最近一条短信的 `device` 字段）、推送状态、设备 ID、最近一次短信接收时间，以及快捷指令配置状态。创建或轮换后，黄框里的 Bearer token 和推送链接可以一键复制；刷新后不再显示。数据库只存哈希，没有再显示明文的入口，丢掉推送链接就轮换。生成、轮换和撤销都会先确认。页面保留 iOS 安装说明，并写明统一模板未签名、iCloud 尚未发布。每个设备可以「发送测试消息」，把一条带验证码 `654321` 的短信写入收件箱。删除设备会同时删除该设备的短信。
- `/notify.html`：给当前用户添加 Telegram、企业微信群机器人、Bark 和邮件推送渠道。
- `/users.html`：仅管理员可见。添加用户、改角色、重置密码、停用或删除。停用会立刻作废该用户的会话。删除会一并去掉该用户的设备、短信和推送渠道。不能停用或删除自己，也不能动最后一位管理员。

关键词搜索用 SQL `LIKE`。D1 的 LIKE 模式最长 50 字节，超出会返回错误。

## 限制

这些限制是产品行为或免费套餐额度，不是配置写错。

- iOS 只会转发匹配自动化条件的新短信。不符合条件的、自动化创建之前的短信都不会出现。
- iPhone 需要开机并联网。重启后要先解锁一次，短信自动化才会继续运行。
- iOS 这条路径不支持彩信（MMS）。
- 必须关闭「运行前询问」，否则每次都要在手机上确认。
- 不设置 `CONTENT_KEY` 时，短信正文以明文存在你自己的 D1 里。设置之后，正文、验证码和原始请求体用 AES-GCM 加密，每条短信使用独立的 12 字节 IV。日志和追踪仍然不记录正文、验证码、token 或密钥。开启加密后，关键词搜索会解密最近 500 条再匹配；更早的短信需要缩小设备或号码筛选。接口在这种情况下返回 `search_truncated: true`。
- 每天 03:15 UTC 删除超过 `RETENTION_DAYS`（默认 90）天的短信。这按写入时间计算。
- 去重键是设备、发件人、压成单行空格后的正文，以及接收时间所在的那一分钟。一分钟后再收到同样内容，会记成新短信。
- 管理员口令使用 PBKDF2-SHA256，迭代 10000 次。免费套餐每次调用大约只有 10 毫秒 CPU，迭代再高登录会因超出 CPU 被平台掐断。付费套餐可以提高 `src/auth.ts` 里的 `PBKDF2_ITERATIONS`。
- Workers 免费套餐大约每天 10 万次请求。收件箱的 SSE 大约每 25 秒重新连接一次，页面一直开着时一天大约 3500 次请求。每次连接里大约每 2 秒读一次 D1，单页大约每天 4 万次读取。D1 免费套餐的读取额度大约是每天 500 万行。
- D1 免费套餐大约每天写入 10 万行、读取 500 万行，单个数据库大约 500 MB。每条新短信大约写入 3 行（限流计数、短信、设备最后上报时间），所以实际能接收的条数明显少于 10 万。超出后查询会失败，直到 UTC 零点重置。
- 没有公开注册。`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只引导第一个管理员，之后在用户页添加别人。用户名以字母或数字开头，后面可以有点、下划线和连字符，最长 64 个字符。新用户的密码为 8 到 256 位。

## 开发

```bash
npm test
npx tsc --noEmit
```

测试覆盖验证码提取、上报内容解析、去重哈希、登录口令 / token / HMAC，以及推送、加密、快捷指令和用户管理。改了 `wrangler.jsonc` 的绑定后，运行 `npm run cf-typegen` 重新生成 `worker-configuration.d.ts`。
