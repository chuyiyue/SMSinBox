# SMSinBox

自部署的短信收件箱。手机把短信 POST 到 Cloudflare Worker，内容写入 D1，你在网页里查看、搜索，并复制验证码。

适合一个人自己用：一个管理员账号、若干设备 token、免费套餐可以跑起来。Worker 同时提供 API 和静态页面。

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

更换或清空这个密钥之后，之前加密的短信无法再解密，收件箱会显示无法解密。部署含 `0003_message_encryption.sql` 的版本后，同样需要再执行一次数据库迁移。

之后如果改了 `ADMIN_PASSWORD`，用新密码再登录一次即可。程序会在用户名与密钥一致时更新保存的口令哈希。只改密钥、还没用新密码登录之前，旧密码仍然有效。

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

分版本步骤、常见问题和限制见 [docs/ios-setup.md](docs/ios-setup.md)。设备页的「iOS 配置」可以复制 Webhook URL、复制刚创建的 token、下载模板，并给设备发送测试短信。

两种模板都在 `shortcuts/`：

- `SMSinBox-iOS.shortcut`：配合自动化条件「信息包含一个空格」，最接近全部短信。
- `SMSinBox-iOS-code.shortcut`：正文不含「验证码」或 `code` 时不发送。没有空格的短码用这个。

登录后也可以从设备页下载。下载接口按当前站点填入 URL，不包含 token。导入时填写 Webhook URL 和设备 token。动作是 POST JSON：`from`、`content`、`timestamp`、`device` 为 `iOS`，请求头 `Authorization: Bearer <token>`。

这些文件是未签名 plist。`shortcuts sign` 只在 macOS 上提供，Linux 下无法生成签名快捷指令。iOS 15 及更高版本经常拒绝未签名文件。请在 iPhone 上导入，或使用 iCloud 分享链接。链接尚未发布，见 `docs/ios-setup.md`。被拒绝时按该文档的手动步骤，在手机上添加「获取 URL 内容」。

iOS 27 及以上从导入的快捷指令展开触发器，再打开自动化开关。iOS 26 及以下在「自动化」里点「+」→「信息」→「立即运行」。两边都要关掉运行前确认。共享来的自动化默认是关闭的。

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

- `/login.html`：用户名和密码登录。
- `/`：收件箱。新短信在前，可按设备、号码和关键词筛选。页面通过 `GET /api/v1/events` 的 SSE 接收新短信：服务端按 `created_at` 和短信 id 记住游标，大约每 2 秒查一次 D1，连接大约保持 25 秒后主动结束，浏览器会带上 `Last-Event-ID` 自动重连。标签页切到后台时断开。另外每 30 秒补拉一次第一页，避免重连间隙漏消息。验证码会高亮，并可以一键复制。
- `/devices.html`：创建设备、复制一次性 token、删除设备（同时删除该设备的短信），配置推送渠道，下载 iOS 快捷指令，以及上面的配置说明。每个设备可以「发送测试消息」，把一条带验证码 `654321` 的短信写入收件箱。

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
- 这是单用户收件箱。密钥用来引导唯一的管理员，没有注册页。

## 开发

```bash
npm test
npx tsc --noEmit
```

测试覆盖验证码提取、上报内容解析、去重哈希和登录口令 / token / HMAC。改了 `wrangler.jsonc` 的绑定后，运行 `npm run cf-typegen` 重新生成 `worker-configuration.d.ts`。

## 这次没做

多用户。留到后续版本。
