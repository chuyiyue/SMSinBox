# SMSinBox 开发方案（摘要）

自部署短信转发网关：iOS 快捷指令、Android SmsForwarder、其他设备 POST 短信到 Cloudflare Worker，存 D1，网页收件箱查看。免费套餐可跑、一键部署、单用户优先。TypeScript。

## 架构
- 单个 Worker：API + Workers Static Assets 前端（`run_worker_first: ["/api/*"]`）。
- D1 存储。MVP 不依赖 Durable Objects / Queues。

## API
| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| POST | /api/v1/sms | 接收短信 | 设备 Bearer token |
| GET | /api/v1/messages | 列表/搜索/分页（按设备、号码筛选） | 用户会话 |
| GET | /api/v1/messages/:id | 详情 | 用户会话 |
| POST | /api/v1/auth/login, /api/v1/auth/logout | 登录登出 | - |
| GET/POST/DELETE | /api/v1/devices | 设备管理，创建时返回一次性 token | 用户会话 |

- 接收接口兼容 JSON 和 form-urlencoded；字段别名：from/sender、content/text/msg/body/sms、timestamp/receive_time、device、sim、to。
- SmsForwarder 模板：`{"from":"{{FROM}}","content":"{{SMS}}","timestamp":"{{RECEIVE_TIME}}","device":"{{DEVICE_NAME}}","sim":"{{CARD_SLOT}}"}`。
- 设备 token 用 SHA-256 哈希存储，可吊销。可选 HMAC：`X-Signature = HMAC-SHA256(X-Timestamp + body, secret)`，±5 分钟窗口（MVP 可先实现可选校验）。
- 去重：hash(device_id + from + 规范化 content + floor(timestamp/60s))，重复返回 200 且 `duplicate: true`。
- 限流：每 token 60 次/分钟，超限 429（MVP 可用 D1 计数或简单实现）。
- 响应：`{ "ok": true, "id": ..., "code": "123456" }`。

## D1 表
users(id, username UNIQUE, password_hash, created_at)
devices(id, user_id, name, token_hash UNIQUE, secret, last_seen_at, created_at)
messages(id, device_id, from_number, to_number, content, content_hash, code, raw_payload, received_at, created_at)
索引：messages(device_id, received_at DESC)、messages(code)、messages(content_hash)。
放在 migrations/。管理员账号通过环境变量 ADMIN_USERNAME / ADMIN_PASSWORD（secret）首次引导创建。

## 网页
- 登录：用户名密码，PBKDF2（WebCrypto），HttpOnly + Secure 会话 Cookie。
- 收件箱：最新在前、分页、按设备/号码筛选、关键词搜索（LIKE）。
- 验证码：后端正则提取 4–8 位验证码（中英文提示词），前端高亮 + 一键复制。
- 设备管理页：新建设备并显示一次 token，附 iOS/Android 配置说明。
- 系统管理页：唯一管理员账号（改用户名/密码）、会话管理、两步验证、系统信息。
- 刷新：MVP 用 5–10 秒短轮询。
- 前端轻量：纯 HTML + Alpine.js 或原生 JS，无需复杂构建。

## 安全
- 日志不记录短信全文；CORS 仅同源；token 只显示一次。
- 保留策略：Cron 删除超过 RETENTION_DAYS（默认 90）天的消息。

## 目录
src/index.ts, src/routes/sms.ts, src/routes/api.ts, src/db.ts, src/auth.ts, src/extract.ts, src/types.ts, migrations/, public/（静态资源）, wrangler.jsonc, package.json, README.md（含 Deploy to Cloudflare 按钮）。

## MVP 验收
设备 token 鉴权、POST 接收、D1 存储、去重、验证码提取、登录 + 列表页、wrangler 一键部署；Android SmsForwarder 能上报；网页能看到并复制验证码。

## 后续（v1，非本次）
SSE 实时、Telegram/企业微信/Bark/邮件推送、AES-GCM 加密存储、完整 HMAC、iOS .shortcut 文件。账号保持单管理员，不再做多用户。

## 已知限制（写进 README）
iOS 只能转发匹配快捷指令触发条件的短信，需开机联网、重启后解锁一次、无 MMS、需关闭“运行前确认”。免费套餐 D1 写入约 10 万/天。

## 账号与会话（批次 3）

仍是一位管理员。不开放注册，不创建第二个管理员，`/api/v1/users` 保持 410。没有新的 migration。

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| POST | /api/v1/auth/username | 改用户名，必须带当前密码 | 管理员会话，敏感写 |
| POST | /api/v1/auth/password | 改密码，必须带当前密码；成功后撤销全部会话 | 管理员会话，敏感写 |
| GET | /api/v1/auth/sessions | 列出会话，`current` 标出当前 | 管理员会话 |
| POST | /api/v1/auth/sessions/revoke-others | 撤销其它会话 | 管理员会话，敏感写 |
| DELETE | /api/v1/auth/sessions/:id | 撤销指定会话 | 管理员会话，敏感写 |

- 登录失败写入已有 `rate_limits`：用户名 8 次 / 15 分钟，`CF-Connecting-IP` 30 次 / 15 分钟，超出 429。成功登录清掉当前窗口。改当前密码另有 8 次 / 15 分钟。
- Cookie：`HttpOnly`、`Path=/`、主机级（无 `Domain`）、`SameSite=Lax`，HTTPS 加 `Secure`，7 天。跨站 POST 不带 Cookie。
- 敏感写在 `isCrossSite` 之外，还拒绝 `Origin: null` 和除 `same-origin` / `none` 以外的 `Sec-Fetch-Site`。没有单独的 CSRF token。`logout` 仍只做原来的跨站拒绝，并且只删当前会话。
- 用户名仍等于 `ADMIN_USERNAME` 时，用 `ADMIN_PASSWORD` 登录会把库里的哈希写回该密钥。
