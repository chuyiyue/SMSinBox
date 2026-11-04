# iOS 体验升级阶段 1 审计

审计日：2026-10-31。基线提交：`e8f0c5f`（`main`，与 `origin/main` 一致）。本文件只记录现状、缺口、阶段 2 方案和文件清单。阶段 1 不改业务代码，不签名快捷指令，不编造 iCloud 链接。

阶段 2 按本文「重构方案」和「文件清单」实现。历史方案 `docs/PLAN.md`、`docs/IOS_PLAN.md` 保持原样，它们描述的是已经落地的 MVP / v1，不是本轮推送链接的规格。

## 回归基线

在 `e8f0c5f` 的干净工作区先执行一轮，10 个文件、62 条通过。紧接着再跑时，`test/crypto.test.ts` 的「改密文最后一个 base64 字符」偶发失败：末位有时只编码填充位，解码后的密文字节不变，AES-GCM 仍能解出原文。阶段 1 只改了这条测试，改为翻转密文段的第一个字符。加密实现没有改。修正后的基线：

| 命令 | 结果 |
|---|---|
| `npm test`（Vitest 5.0.5） | 10 个文件，62 条测试通过 |
| `npx tsc --noEmit` | 退出码 0 |

依赖只有开发依赖：`typescript` ^7、`vitest` ^5、`wrangler` ^4、`@cloudflare/workers-types`、`@types/node`。运行时不打包 npm 业务库，用 Workers、D1、WebCrypto 和 `nodejs_compat`。`NO_COLOR` / `FORCE_COLOR` 的 Node 警告来自环境变量同时存在，测试本身没有失败。

62 条测试覆盖：口令与 Bearer / HMAC（`test/auth.test.ts`）、解析（`test/parse.test.ts`）、去重（`test/dedup.test.ts`）、验证码（`test/extract.test.ts`）、加密（`test/crypto.test.ts`）、搜索与保留天数（`test/search.test.ts`）、SSE（`test/sse.test.ts`）、推送渠道（`test/notify.test.ts`）、用户管理（`test/users.test.ts`）、快捷指令 plist、下载接口和「发送测试消息」（`test/shortcut.test.ts`）。

`handleSms` 没有路由级测试。Bearer 入库、401、HMAC 分支、429 和重复上报目前只存在于 `src/routes/sms.ts`，不在基线断言里。阶段 2 改鉴权前要先补这条链路的特征测试。

## 现状

### 进程与绑定

单个 Worker（`src/index.ts`）分三条路：

- `POST /api/v1/sms` 进入 `handleSms`。其他方法返回 405，`Allow: POST`。
- 其余 `/api/*` 进入 `handleApi`。
- 其他路径交给静态资源 `env.ASSETS`（`public/`，`run_worker_first: ["/api/*"]`）。

Cron `0 0 * * *` 调用 `purgeExpired`：按 `RETENTION_DAYS`（默认 90）删短信，删过期会话，删两天前的 `rate_limits`。

