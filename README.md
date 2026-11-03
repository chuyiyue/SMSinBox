# SMSinBox

自部署的短信收件箱。手机把短信 POST 到 Cloudflare Worker，内容写入 D1，你在网页里查看、搜索，并复制验证码。

只有一个管理员。没有公开注册，也不能再添加别的用户。Worker 同时提供 API 和静态页面。

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

设备 JWT 使用独立的签名密钥。推荐单独设置（至少 16 个字符）：

```bash
openssl rand -base64 32 | npx wrangler secret put DEVICE_JWT_SECRET
```

没有设置 `DEVICE_JWT_SECRET` 时，程序会退回到 `CONTENT_KEY`（其次 `ADMIN_PASSWORD`）派生的密钥，保证旧部署升级后还能添加设备。更换这个密钥会让所有已签发的设备 JWT 立即失效，旧设备仍可用原来的随机 Bearer 上报。

更换或清空 `CONTENT_KEY` 之后，之前加密的短信无法再解密，收件箱会显示无法解密。设置过 `CONTENT_KEY` 之后，两步验证的 TOTP 密钥也会用它加密；清空或更换后，验证器里的码将无法校验，但仍可用恢复码登录。部署含 `0003_message_encryption.sql`、`0004_users.sql`、`0005_device_push.sql`、`0006_single_user.sql`、`0007_totp.sql`、`0008_device_identity.sql` 或 `0009_api_tokens.sql` 的版本后，同样需要再执行一次数据库迁移。读取推送链接或 TOTP 列的 Worker 必须在对应迁移应用之后部署。顺序、冒烟和回滚见 [docs/RELEASE_IOS_V2.md](docs/RELEASE_IOS_V2.md)。

之后如果改了 `ADMIN_PASSWORD`，用新密码再登录一次即可。程序会在用户名与密钥一致时更新保存的口令哈希，并把这个账号设为管理员、取消停用。只改密钥、还没用新密码登录之前，旧密码仍然有效。改 `ADMIN_USERNAME` 不会再创建第二个管理员。密钥里的用户名必须就是要留下的那个账号；对不上时登录会停下，不会按创建时间挑一个管理员。登录之后也可以用下面的账号接口改用户名和密码。

库里如果还有其他用户，用这对密钥成功登录一次即可归并。顺序是：先把他们的设备和通知渠道改挂到这个管理员，再删掉他们的会话和用户行。短信、设备 token、推送链接和 `CONTENT_KEY` 都保留。归并不走删除用户的级联，避免把短信一起删掉。旧的成员 Cookie 不会改挂到管理员身上。请先执行含 `0006_single_user.sql` 的迁移再登录。`0006` 只增加 `schema_meta`，用来记下已经归并过；它自己不猜管理员，也不删数据。合并之后如果设备超过 50 台，或通知渠道超过 10 个，已有记录都留着，只是暂时不能再新建，直到删到上限以内。

### 两步验证（TOTP）

登录支持可选的 TOTP 两步验证。启用后，密码通过只算第一步：服务端发一张 5 分钟内有效的临时 ticket，再用验证器上的 6 位码或一次性恢复码换会话 Cookie。接口如下（除 `verify` 外都需要已登录，写操作沿用 `SameSite=Lax` Cookie 和跨站拒绝）：

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/api/v1/auth/totp` | 是否启用、绑定是否待确认、剩余恢复码数量 |
| `POST` | `/api/v1/auth/totp/setup` | 生成待确认密钥，返回手工密钥和 `otpauth://` URI |
| `POST` | `/api/v1/auth/totp/enable` | 校验待确认密钥的 6 位码后启用，返回 10 个一次性恢复码 |
| `POST` | `/api/v1/auth/totp/disable` | 当前密码 + TOTP/恢复码，关闭并清空恢复码，撤销其它会话 |
| `POST` | `/api/v1/auth/totp/recovery` | 当前密码 + TOTP/恢复码，重新生成恢复码（旧列表立即作废） |
| `POST` | `/api/v1/auth/totp/verify` | 用 ticket 换会话 Cookie |

安全约定：

