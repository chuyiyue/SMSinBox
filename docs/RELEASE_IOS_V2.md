# iOS v2 发布清单

本地准备完成。本次不执行生产部署，不推送远程，不签名快捷指令，不填写 iCloud 链接。

发布对象是已经在 `main` 上的推送链接、统一快捷指令和设备页。操作者按下面的顺序自己部署。先迁移再部署。

## 这次要带上的迁移

按文件名顺序应用 `migrations/` 里的全部文件：

- `0001_init.sql`
- `0002_notify.sql`
- `0003_message_encryption.sql`
- `0004_users.sql`
- `0005_device_push.sql`
- `0006_single_user.sql`
- `0007_totp.sql`
- `0008_device_identity.sql`

`0005_device_push.sql` 只追加 `push_token_hash`、`push_revoked_at` 和唯一索引。它不改已有 `token_hash`，不改短信，不删行。SQLite 的唯一索引允许多个 NULL，还没签发推送链接的旧设备可以共存。

`0006_single_user.sql` 只新增 `schema_meta`。它不改推送列，不删短信，也不在 SQL 里挑选管理员。单用户归并在配置的管理员下一次登录时由程序完成：先把其他用户的设备和通知渠道改挂过来，再删除他们的会话和用户行。设备 token、推送链接和历史短信保留。

`0008_device_identity.sql` 只给 `devices` 追加 `platform`（默认 `other`）和 `token_version`（默认 `0`）。它不重写 `token_hash`、不删设备、不删短信；旧设备仍走原来的随机 Bearer（有 secret 的继续校验 HMAC），新设备改用系统签发的 JWT。

`0007_totp.sql` 只给 `users` 追加 TOTP 列（`totp_secret`、`totp_pending_secret`、`totp_pending_created_at`、`totp_enabled_at`、`totp_last_counter`），并新建 `totp_recovery_codes`、`totp_tickets`。它不改已有行、不删短信；未启用两步验证的账号照旧用密码登录。启用后，登录第二步、恢复码和关闭流程走 `/api/v1/auth/totp/*`，详见 README。

新 Worker 会读取推送列和 TOTP 列。数据库还没跑过 `0005` / `0007` / `0008` 时不要部署这份 Worker。旧 Worker 不读这些列，所以先迁移再部署是安全的。

## 已在本地完成

- `npm test` 含 `test/release.integration.test.ts`。该文件用本地 D1 应用上述迁移，再走登录、旧行补签、Bearer、推送链接、轮换、撤销、HMAC、删除和保留任务。
- `npx tsc --noEmit`。
- 应用日志把 `/api/v1/ingest/<密钥>` 收成 `/api/v1/ingest/:secret`，不记录查询串。
- 推荐安装走文档中的 iCloud 分享链接（SMSinBox Next）。未签名备用模板由生成器产出，下载结果仍不含 `icloud.com/shortcuts` URL；链接写在文档与设备页。
- Android 和旧快捷指令仍指向 `/api/v1/sms`。

本环境没有 iPhone，也没有浏览器自动化。快捷指令能否导入、自动化开关、锁定时运行，要在操作者自己的手机上确认。

## 部署时由操作者执行

不要在本次准备中部署生产。需要上线时：

1. 确认 `wrangler.jsonc` 里的 `database_id` 是这个账号的 D1。空着时按 README 创建并填上，不要写一个假的 UUID。
2. 备份远程库：`npx wrangler d1 export smsinbox --remote --output smsinbox-backup.sql`。备份文件留在本机，不要提交。
3. 先迁移再部署：`npx wrangler d1 migrations apply smsinbox --remote`。看到 `0005_device_push.sql`、`0006_single_user.sql`、`0007_totp.sql` 和 `0008_device_identity.sql` 都已应用后再继续。本地用 `--local`。
4. 确认 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 已经用 `wrangler secret put` 设置。已经设置过的 `CONTENT_KEY` 不要更换或清空，否则旧的加密短信无法解密。
5. `npx wrangler deploy`。
6. 只用管理员密码登录（旧客户端带 username 也能登录，但会被忽略）。新建设备，确认接口同时给出一次性系统 JWT Bearer 和一次性推送链接。刷新后两样都不再出现。需要两步验证时，在「用户」页下方的「两步验证」卡片里绑定验证器并保存恢复码；之后登录会多一步验证码。
7. 用推送链接 POST 一条短信，收件箱能看到。再用原来的 Bearer POST `/api/v1/sms`，仍然成功。
8. 轮换后，旧推送链接返回 401，该设备已有短信还在。撤销后返回「推送链接已撤销」。丢掉链接就轮换，没有再显示明文的入口。
9. 设备页 Android 说明里的 URL 仍是 `/api/v1/sms`。下载的 `SMSinBox-iOS.shortcut` 不含这台设备的密钥。
10. 在 iPhone 上优先打开 `docs/ios-setup.md` 里的 iCloud 分享链接，或按该文档手动重建。系统拒绝未签名备用文件时，不要关掉系统的签名检查，也不要改用来路不明的其它分享链接。

推送链接等同设备密钥。不要把它发到聊天或工单里。应用日志已经打码，Workers 自己的请求日志仍可能看到路径。

## 回滚

不要手工删除 `0005` 的列。SQLite 不适合在线删列，旧 Worker 也会忽略它们。

若新 Worker 需要撤回，部署上一版 Worker 即可。已有 Bearer 继续上报。上一版没有 `/api/v1/ingest/`，已经发出的推送链接会停止接收，短信和 `token_hash` 还在。修好后重新部署，再为需要的设备轮换推送链接。

不要为了回滚去改 `CONTENT_KEY`。

## 明确不做

- 不在 Linux 上运行 `shortcuts sign`，不提交带签名块的 plist。
- 不编造 iCloud 链接，不为每台设备生成动态分享地址。
- 不删除 Bearer，不改 `POST /api/v1/sms` 的状态码和 HMAC 规则。
- 不把 `devices.secret` 或通知渠道配置改成哈希。
- 不提供第二条同时有效的推送链接，也不在服务端按「仅验证码」丢弃已经上传的正文。