`Env`（`worker-configuration.d.ts`）：`DB`、`ASSETS`、`RETENTION_DAYS`、`CONTENT_KEY`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`。没有 KV、队列或 Durable Object。Wrangler 观测打开了 `redact_query_string`，路径本身不会被平台配置打码。

每次 `/api/` 请求在 `src/index.ts` 里用 `url.pathname` 打日志。今天的路径没有密钥。阶段 2 如果把推送密钥放进路径，必须先改掉这条日志。

### 表

迁移按顺序应用，都是追加，没有重建表：

| 文件 | 作用 |
|---|---|
| `migrations/0001_init.sql` | `users`、`devices`、`messages`、`sessions`、`rate_limits` |
| `migrations/0002_notify.sql` | `notify_channels` |
| `migrations/0003_message_encryption.sql` | `messages.encrypted`，默认 0 |
| `migrations/0004_users.sql` | `users.role` 默认 `member`，`users.disabled_at` |

外键没有 `ON DELETE CASCADE`。删除由 `deleteDevice` 和 `deleteUserCascade` 用 batch 完成。

`devices`：`id`、`user_id`、`name`、`token_hash`（UNIQUE，SHA-256 十六进制）、`secret`（HMAC 密钥明文，可空）、`last_seen_at`、`created_at`。没有推送链接列，没有吊销时间，没有轮换记录。

`messages.content_hash` 是去重键，不是凭证哈希。公式在 `src/dedup.ts`：`sha256(device_id + from + 压成单行的正文 + floor(received_at / 60s))`，UNIQUE。重复上报返回 200 且 `duplicate: true`。

`sessions.id` 存会话 token 的 SHA-256。`rate_limits` 的主键是 `(token_hash, window_start)`，每窗口 60 次（`RATE_LIMIT_PER_MINUTE`）。

凭证存储现状：

- 设备 Bearer 和会话 token：只存 SHA-256。明文只在创建响应或 Set-Cookie 里出现一次。
- `devices.secret`：明文。校验 HMAC 必须能读回原文。列表接口只返回 `has_secret`。
- `notify_channels.config`：JSON 明文（bot token、Webhook、SMTP 密码）。列表接口走 `redactConfig`。
- 口令：`pbkdf2-sha256`，10000 次，写在 `src/auth.ts`。

`deleteDevice` 删该设备的短信和设备行，不删 `rate_limits`。残留行等到 Cron 的两天窗口。`deleteUserCascade` 会按 `devices.token_hash` 删限流行。用户删除路径不认识将来的推送哈希。

### API 与权限

会话接口都走 `requireUser`：`Sec-Fetch-Site: cross-site` 或跨源 `Origin` 返回 403；Cookie `smsinbox_session` 的哈希必须对上未过期、未停用的用户。管理员接口再查 `role === "admin"`。短信接收入口不读 Cookie，也不做跨源检查，这样快捷指令和 SmsForwarder 才能上报。

| 方法 | 路径 | 谁可以调用 | 行为 |
|---|---|---|---|
| POST | `/api/v1/sms` | 设备 Bearer | 入库。见下一节 |
| POST | `/api/v1/auth/login` | 公开，拒绝跨源 | 引导管理员或校验口令，写会话哈希 |
| POST | `/api/v1/auth/logout` | 公开，拒绝跨源 | 删会话 |
| GET | `/api/v1/auth/me` | 会话 | 当前用户 |
| GET | `/api/v1/events` | 会话 | SSE，只看自己的短信 |
| GET | `/api/v1/messages` | 会话 | 分页，按自己的设备过滤 |
| GET | `/api/v1/messages/:id` | 会话 | 详情，别人的 id 当不存在 |
| GET, POST | `/api/v1/devices` | 会话 | 列表不含 token / 哈希 / 密钥；创建返回一次性 `token` |
| POST | `/api/v1/devices/:id/test` | 会话且设备属于自己 | 写一条带 `654321` 的测试短信，并走推送 |
| DELETE | `/api/v1/devices/:id` | 会话且设备属于自己 | 删除设备及其短信 |
| GET | `/api/v1/ios/shortcut` | 会话 | 下载未签名 plist，query `variant=all`（默认）或 `code` |
| GET, POST | `/api/v1/notifications` | 会话 | 渠道，每人最多 10 个 |
| POST, DELETE | `/api/v1/notifications/:id` | 会话且渠道属于自己 | 开关或删除 |
| POST | `/api/v1/notifications/:id/test` | 同上 | 发测试通知，正文不含短信 |
| GET, POST | `/api/v1/users` | 管理员 | 列表与创建 |
| POST, DELETE | `/api/v1/users/:id` | 管理员 | 改角色、密码、停用；删除会级联设备、短信、会话、渠道 |

设备上限 `MAX_DEVICES = 50`。创建体：`name` 1–64 且无控制字符；`secret` 空则只校验 Bearer，否则 8–256 字符。

没有这些能力：按设备签发第二条凭证、轮换、单独吊销、查看已保存的 token、推送 URL、配置 URL 与接收入口分离。

下载接口把 `variant` 限定为 `all` 或 `code`，用请求的 origin 调用 `buildShortcut(variant, origin + "/api/v1/sms")`。响应是 `application/octet-stream`，`Content-Disposition` 附件，`Cache-Control: no-store`。文件里没有设备 token。未知 variant 返回 400。

静态页：`/` 收件箱，`/login.html`，`/devices.html`，`/notify.html`，`/users.html`。`public/_headers` 把 CSP 限制在 `'self'`。页面脚本通过 `public/common.js` 的 `api()` 带同源 Cookie。401 会跳到登录页。

### 设备与短信链路

创建设备（`createDevice`）：`randomToken()` 生成 `sms_` 加 32 字节 base64url，`sha256Hex` 后写入 `token_hash`。响应里的 `token` 只出现这一次。`public/devices.js` 把它放进 `#token-value`，并解开 iOS 区的「复制 token」。刷新后前端没有 token，后端也没有明文。