- 密钥用 Web Crypto 生成 20 字节随机数，HMAC-SHA1、6 位、30 秒，允许前后各一个时间步的时钟偏差。
- 设置了 `CONTENT_KEY` 时，秘钥以 AES-GCM（`enc1:`）存入 `users.totp_secret`；未设置时按 `plain:` 前缀保存，和 `devices.secret` 的处理一致。密钥和恢复码都不写日志。
- 恢复码只存 SHA-256 哈希，用一次即作废。重新生成会替换整份列表。
- 登录第二步的 ticket 单次有效，5 分钟过期；连续 5 次错误即作废。另有 `rate_limits` 计数：每个账号 5 分钟内最多 10 次第二步失败，避免靠不断换 ticket 绕过次数上限。密码失败不走这个窗口，走下面「管理员账号」的 15 分钟限流；密码正确会清掉那个窗口，再发 ticket。TOTP 时间步会记录在 `users.totp_last_counter`，已用过的码不能重放。
- 关闭或重新生成恢复码需要当前密码再加一个有效 TOTP/恢复码。关闭后只保留当前会话。
- 忘记验证器时用恢复码完成第二步，或登录后重新生成恢复码。全部用尽且无法登录时，可在 D1 里清空该账号的 `totp_secret`、`totp_enabled_at`、`totp_last_counter` 并删除 `totp_recovery_codes` 后重新绑定；不要删除用户行或设备。

迁移 `0007_totp.sql` 只新增列和两张表（`totp_recovery_codes`、`totp_tickets`），不改已有行，未启用的账号照旧用密码登录。

自定义域名可以在 Cloudflare 控制台里给这个 Worker 加路由，接口和页面都在同一个域名下。

### 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

打开 Wrangler 打印的本地地址。本地是 HTTP，会话 Cookie 不会带 `Secure`；部署到 Cloudflare 之后是 HTTPS，Cookie 会带 `Secure` 和 `HttpOnly`。Cookie 的其它属性和跨站规则见「Cookie 与跨站请求」。

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

### 验证码识别

入库时先跑内置正则（`src/extract.ts`），行为与以前完全一致；只有正则没有命中时，才在同一个明文阶段调用 Workers AI 兜底（`@cf/meta/llama-3.1-8b-instruct-fp8`，`temperature: 0`），提示词只包含短信正文，要求模型只输出验证码，正文没有验证码则输出 `NONE`。为了防幻觉，模型返回的候选必须同时满足：

1. 形态合法：4–8 位数字，或 4–8 位字母数字组合，不含空格或标点；
2. 逐字出现在短信正文里（与正则相同的全角数字折叠后比较）。

任一条件不满足就丢弃，按「没有验证码」处理。AI 调用失败、超过约 4 秒或未配置 `AI` 绑定时会静默回落，入库照常成功，只是 `code` 为 `null`；错误只写日志，不记录短信正文或验证码明文。每条短信的实际来源写入 `messages.code_source`（`regex` / `workers-ai`，无码为 `NULL`），外部的 REST API 与 MCP 会原样返回该字段。

`wrangler.jsonc` 已声明 `"ai": { "binding": "AI" }`。本地没有该绑定时，代码会自动跳过 AI 路径，正则识别仍然可用。

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

iOS 推荐安装：打开 iCloud 分享链接 **SMSinBox Next**（已签名）https://www.icloud.com/shortcuts/cdfde24d823a43318ee651bb4d2c9494 ，导入后只填推送链接。自动化里 `content` 必须用「信息 › 内容」，`from` 用「信息 › 发件人」。详见 `docs/ios-setup.md`。

`shortcuts/` 里还有：

- `SMSinBox-iOS-Next.shortcut`：上述 iCloud 记录的已签名二进制副本（推送链接为空）。
- `SMSinBox-iOS.shortcut`：未签名备用模板（`buildShortcut("all")`）。导入时只问「推送链接」。动作 POST JSON，字段 `from`、`content`、`timestamp`、`device`＝`iOS`。被 iOS 拒绝时改用 iCloud 链接或手动步骤。
- `SMSinBox-iOS-code.shortcut`：旧的关键词模板，只为收藏夹里的 `?variant=code` 保留。

登录后从设备页下载默认模板。下载结果不含推送密钥，也不能用来上报。设备页和文档同样不是推送地址。

未签名备用文件可能被 iOS 15+ 拒绝。`shortcuts sign` 只在 macOS 上提供。请优先用 `docs/ios-setup.md` 里的 iCloud 分享链接；被拒绝或无法打开时再按该文档手动添加「获取 URL 内容」，URL 填推送链接，不要加 Authorization。

