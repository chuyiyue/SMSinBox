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

iOS 没有安卓那种常驻转发器，只能用「快捷指令」的短信自动化：

1. 打开「快捷指令」→「自动化」→ 新建自动化 →「信息」。
2. 选择收到短信时触发。发件人可以是任何人，也可以只填银行、登录服务的号码。
3. 关闭「运行前询问」，并打开「立即运行」。不关的话，每条短信都要手动点一下。
4. 添加操作「获取 URL 内容」：
   - URL：`https://<你的域名>/api/v1/sms`
   - 方法：POST
   - 标头：`Authorization` = `Bearer <设备 token>`，`Content-Type` = `application/json`
   - 请求体选 JSON，例如：

```json
{
  "from": "<插入「发件人」变量>",
  "content": "<插入「快捷指令输入」>",
  "device": "iphone"
}
```

`timestamp` 可以不填，服务器会用收到请求的时间。若要填写，把「当前日期」格式化成 ISO 8601。

5. 用另一台手机给自己发一条含「验证码 123456」的短信，确认收件箱里出现并可以复制。

个人自动化依赖本机。快捷指令不会上传成一个可双击安装的 `.shortcut` 文件，这份仓库里也没有附带。

### 可选 HMAC

设备不填签名密钥时，只校验 Bearer token。填写了密钥之后，每个请求都必须带：

- `X-Timestamp`：Unix 秒或毫秒
- `X-Signature`：`HMAC-SHA256(X-Timestamp 的原始字符串 + 原始请求体, secret)`，十六进制或 base64

时间与服务器相差不能超过 5 分钟。SmsForwarder 和快捷指令的默认模板不会签名，给这两类客户端使用时不要填密钥。

## 网页

- `/login.html`：用户名和密码登录。
- `/`：收件箱。新短信在前，可按设备、号码和关键词筛选，每 8 秒轮询。验证码会高亮，并可以一键复制。
- `/devices.html`：创建设备、复制一次性 token、删除设备（同时删除该设备的短信），以及上面的配置说明。

关键词搜索用 SQL `LIKE`。D1 的 LIKE 模式最长 50 字节，超出会返回错误。

## 限制

这些限制是产品行为或免费套餐额度，不是配置写错。

- iOS 只会转发匹配自动化条件的新短信。不符合条件的、自动化创建之前的短信都不会出现。
- iPhone 需要开机并联网。重启后要先解锁一次，短信自动化才会继续运行。
- iOS 这条路径不支持彩信（MMS）。
- 必须关闭「运行前询问」，否则每次都要在手机上确认。
- 短信正文以明文存在你自己的 D1 里。日志和追踪不会记录正文、验证码或 token，但数据库本身没有再做一层加密。
- 每天 03:15 UTC 删除超过 `RETENTION_DAYS`（默认 90）天的短信。这按写入时间计算。
- 去重键是设备、发件人、压成单行空格后的正文，以及接收时间所在的那一分钟。一分钟后再收到同样内容，会记成新短信。
- 管理员口令使用 PBKDF2-SHA256，迭代 10000 次。免费套餐每次调用大约只有 10 毫秒 CPU，迭代再高登录会因超出 CPU 被平台掐断。付费套餐可以提高 `src/auth.ts` 里的 `PBKDF2_ITERATIONS`。
- Workers 免费套餐大约每天 10 万次请求。收件箱每 8 秒轮询一次，页面一直开着时，一天大约 1 万次请求。
- D1 免费套餐大约每天写入 10 万行、读取 500 万行，单个数据库大约 500 MB。每条新短信大约写入 3 行（限流计数、短信、设备最后上报时间），所以实际能接收的条数明显少于 10 万。超出后查询会失败，直到 UTC 零点重置。
- 这是单用户收件箱。密钥用来引导唯一的管理员，没有注册页。

## 开发

```bash
npm test
npx tsc --noEmit
```

测试覆盖验证码提取、上报内容解析、去重哈希和登录口令 / token / HMAC。改了 `wrangler.jsonc` 的绑定后，运行 `npm run cf-typegen` 重新生成 `worker-configuration.d.ts`。

## 这次没做

实时推送、Telegram / 邮件通知、短信加密存储、打包好的 iOS 快捷指令文件、多用户。这些留到后续版本。