上报（`handleSms`）顺序：

1. 读体，上限 16 KiB，超出 413。
2. `Authorization: Bearer` 必须匹配 `readBearer`（长度 16–256）。缺失 401「缺少设备 token」。
3. SHA-256 后 `findDeviceByTokenHash`。没有设备则 401「设备 token 无效」。
4. `devices.secret` 非空时要求 `X-Timestamp` 与 `X-Signature`，窗口 ±5 分钟，消息是 `HMAC-SHA256(时间戳原始字符串 + 原始体, secret)`。密钥为空但客户端带了这两个头，返回 401「该设备未启用签名」。
5. `consumeRateLimit`，超过 60 次返回 429。
6. `parseSmsPayload`：JSON 或 form。别名 `from`/`sender`，`content`/`text`/`msg`/`body`/`sms`，`timestamp`/`receive_time`，以及 `device`、`sim`、`to`。正文上限 8000。时间缺失或超出当前时间前 7 天、后 5 分钟时改用服务器时间。
7. 去重命中则更新 `last_seen_at` 并返回已有 id。
8. `extractCode` 后按 `CONTENT_KEY` 决定明文或 AES-GCM（`enc1:`）。密钥非法返回 500，不落库。
9. 插入短信，`touchDevice`，打 `sms_stored`（只有 device id、message id、`has_code`）。`scheduleNotify` 在成功插入之后把明文交给已启用渠道。渠道失败只记日志，短信保留。

Android 文档和设备页使用同一个 URL：`https://<origin>/api/v1/sms`，外加 Bearer。iOS 快捷指令也 POST 到这个 URL。测试按钮不走这条链路，它在会话里直接 `insertMessage`。

丢失 token 的恢复方式是删除设备并新建。删除会清掉该设备的短信。没有保留短信的轮换。

### 快捷指令

生成器是 `src/shortcut.ts` 的 `buildShortcut(variant, webhookUrl?)`。`shortcuts/SMSinBox-iOS.shortcut` 与 `shortcuts/SMSinBox-iOS-code.shortcut` 必须分别等于 `buildShortcut("all")` 和 `buildShortcut("code")`（`test/shortcut.test.ts` 读文件比对）。仓库里的默认 Webhook 是 `https://example.workers.dev/api/v1/sms`，没有 token。

两个变体共用动作骨架：

1. 注释：未签名、`shortcuts sign` 只在 macOS、链接尚未发布、导入时填 URL 和 token。
2. 文本「Webhook URL」（导入问题，动作下标 1）。
3. 文本「设备 Token」（导入问题，动作下标 2，默认空）。
4. 文本「Authorization」：`Bearer ` 拼上 token。
5. `code` 变体在此插入条件：正文包含「验证码」，否则包含 `code`，否则停止。
6. 「获取 URL 内容」：POST、JSON、`Authorization` 与 `Content-Type: application/json`。字段 `from`（扩展输入的 Sender）、`content`（快捷指令输入）、`timestamp`（当前日期）、`device` 固定 `iOS`。
7. 通知标题 SMSinBox，正文「已转发」。

`all` 变体自身不过滤，注释要求用户把自动化条件设为「信息包含一个空格」。`code` 变体在快捷指令内部停掉非验证码，请求不会发出。

`normalizeWebhookUrl` 只接受 http/https，拒绝带用户名或密码的 URL，非法值退回占位地址。测试同时断言 plist 不含 `icloud.com/shortcuts`。

签名：生成器输出普通 XML plist，没有签名块。`shortcuts sign` 不能在 Linux 构建机上运行。文档（`docs/ios-setup.md`、`shortcuts/README.md`、README、设备页、plist 注释）都写明 iOS 15 及以上经常拒绝未签名文件，iCloud 分享链接的状态是「尚未发布」。代码里没有 iCloud URL。