推送链接不校验 HMAC。同一台设备如果填了签名密钥，Android 的 Bearer 仍然要签名。推送链接等同设备密钥，不要发到聊天或工单。

iOS 27 及以上从导入的快捷指令展开触发器，打开自动化开关，并关闭「运行前确认」。iOS 26 及以下在「自动化」里点「+」→「信息」→「立即运行」，再关闭「运行前询问」。两边的自动化默认都是关闭的。手机重启后要先解锁一次。

部署读取推送链接列的 Worker 之前，先用仓库里已有的 `npx wrangler d1 migrations apply smsinbox --remote`（本地用 `--local`）把 `0005_device_push.sql` 应用到数据库。先迁移再部署是安全的。

### 可选 HMAC

设备不填签名密钥时，只校验 Bearer token。填写了密钥之后，每个请求都必须带：

- `X-Timestamp`：Unix 秒或毫秒
- `X-Signature`：`HMAC-SHA256(X-Timestamp 的原始字符串 + 原始请求体, secret)`，十六进制或 base64

时间与服务器相差不能超过 5 分钟。SmsForwarder 和快捷指令的默认模板不会签名，给这两类客户端使用时不要填密钥。

## 推送

设备页可以给当前用户添加 Telegram、企业微信群机器人、Bark、邮件、飞书和钉钉。短信成功入库之后才推送；重复上报不会再推一次。某个渠道超时或返回错误时，只记下失败，收件箱里的短信仍然保留。

- Telegram：bot token 和 chat id。请求发往 `api.telegram.org`。
- 企业微信：群机器人 Webhook，主机必须是 `qyapi.weixin.qq.com`。
- Bark：device key。服务器留空时用 `https://api.day.app`，也可以换成你自己的公网 Bark 地址。
- 邮件：二选一。Webhook 收到 JSON `{ "to", "from", "subject", "text" }`；或者 SMTP，只支持 465 端口的隐式 TLS。
- 飞书：自定义机器人 Webhook，主机必须是 `open.feishu.cn`（国际版 `open.larksuite.com`）；可选填签名密钥，启用后按飞书官方规则加签。
- 钉钉：自定义机器人 Webhook，主机必须是 `oapi.dingtalk.com` 且带 `access_token`；可选填签名密钥，启用后按钉钉加签规则附加 `timestamp` 与 `sign`。

渠道配置写在你自己的 D1 里。列表接口只返回掩码。日志不记录短信正文、bot token、Webhook key 或邮箱密码。最多 10 个渠道。部署新版本后执行一次 `npx wrangler d1 migrations apply smsinbox --remote`（本地用 `--local`），把 `0002_notify.sql` 应用到数据库。

## 管理员账号

没有公开注册，也不能创建第二个管理员。`POST /api/v1/users` 以及按 id 修改、删除用户仍然返回 410。

登录只需要管理员密码，不再需要用户名。旧客户端继续发送 `username` 字段也能登录，该字段会被忽略；旧的 `POST /api/v1/auth/username` 接口已经删除。`ADMIN_USERNAME` 只作为旧库多行时挑选管理员的提示，不再参与登录校验。

系统管理页可以另设一个展示用的「用户名」（昵称）：它保存在 `schema_meta` 的 `profile_username` 里，只用来显示账号名并按 `https://github.com/<用户名>.png` 取 GitHub 头像渲染侧栏头像，不参与登录。通过 `POST /api/v1/auth/profile` 保存（空字符串清除），`GET /api/v1/auth/me` 会带回 `profile_username`。

```http
POST /api/v1/auth/login
Content-Type: application/json

{"password":"管理员密码"}
```

返回 `{ "ok": true, "user": { "id", "username", "role", "totp_enabled" } }` 并设置会话 Cookie。只带 `password` 的请求和旧版带 `username` 的请求都接受。

改密码要带当前密码。当前密码对的是库里的口令哈希。连续 8 次不对，同一个 15 分钟窗口内返回 429，错误是「尝试过多，请稍后再试」，并带 `Retry-After`。对上一次会清掉这个计数。

```http
POST /api/v1/auth/password
Content-Type: application/json
Cookie: smsinbox_session=...

{"current_password":"当前密码","password":"至少 8 位的新密码"}
```

新密码长度为 8 到 256，且不能与当前密码相同。成功后删除该用户的全部会话，包括当前这次，并清掉 Cookie。要用新密码重新登录。