### 文档和页面里的重复

同一套 iOS 步骤出现在六处，详略不同：

- `docs/ios-setup.md`：完整步骤、FAQ、限制，这是用户向的正文。
- `public/devices.html` `#ios-setup`：缩短版，另有 Android 与 HMAC。
- `README.md`「iOS 快捷指令」。
- `shortcuts/README.md`。
- plist 注释（`commentText`）。
- `docs/IOS_PLAN.md`：v1 策划，预置双模板和下载按钮已经做完。

设备页把同一个 `location.origin + "/api/v1/sms"` 填进 `#sms-url` 和 `#ios-url`。复制 URL、复制 token 是两步。下载按钮两个：`?variant=all` 与 `?variant=code`。

`docs/PLAN.md` 仍把「iOS .shortcut 文件」列在后续项。那份摘要已经过时，阶段 2 不必回写它。

## 缺口

目标是：手机上只装一次统一快捷指令；这只快捷指令只填一个设备推送链接；创建设备就生成专属推送地址；该地址可长期使用，也可轮换和撤销；库里只存推送密钥的哈希；旧 Bearer 继续可用；已有行不改写；配置入口和推送地址不是同一个 URL；不伪造动态 iCloud 链接；不在 Linux 上签名。

对照现状：

1. 接收入口是全站共享的 `/api/v1/sms`。设备之间的差别只在 Bearer。快捷指令要填 URL 和 token 两格，装两套模板才能覆盖「近全量」和「仅验证码」。
2. 没有专属推送地址。创建响应只有 `token`。
3. 凭证不能轮换或撤销。要作废 token 只能删设备，短信跟着删除。已创建的设备无法补一条推送地址。
4. Bearer 已经只存哈希，这一点要保持。推送密钥还没有列。`devices.secret` 和通知配置仍是明文，因为校验和投递需要原文；阶段 2 不要把这两处改成哈希。
5. 旧 Bearer 路径必须原样留下，包括 HMAC 规则、429、去重和响应体 `{ ok, id, code }`。
6. 迁移必须只追加列。不能改已有 `token_hash`，不能重写 `messages`。
7. 配置材料（设备页锚点、会话下载的未签名模板、文档）和将来的推送地址现在还没分开，因为推送地址不存在。下载接口已经避免把 token 写进文件，这个边界要保持。
8. iCloud 链接正确地空着。阶段 2 仍然不要生成 `icloud.com` 地址，也不要按设备拼一份「看起来像分享链接」的 URL。
9. 没有签名流程。不要加 `shortcuts sign`，不要提交带签名块的 plist。
10. 若推送密钥出现在路径里，`src/index.ts` 的访问日志和错误日志会记下明文。平台配置只打码 query。这是阶段 2 的上线条件，不是可选项。
11. 带 HMAC 的设备今天要求每个上报都签名。快捷指令做不到。推送地址若绑上这条规则，iOS 就无法只贴一个链接。
12. 基线没有 `POST /api/v1/sms` 的测试。改 `handleSms` 时回归网是空的。
13. 单设备删除留下 `rate_limits`。新哈希也走这张表的话，删除路径必须同时清掉两种哈希。

## 阶段 2 重构方案

### 不变量

- `POST /api/v1/sms` 的 Bearer 行为保持现在的状态码、错误文案和 HMAC 规则。已安装的旧快捷指令和 SmsForwarder 不用改。
- 创建响应继续返回 `token`。多出来的字段旧客户端可以忽略。
- 不更新已有 `token_hash`、短信、会话、用户和通知渠道。
- 推送密钥用与 Bearer 相同的熵：32 字节随机，前缀 `psh_`，库中只存 SHA-256 十六进制。响应当次返回完整推送 URL，之后接口不再返回。
- 一台设备最多一条有效推送密钥。长期有效，直到轮换或撤销。不设过期时间。
- 配置入口不接收短信。推送 URL 不充当登录、下载或设备管理入口。
- 统一模板仍是未签名 XML。注释继续写「尚未发布」。测试继续断言成品不含 `icloud.com/shortcuts`。
- 不调用 `shortcuts sign`，不在 plist 里放签名。

### 数据

新迁移 `migrations/0005_device_push.sql`，只追加：