用环境变量里的 `ADMIN_PASSWORD` 登录会把库里的哈希写回这个密钥。这是忘记网页密码时的恢复办法。要让接口里设的新密码一直有效，请把 `ADMIN_PASSWORD` 更新成同一个值。库里有多个旧账号时，`ADMIN_USERNAME` 指向的那一行才会被当成管理员；对不上且无法唯一确定时登录返回 409，不会按创建时间猜。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/v1/auth/sessions` | 未过期会话。`current: true` 是这次请求。`id` 是 Cookie 的 SHA-256，响应里只有这个哈希 |
| POST | `/api/v1/auth/sessions/revoke-others` | 撤销其它会话，保留当前。请求体可空 |
| DELETE | `/api/v1/auth/sessions/:id` | 撤销指定会话。撤到当前会话时一并清掉 Cookie |
| POST | `/api/v1/auth/logout` | 只删除当前会话并清掉 Cookie |
| GET | `/api/v1/system/info` | 返回 Worker 从 `package.json` 读到的 `version` 和运行环境，需要登录 |

登录防爆破写在同一张 `rate_limits` 表里，窗口是 15 分钟。短信上报仍按设备每分钟 60 次单独计算。同一个管理员密码错误 8 次，或同一个 `CF-Connecting-IP` 错误 30 次，返回 429「登录尝试过多，请稍后再试」。成功登录会清掉当前窗口里这两个计数。键是 `login:user:`、`login:ip:` 或账号口令的 `login:account:` 加上 SHA-256，不存明文用户名或密码，和设备 token 的键分开。不读 `X-Forwarded-For`。跨站请求和还没填用户名密码的请求不计数。

### Cookie 与跨站请求

会话 Cookie 名是 `smsinbox_session`：`HttpOnly`、`Path=/`、不设置 `Domain`（只发给当前主机）、`SameSite=Lax`。HTTPS 加 `Secure`。有效期 7 天。

`SameSite=Lax` 会在跨站 POST 时不带 Cookie，所以别的网站提交的登录、改密、撤会话带不来会话。不用 `Strict`，是为了从外部链接点进收件箱时，顶层导航仍然带着登录态。

会改状态或要登录才能读的接口用 `isCrossSite`：`Sec-Fetch-Site` 为 `cross-site`，或者带了 `Origin` 且和请求源不一致，返回 403「跨站请求被拒绝」。没有 `Origin` 的非浏览器客户端可以调用。短信上报不读 Cookie，也不做这项检查。

改用户名、改密码、撤销指定会话、撤销其它会话再严一点：`Origin: null` 直接拒绝；请求里如果有 `Sec-Fetch-Site`，只接受 `same-origin` 和 `none`，`same-site` 也拒绝。没有另发 CSRF token。这挡的是浏览器跨站请求。已经在本站页面里的脚本仍能带 Cookie 调用。

`POST /api/v1/auth/logout` 仍只按原来的 `isCrossSite` 拒绝跨站。

## API 与 MCP

为外部第三方程序和 AI Agent（如 Cursor、Claude Desktop）提供只读访问能力。外部访问使用独立的 Token（格式以 `smsx_` 开头）与权限体系，完全与管理员会话 Cookie 隔离。

### Token 管理

管理员在网页「API 与 MCP」（`/api-mcp.html`）中创建与维护访问凭证：

- **生成**：生成带 `smsx_` 前缀的加密随机 Token。完整明文仅在创建响应中返回一次，服务端仅保存 SHA-256 哈希（`token_hash`）与前缀片段（`token_prefix`）。
- **有效期**：支持永不过期、30天、90天、365天。
- **状态控制**：支持禁用、启用、撤销与删除。禁用与撤销后，该 Token 的后续请求会立即失效（实时校验数据库，不依赖过时缓存）。
- **管理接口**（需要管理员登录，防御 CSRF）：
  - `GET /api/v1/api-tokens`：列出当前管理员的所有 Token（不含明文和哈希）
  - `POST /api/v1/api-tokens`：创建新 Token（一次性返回明文）
  - `POST /api/v1/api-tokens/:id/disable`：禁用 Token
  - `POST /api/v1/api-tokens/:id/enable`：重新启用 Token
  - `POST /api/v1/api-tokens/:id/revoke`：永久撤销 Token
  - `DELETE /api/v1/api-tokens/:id`：删除 Token

### 权限与设备范围

每个 Token 均受以下两层约束：

1. **四项只读权限**（可按需组合勾选）：
   - `messages:read`：读取短信列表、搜索与正文详情。
   - `otp:read`：读取最新短信验证码与检索历史验证码。
   - `devices:read`：读取授权范围内的设备列表。
   - `devices:status`：读取单台设备的在线状态与最近活跃时间。
2. **设备授权范围（`device_scope`）**：
   - 空数组 `[]` 表示授权访问全部设备（包括之后新增的设备）。
   - 指定设备 ID 数组时，仅限访问这部分设备的数据。
   - 范围过滤严格在 SQL 层执行（`WHERE device_id IN (...)`）。超出范围的设备及其短信在列表中自动剔除；通过 ID 查询范围外资源时一律返回 404（禁止越权探测与枚举）。

### 外部 REST API

端点前缀为 `/api/ext/v1`，请求头携带 `Authorization: Bearer <Token>`。响应统一为 JSON：成功 `{ "ok": true, "data": ..., "page": ... }`，失败 `{ "ok": false, "error": { "code", "message" } }`。

| 方法 | 路径 | 所需权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/ext/v1/health` | 有效 Token | 健康检查与 Token 连通性测试 |
| `GET` | `/api/ext/v1/me` | 有效 Token | 获取当前 Token 的名称、权限、设备范围和过期时间 |
| `GET` | `/api/ext/v1/messages` | `messages:read` | 分页读取短信（支持 `limit` 默认 20 上限 100、`offset`、`device_id`、`from`、`since`、`until`、`q` 搜索） |
| `GET` | `/api/ext/v1/messages/:id` | `messages:read` | 读取单条短信详情（范围外返回 404） |
| `GET` | `/api/ext/v1/otp/latest` | `otp:read` | 获取最新一条带验证码的短信（支持 `device_id`、`from`、`since`） |
| `GET` | `/api/ext/v1/otp/search` | `otp:read` | 分页搜索验证码列表（支持时间范围与设备过滤） |
| `GET` | `/api/ext/v1/devices` | `devices:read` | 读取授权范围内的设备列表及状态 |
| `GET` | `/api/ext/v1/devices/:id/status` | `devices:status` | 读取单台设备在线状态与最新短信时间（范围外返回 404） |
| `GET` | `/api/ext/v1/openapi.json` | 无需认证 | 获取描述上述 REST 接口的 OpenAPI 3.0 规范 JSON |

安全与业务约定：
- **限流**：每个 Token 独立计数，每分钟最多 120 次请求，超限返回 429。每次有效请求更新 `last_used_at` 记录最后调用时间。
- **设备在线状态**：设备状态由 `last_seen_at` 派生。阈值常量为 15 分钟（`DEVICE_ONLINE_THRESHOLD_MS = 15 * 60 * 1000`）。若最后上报时间在 15 分钟内为 `online`，超过 15 分钟为 `offline`；从未上报为 `unseen`。
- **验证码状态与来源约定**：验证码在短信写入时识别——先跑正则（`src/extract.ts`），未命中且配置了 Workers AI 时才调用模型兜底，并做「形态合法 + 正文逐字出现」的硬校验。含验证码时返回 `code_status: "recognized"`，`code_source` 为写入时记录的 `"regex"` 或 `"workers-ai"`；无验证码时返回 `code_status: "none"`、`code_source: null`。查询未找到验证码时返回 `data: null`，绝不编造数据。
- **日志安全**：系统日志严格对 Token 明文与短信正文进行脱敏与打码。

### MCP Server

在 Worker 同一端口提供 `/mcp` 端点，基于 Streamable HTTP 传输协议（POST JSON-RPC 2.0），无需额外部署或外部 SDK。与 REST API 共用相同的 Bearer Token、权限检查与设备范围校验。

- **握手协议**：
  - `POST /mcp` 发送 `initialize`：返回协议版本 `2024-11-05`、服务名称与工具能力。
  - 发送 `notifications/initialized`：返回 202 确认。
  - 发送 `ping`：返回 `{}`。
  - 发送 `tools/list`：返回全部 7 个只读工具清单及输入 JSON Schema。
  - 发送 `tools/call`：执行工具，返回包含 `content`（文本摘要）与 `structuredContent`（结构化 JSON）的结果。