```sql
ALTER TABLE devices ADD COLUMN push_token_hash TEXT;
ALTER TABLE devices ADD COLUMN push_revoked_at INTEGER;
CREATE UNIQUE INDEX idx_devices_push_token_hash ON devices(push_token_hash);
```

SQLite 的 UNIQUE 索引允许多个 NULL。已有设备这两列都是 NULL，表示还没有推送地址。

状态：

| push_token_hash | push_revoked_at | 含义 |
|---|---|---|
| NULL | NULL | 未签发 |
| 有值 | NULL | 有效，可长期复用 |
| 有值 | 有值 | 已撤销，该哈希继续留在行上，查找时拒绝 |

轮换生成新哈希并清空 `push_revoked_at`。旧哈希从行上消失，对应 URL 立即失效，明文从未落库，所以无法再恢复。撤销只写 `push_revoked_at`，不删设备，不删短信。

`DeviceView` 增加 `push: "none" | "active" | "revoked"`。列表可以返回这个状态，不能返回哈希或 URL。

先执行迁移，再部署读取新列的 Worker。旧 Worker 不读这两列，先迁移是安全的。部署说明沿用 README 里已有的 `wrangler d1 migrations apply`。

### 两条鉴权

把 `handleSms` 里「认完设备之后」的解析、去重、加密、插入、通知收成一个内部函数。两条入口只在认设备这一步分开。

Bearer 入口保持 `POST /api/v1/sms`：

- 只查 `token_hash`。
- HMAC 规则不变。
- 限流键继续用 Bearer 的哈希。
- `psh_` 密钥当作 Bearer 送来时对不上 `token_hash`，返回现有的 401。

推送入口 `POST /api/v1/ingest/<secret>`，在 `src/index.ts` 里和 `/api/v1/sms` 并列，不要落到 `handleApi` 的 404：

- 只接受 POST。其他方法 405，`Allow: POST`。GET 不能入库，避免预取写入。
- 密钥字符集限定为 base64url 加前缀，长度落在与 `readBearer` 相近的上限内。不合格直接 401，不把超长路径送去哈希。
- SHA-256 后按 `push_token_hash` 查找。未找到、或 `push_revoked_at` 非空，都是 401。文案可以区分「无效」和「已撤销」，因为调用方已经持有该密钥。
- 不读 Cookie，不把会话当成推送凭证。不要求 `Origin`。
- 不要求 HMAC，也不因为设备填了 `secret` 而拒绝。快捷指令签不了名。Bearer 那条门仍然执行 HMAC。同一台设备可以同时给 Android 留 Bearer+HMAC，给 iOS 留推送 URL。推送 URL 的强度来自 32 字节随机密钥、只存哈希、可轮换可撤销。装了推送 URL 就等于多开了一扇不校验 HMAC 的门，设备页要写明这一点。
- 推送入口上的 `Authorization` 头忽略，避免用别人的 Bearer 换设备。认设备只看路径里的密钥。
- 限流键用推送哈希，额度和 Bearer 相同，每分钟 60 次。两把钥匙各算各的。
- 入库、去重、加密、通知与 Bearer 成功路径相同。响应形状相同。
- 错误体不回显密钥。

`deleteDevice` 同时删除该设备 Bearer 哈希和推送哈希的 `rate_limits` 行。`deleteUserCascade` 同样覆盖 `push_token_hash`。

### 签发、轮换、撤销

创建设备时：

- 始终生成 Bearer，响应字段名仍是 `token`。
- 始终生成推送密钥，响应增加 `push_url`，形如 `https://<请求 origin>/api/v1/ingest/psh_...`。只此一次。
- `device.push` 为 `"active"`。

已有设备用会话接口补签或轮换，不碰 `token_hash`，不删短信：

`POST /api/v1/devices/:id/push`

- 会话，且设备属于当前用户。跨源规则与其他设备接口相同。
- 体 `{ "action": "issue" | "rotate" | "revoke" }`。
- `issue`：仅当状态是 `none` 或 `revoked`。已经 `active` 时返回 409，提示改走轮换，避免把手机上正在用的链接静默作废。
- `rotate`：仅当已经有哈希（active 或 revoked）。替换哈希，清空撤销时间，响应返回新的 `push_url`。
- `revoke`：仅当 `active`。写入 `push_revoked_at`。响应不带 URL。
- 状态不对时 409，设备不存在时 404。