- **只读工具清单**（绝不提供任何写/删/改配置工具）：
  1. `list_messages`：分页列出授权范围内的短信（参数：`limit`, `offset`, `device_id`, `since`, `until`）
  2. `search_messages`：按关键词搜索短信正文、发件人或验证码（参数：`q`, `from`, `device_id`, `limit`, `offset`）
  3. `get_message`：按 ID 获取短信详情（参数：`id`）
  4. `get_latest_otp`：获取最新一条验证码（参数：`device_id`, `from`, `since`）
  5. `search_otp`：按时间范围与筛选条件搜索历史验证码（参数：`since`, `until`, `device_id`, `from`, `limit`, `offset`）
  6. `list_devices`：列出授权范围内的设备及在线状态（参数：无）
  7. `get_device_status`：查询单台设备的在线状态与最新短信时间（参数：`id`）

## 网页

- `/login.html`：用户名和密码登录。居中卡片。
- `/`：收件箱。左侧固定深色侧边栏，右侧浅色内容区。新短信在前，可按设备、号码和关键词筛选；侧边栏设备列表和顶部搜索也会筛选。页面通过 `GET /api/v1/events` 的 SSE 接收新短信：服务端按 `created_at` 和短信 id 记住游标，大约每 2 秒查一次 D1，连接大约保持 25 秒后主动结束，浏览器会带上 `Last-Event-ID` 自动重连。标签页切到后台时断开。另外每 30 秒补拉一次第一页，避免重连间隙漏消息。列表是行式的，验证码 chip 可一键复制，点击行在桌面展开详情、在窄屏打开抽屉。
- `/devices.html`：设备卡片显示名称、平台（来自最近一条短信的 `device` 字段）、推送状态、设备 ID、最近一次短信接收时间，以及快捷指令配置状态。创建或轮换后，黄框里的 Bearer token 和推送链接可以一键复制；刷新后不再显示。数据库只存哈希，没有再显示明文的入口，丢掉推送链接就轮换。生成、轮换和撤销都会先确认。页面保留 iOS 安装说明，并给出 iCloud 分享链接与未签名备用下载。每个设备可以「发送测试消息」，把一条带验证码 `654321` 的短信写入收件箱。删除设备会同时删除该设备的短信。
- `/notify.html`：给当前用户添加 Telegram、企业微信群机器人、Bark、邮件、飞书和钉钉推送渠道。
- `/api-mcp.html`：API 与 MCP 管理页。管理外部 API 访问 Token（生成、禁用、启用、撤销、删除），配置只读权限与设备授权范围；展示 MCP 端点 `/mcp` 连接信息、通用配置与 OpenAPI 3.0 规范链接。
- `/users.html`：系统管理页，分四区。**管理员账号**改用户名、改密码（都要当前密码；改密码后全部会话失效并需要重新登录）。**会话管理**列出未过期会话并标出当前这次，可以撤销单条、撤销其它会话。**两步验证**启用、关闭 TOTP，查看剩余恢复码并重新生成。**系统信息**显示由服务端读取 `package.json` 得到的版本号、当前用户、设备数和会话数，发版只需改 `package.json`。旧的添加用户、用户列表和用户弹窗已移除；`/api/v1/users` 仍返回 410。

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
- 没有公开注册，也没有第二个管理员。`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只引导或认领唯一管理员。业务查询仍按 `user_id` 过滤，归并之后这些行都属于这个管理员。
- 登录和当前密码各有 15 分钟的失败上限（用户名 8 次，来源 IP 30 次）。成功登录会清掉当前窗口的登录失败计数。窗口按 15 分钟对齐，过期行随每天的清理任务在两天后删掉。

## 开发

```bash
npm test
npx tsc --noEmit
```

测试覆盖验证码提取（含 Workers AI 兜底与防幻觉校验）、上报内容解析、去重哈希、登录口令 / token / HMAC、登录限流、改用户名改密码、会话撤销、TOTP（RFC 6238 向量、绑定、登录第二步、重放、恢复码、关闭、第二步限流）、系统管理页结构与残留检查，以及推送、加密、快捷指令和单用户归并。`test/release.integration.test.ts` 再用本地 D1 跑迁移和整条上报链路，不连接生产。改了 `wrangler.jsonc` 的绑定后，运行 `npm run cf-typegen` 重新生成 `worker-configuration.d.ts`。