没有「再显示一次」的接口。用户丢掉链接就轮换。

### 配置链接和推送链接

配置链接指给人看的安装入口，不含设备密钥，也不能入库：

- 页面锚点 `/devices.html#ios-setup`。
- 会话下载 `GET /api/v1/ios/shortcut`。
- `docs/ios-setup.md` 里的手动步骤。
- iCloud 一行继续写「尚未发布」，直到有人在 Mac 上真实分享后再改文档。代码不填这个 URL。

推送链接指 `push_url`。它只出现在创建或轮换的 JSON 里，由人贴进已经装好的那一条快捷指令。

下载的 plist 不写入推送密钥，不写入某台设备的 URL，也不把 `/api/v1/sms` 当作新模板的默认目标。导入问题只留一格：「推送链接」，默认空。这样全站共用一个未签名文件，手机装一次。

`variant=all` 与不带 query 的下载改为这一个统一模板，文件名仍是 `SMSinBox-iOS.shortcut`。旧书签还能下到文件，但内容不再询问 Bearer。已经在手机里的旧快捷指令不受影响，它们继续 POST `/api/v1/sms`。

`variant=code` 在阶段 2 仍返回现有的关键词模板，避免收藏夹里的第二个下载地址突然变成另一种动作。设备页去掉第二个按钮，主路径只引导统一模板。关键词过滤改由手机上的自动化条件完成（空格、或「验证码」/ `code`），与今天 `all` 模板的用法一致。服务端不为推送链接增加「只收验证码」开关；那会让正文先上传再丢弃，和现在 `code` 模板在手机上停掉的行为不同。

### 统一快捷指令的动作

保持未签名 plist，客户端版本下限仍是 900：

1. 注释：未签名、Linux 不能签名、iCloud 尚未发布、只填推送链接、自动化默认关闭。
2. 文本「推送链接」，导入问题下标 1，默认空。
3. 「获取 URL 内容」：URL 用上一步文本，POST，JSON，标头只有 `Content-Type: application/json`。字段仍是 `from`、`content`、`timestamp`、`device: iOS`。
4. 通知「已转发」。

不放 Bearer 文本，不放条件分支，不放第二道导入问题。`shortcuts/SMSinBox-iOS.shortcut` 与生成器在同一次改动里一起更新，否则字节比对测试会失败。`SMSinBox-iOS-code.shortcut` 继续对照 `buildShortcut("code")`。

手动步骤在 `docs/ios-setup.md` 和设备页改成贴一条 URL。旧的 Bearer 手工步骤留在「已有快捷指令和 Android」小节，避免拆掉现有用户的做法。

### 日志

`src/index.ts` 在写 `path` 之前，把 `/api/v1/ingest/<secret>` 收成固定的 `/api/v1/ingest/:secret`。成功和异常两条都要收。不记录 `request.url` 原文。查询串继续不要写入应用日志。响应与 `sms_stored` 字段保持今天的范围：设备 id、短信 id、是否识别出验证码。

平台访问日志仍可能看到路径。这是 Workers 的请求日志，应用打码代替不了它。文档里告诉用户：推送链接等同设备密钥，不要发到聊天或工单。

### 页面

`public/devices.html` / `public/devices.js`：

- 创建成功后同时展示一次性 Bearer 和一次性推送链接。iOS 区只强调复制推送链接。
- 每台设备显示推送状态。动作为「生成推送链接」「轮换」「撤销」。复制按钮只在刚返回 `push_url` 时可用。
- 下载只留统一模板一个链接。
- 说明：配置页和下载不是推送地址；推送地址会绕过 HMAC；旧 Bearer 仍可用于 Android；iCloud 尚未发布；文件未签名。
- Android 区块继续使用 `/api/v1/sms` 和 Bearer。

### 阶段 2 明确不做

- 不签名，不跑 `shortcuts sign`，不提交带签名的快捷指令。
- 不生成 iCloud 链接，不为每台设备做动态分享地址。
- 不把 HMAC 密钥或通知配置改成哈希，不加密这两处。
- 不删除 Bearer，不改 `POST /api/v1/sms` 的对外契约。
- 不改短信表、去重算法、加密格式、SSE、用户管理和通知投递。
- 不提供多条同时有效的推送链接。
- 不增加服务端「仅验证码」过滤。
- 不改 `docs/PLAN.md` 和 `docs/IOS_PLAN.md`。
- 不加新的 Wrangler 绑定，不必为此重跑 `cf-typegen`。

### 建议落地顺序

每步之后跑 `npm test` 和 `npx tsc --noEmit`。只在步骤内部自洽时再提交，不要把红测试留在中间提交里。

1. 为现有 `handleSms` 补特征测试（401、错误 Bearer、HMAC 有无、429、去重、成功体）。先锁住旧行为。
2. 加迁移和 db/types 的读写，不改路由。
3. 抽出共用入库函数，接上 `/api/v1/ingest/:secret`，打码日志，接上签发 / 轮换 / 撤销。
4. 改统一快捷指令生成器、提交的 `SMSinBox-iOS.shortcut`、下载接口和测试。`code` 模板保持可生成。
5. 改设备页和 `docs/ios-setup.md`、README 的 iOS 小节、`shortcuts/README.md`。
6. 再跑一轮完整测试和 `tsc`。有浏览器时走一遍：登录、创建设备、看到一次性推送链接、刷新后链接消失、轮换与撤销、旧 Bearer 仍能上报、推送 URL 能上报、撤销后 401、Android 说明里的 URL 仍是 `/api/v1/sms`。

## 阶段 2 文件清单

新增：

| 文件 | 做什么 |
|---|---|
| `migrations/0005_device_push.sql` | 追加 `push_token_hash`、`push_revoked_at` 和唯一索引 |
| `test/ingest.test.ts` | Bearer 特征测试，以及推送 URL 的成功、撤销、轮换、限流、日志不含密钥 |

修改：

| 文件 | 做什么 |
|---|---|
| `src/index.ts` | 注册推送入口；日志路径打码 |
| `src/routes/sms.ts` | 拆开认设备和入库；推送入口忽略 Bearer、不强制 HMAC |
| `src/routes/api.ts` | 创建响应增加 `push_url`；`POST /devices/:id/push`；默认下载改为统一模板 |
| `src/db.ts` | 推送哈希的写入、查找、轮换、撤销；两处删除补上限流行 |
| `src/types.ts` | `DeviceView.push` |
| `src/shortcut.ts` | 统一模板：一个导入问题，POST 到该链接，无 Authorization |
| `shortcuts/SMSinBox-iOS.shortcut` | 与新的默认生成结果字节一致 |
| `shortcuts/README.md` | 说明只有一个主模板，以及 code 文件仍是旧的关键词模板 |
| `public/devices.html` | 一个下载按钮，推送链接与配置说明分开 |
| `public/devices.js` | 展示一次性 `push_url`，调用签发、轮换、撤销 |
| `docs/ios-setup.md` | 主路径改为贴一条推送链接；保留旧 Bearer 步骤 |
| `README.md` | 只改 iOS 小节，与上面的行为一致 |
| `test/shortcut.test.ts` | 统一模板的断言；下载结果不含 token、不含真实密钥；`variant=code` 仍可用 |

阶段 2 不改：`src/auth.ts`（继续用现有的 `randomToken` / `sha256Hex` / `readBearer`）、`src/notify.ts`、`src/crypto.ts`、`src/parse.ts`、`src/dedup.ts`、`src/extract.ts`、`src/sse.ts`、`public/inbox.js`、`public/notify.js`、`public/users.js`、`wrangler.jsonc`、`docs/PLAN.md`、`docs/IOS_PLAN.md`、`shortcuts/SMSinBox-iOS-code.shortcut`（生成器的 `code` 分支不改，文件就不必重写）。

若实现时发现 `randomToken` 的 `sms_` 前缀不适合推送密钥，把 `psh_` 前缀放在 `src/routes/sms.ts` 或 `src/routes/api.ts` 的本地函数里，仍然不必改 `src/auth.ts` 的会话和 Bearer 格式。

## 本阶段改动

本阶段新增本文件，并修正 `test/crypto.test.ts` 里一条会偶发通过的篡改断言。业务实现没有改。修正后 `npm test` 与 `npx tsc --noEmit` 通过。
