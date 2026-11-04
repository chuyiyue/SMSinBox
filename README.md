# SMSinBox

自部署的短信收件箱。手机把收到的短信转发到你自己的 Cloudflare Worker，存入你自己的 D1 数据库，你在网页里查看、搜索、复制验证码，也可以把新短信继续推送到 Telegram、企业微信等渠道，或通过 API / MCP 交给其它程序读取。

只有一个管理员，没有公开注册。所有数据都在你自己的 Cloudflare 账号里，服务端日志不记录短信正文、验证码、token 或密码。

## 功能

- **短信接入**：每台设备一条专属推送链接。Android 用 SmsForwarder、iOS 用快捷指令，或任意 HTTP 客户端 POST 上报；链接可轮换、撤销，支持随机 Bearer 与设备 JWT 两种凭证。
- **收件箱**：实时到达（SSE 推送），按正文、号码、验证码搜索，按设备、号码、时间范围筛选。
- **验证码识别**：正则提取 + Workers AI 兜底两级识别；带分隔符的分组验证码（如 `613-408`）也能识别并拼合，验证码在界面上一键复制。
- **设备管理**：设备分组、置顶（最多 5 台）、按操作系统划分的设备类型、在线状态与最近上报时间。
- **推送通知**：新短信即时转发到 Telegram、企业微信、飞书、钉钉、Bark、Webhook、邮件（SMTP）；渠道可加备注、启停、发测试消息。
- **对外集成**：只读 REST API 与 MCP（Streamable HTTP）服务器；访问 Token 可命名、轮换、禁用，可按设备范围和权限（收件箱 / 设备 / 短信详情）分配。
- **账号安全**：单管理员；密码登录 + TOTP 两步验证（带恢复码）；可选 GitHub OAuth 登录（管理员校验共用登录用户名，不区分大小写，登录跳过两步验证）；登录会话可查看与撤销；支持自定义用户名与头像。
- **数据控制**：短信正文、验证码可用 AES-GCM 加密后再写入 D1（可选）；超过保留期（默认 90 天）的短信由每日定时任务自动删除。

技术组成：Cloudflare Workers（`src/`）+ D1 + Workers AI + 静态页面（`public/`，原生 HTML/CSS/JS，无框架）。

## 部署前共同准备

三种方案都需要先准备好：

1. 一个 **Cloudflare 账号**。
2. 在该账号里创建 D1 数据库（只需一次）：

   ```bash
   npx wrangler d1 create smsinbox
   ```

   `wrangler.jsonc` 里的 `database_id` 可以留空，Wrangler 按数据库名绑定；部署时若提示找不到数据库，再把创建输出的 UUID 填回 `d1_databases`。
3. 想好下面变量表里必填项的值（随机密钥可用 `openssl rand -base64 32` 生成）。

数据库迁移按文件名顺序执行（`0001_init.sql` 到 `0016_notify_channel_note.sql`，其中 `0005_device_push.sql` 起设备改用专属推送链接）。三种方案都是先迁移、再部署 Worker，顺序反了新代码会读不到新列。

### 变量总表

| 变量 | 类型 | 必填 | 默认 | 用途 |
| --- | --- | --- | --- | --- |
| `ADMIN_USERNAME` | Worker 机密 | 是 | 无 | 管理员用户名。第一次用它加密码登录成功时创建管理员账号；启用 GitHub 登录后，它同时是 GitHub 管理员校验名（不区分大小写）。 |
| `ADMIN_PASSWORD` | Worker 机密 | 是 | 无 | 管理员密码，建议足够长且随机。 |
| `DEVICE_JWT_SECRET` | Worker 机密 | 建议 | 无 | 设备 JWT 的签名密钥，32 字节 base64。不设时从 `CONTENT_KEY`、再从 `ADMIN_PASSWORD` 派生；更换它会让已签发的设备 JWT 立即失效（旧设备仍可用随机 Bearer 上报）。 |
| `CONTENT_KEY` | Worker 机密 | 否 | 空（不加密） | 32 字节 base64 的 AES-GCM 密钥。设置后短信正文、验证码、原始请求体、推送与 Token 密钥、TOTP 密钥都加密存储。**更换或清空后，之前加密的内容无法解密**，请先备份再改。 |
| `RETENTION_DAYS` | 普通变量（`wrangler.jsonc` 的 `vars`） | 否 | `90` | 短信保留天数，每天 00:00 UTC 的定时任务删除更早的短信（按写入时间）。 |
| `GH_CLIENT_ID` | Worker 机密 | 否 | 无 | GitHub OAuth App 的 Client ID。与下一项同时设置才启用 GitHub 登录。 |
| `GH_CLIENT_SECRET` | Worker 机密 | 否 | 无 | GitHub OAuth App 的 Client Secret。 |

## 方案一：Agents 部署

让带电脑操作能力的 AI Agent（如 Muse）替你完成全部部署：你给访问权限和变量值，Agent 执行命令、设置机密、跑迁移、部署并验证登录页，最后向你汇报地址和结果。

**你要提供的：**

- 本仓库地址（或让 Agent 克隆你的分支）。
- Cloudflare 访问（二选一）：在 Agent 的浏览器里登录你的 Cloudflare 账号，或给一个 API Token（需 Workers 与 D1 编辑权限）加账号 ID。
- 变量值：`ADMIN_USERNAME`、`ADMIN_PASSWORD` 由你定；`DEVICE_JWT_SECRET`、`CONTENT_KEY` 可以让 Agent 生成随机值（生成后应写入你的密码管理器，不要把明文留在聊天记录里）。

**Agent 会执行的步骤（与手动部署相同，只是它来敲）：**

```bash
npm ci
npx wrangler d1 create smsinbox            # 已有则跳过
npx wrangler d1 migrations apply smsinbox --remote
printf '%s' '<ADMIN_USERNAME>'    | npx wrangler secret put ADMIN_USERNAME
printf '%s' '<ADMIN_PASSWORD>'    | npx wrangler secret put ADMIN_PASSWORD
printf '%s' '<DEVICE_JWT_SECRET>' | npx wrangler secret put DEVICE_JWT_SECRET
printf '%s' '<CONTENT_KEY>'       | npx wrangler secret put CONTENT_KEY   # 可选
npx wrangler deploy
```

**本方案涉及的变量**（全部设置在 Worker 一侧）：

| 变量 | 必填 | 谁提供 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 是 | 你 |
| `ADMIN_PASSWORD` | 是 | 你 |
| `DEVICE_JWT_SECRET` | 建议 | 你或 Agent 生成 |
| `CONTENT_KEY` | 否 | 你或 Agent 生成 |
| `RETENTION_DAYS` | 否 | 默认 `90`，改 `wrangler.jsonc` |
| `GH_CLIENT_ID` / `GH_CLIENT_SECRET` | 否 | 你（先建好 GitHub OAuth App，见文末） |

## 方案二：GitHub Actions 部署

推送到 `main` 分支后自动测试、应用迁移并部署（流水线在 `.github/workflows/deploy.yml`）。适合持续更新：改完代码合并即可上线，不用本地装环境。

**一次性准备（流水线不会替你做）：**

1. 按「共同准备」创建好 D1 数据库 `smsinbox`。
2. 先给 Worker 设置好流水线**不会同步**的机密（用方案一或方案三的命令，或在 Cloudflare 控制台里设置）：`ADMIN_USERNAME`、`ADMIN_PASSWORD`，以及建议设置的 `DEVICE_JWT_SECRET`、可选的 `CONTENT_KEY`。
3. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 里添加下面的仓库机密。

**本方案涉及的变量：**

仓库机密（GitHub 侧）：

| 变量 | 必填 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 是 | 流水线用它跑 wrangler：需要 Workers 与 D1 的编辑权限。 |
| `CLOUDFLARE_ACCOUNT_ID` | 是 | 你的 Cloudflare 账号 ID。 |
| `GH_CLIENT_ID` | 否 | GitHub OAuth App 的 Client ID。流水线会把它同步为同名 Worker 机密；为空则跳过，不覆盖已有值。 |
| `GH_CLIENT_SECRET` | 否 | 同上，Client Secret。 |

Worker 机密（提前设置，流水线不碰）：

| 变量 | 必填 |
| --- | --- |
| `ADMIN_USERNAME` | 是 |
| `ADMIN_PASSWORD` | 是 |
| `DEVICE_JWT_SECRET` | 建议 |
| `CONTENT_KEY` | 否 |

普通变量：`RETENTION_DAYS` 仍在 `wrangler.jsonc` 里改，默认 `90`。

流水线每次运行依次做：安装依赖 → `npm test` → 把非空的 `GH_*` 仓库机密同步到 Worker → `wrangler d1 migrations apply smsinbox --remote` → `wrangler deploy`。也可以在 Actions 页面手动触发（workflow_dispatch）。

## 方案三：手动部署

本地命令行部署，需要 Node.js 22+ 和 Cloudflare 账号。

```bash
npm ci
npx wrangler login
npx wrangler d1 create smsinbox            # 已有则跳过
npx wrangler d1 migrations apply smsinbox --remote

printf '%s' '你的用户名'        | npx wrangler secret put ADMIN_USERNAME
printf '%s' '一段足够长的密码'   | npx wrangler secret put ADMIN_PASSWORD
openssl rand -base64 32 | npx wrangler secret put DEVICE_JWT_SECRET
openssl rand -base64 32 | npx wrangler secret put CONTENT_KEY
# 启用 GitHub 登录时再加：
printf '%s' 'OAuth App 的 Client ID'     | npx wrangler secret put GH_CLIENT_ID
printf '%s' 'OAuth App 的 Client Secret' | npx wrangler secret put GH_CLIENT_SECRET

npx wrangler deploy
```

`secret put` 从标准输入读值，避免密钥出现在 shell 历史里。`CONTENT_KEY` 一行可选，不设则短信明文存入你自己的 D1。

**本方案涉及的变量：**

| 变量 | 必填 | 设置方式 |
| --- | --- | --- |
| `ADMIN_USERNAME` | 是 | `wrangler secret put` |
| `ADMIN_PASSWORD` | 是 | `wrangler secret put` |
| `DEVICE_JWT_SECRET` | 建议 | `wrangler secret put` |
| `CONTENT_KEY` | 否 | `wrangler secret put` |
| `GH_CLIENT_ID` / `GH_CLIENT_SECRET` | 否 | `wrangler secret put` |
| `RETENTION_DAYS` | 否 | 改 `wrangler.jsonc` 的 `vars`，默认 `90` |

## 部署之后

1. 打开 Worker 的 `*.workers.dev` 地址（或你绑定的自定义域名），用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录——第一次成功登录会在 D1 里创建管理员账号。
2. 在「设备列表」里添加设备，把生成的推送链接填进手机上的转发工具，发一条测试短信确认收件箱能收到。iOS 点 [导入快捷指令](https://www.icloud.com/shortcuts/f7880f724c5443aebffc1ab5c5b7788f)（已签名，在 Apple 设备上会直接跳到快捷指令 App 导入），把推送链接填到指令里预留的位置即可；Android 用 SmsForwarder 的 Webhook 通道填推送链接。设备页的「接入指引」里有分平台的完整步骤。
3. 按需在「推送渠道」里加通知渠道，在「API 与 MCP」里签发对外 Token。

### 启用 GitHub 登录（可选）

1. 在 GitHub **Settings → Developer settings → OAuth Apps** 新建一个 OAuth App，回调地址填 `https://<你的域名>/api/v1/auth/github/callback`。
2. 把它的 Client ID / Client Secret 设置为 Worker 机密 `GH_CLIENT_ID` / `GH_CLIENT_SECRET`（Actions 方案则填同名仓库机密，等流水线同步）。
3. 管理员就是 `ADMIN_USERNAME` 同名的 GitHub 账号（不区分大小写）；已绑定过的账号也可登录。GitHub 登录跳过两步验证，密码登录规则不变。

## 接口与页面

- **收件箱 `/`**：新短信在前，可按设备、号码、关键词和时间筛选；验证码 chip 一键复制；通过 SSE 实时接收新短信，后台标签页断开、每 30 秒补拉一次防漏。
- **设备 `/devices.html`**：设备卡片平铺显示类型图标、在线状态、推送链接（明文可复制）；分组、置顶、改名、轮换 / 撤销链接、发送测试消息、删除设备都在卡片与详情抽屉里；「接入指引」页签有 iOS / Android 配置说明。
- **推送渠道 `/notify.html`**：「系统推送」页签管理 Telegram、企业微信、飞书、钉钉、Bark、Webhook、邮件渠道（备注、启停、测试都在卡上）；「外部推送」页签为预留位，后续与其它项目联动。
- **API 与 MCP `/api-mcp.html`**：管理对外 Token（生成、改名、轮换、禁用 / 启用、删除），配置只读权限与设备授权范围；展示 MCP 端点 `/mcp` 的连接信息与配置样例、外部 API 文档。
- **系统管理 `/users.html`**：管理员账号（改显示用户名、自定义头像、改密码）、会话管理、两步验证、GitHub 绑定、系统信息。
- **MCP 只读工具**（共 7 个，绝不提供写 / 删 / 改）：`list_messages`、`search_messages`、`get_message`、`get_latest_otp`、`search_otp`、`list_devices`、`get_device_status`。外部 REST API 为 `/api/ext/v1`，与 MCP 共用同一套 Token 权限。

## 限制

这些限制是产品行为或免费套餐额度，不是配置写错。

- iOS 只会转发匹配自动化条件的新短信；手机需开机联网，重启后要先解锁一次；这条路径不支持彩信（MMS），且必须关闭「运行前询问」。
- 不设置 `CONTENT_KEY` 时，短信正文以明文存在你自己的 D1 里。设置之后，正文、验证码和原始请求体用 AES-GCM 加密，每条短信使用独立的 12 字节 IV；开启加密后关键词搜索只解密最近 500 条匹配，更早的短信需要缩小设备或号码筛选（接口返回 `search_truncated: true` 时即是这种情形）。
- 每天 00:00 UTC 删除超过 `RETENTION_DAYS`（默认 90）天的短信，按写入时间计算。
- 去重键是设备、发件人、压成单行空格后的正文，以及接收时间所在的那一分钟；一分钟后再收到同样内容，会记成新短信。
- 管理员口令使用 PBKDF2-SHA256（10000 次迭代，受免费套餐 CPU 限制）；登录失败有 15 分钟窗口上限（用户名 8 次、来源 IP 30 次）。
- Workers / D1 免费套餐额度决定实际吞吐：每条新短信大约写入 3 行，收件箱页面一直开着时 SSE 与补拉会持续产生读取，请按自己的用量评估。
- 没有公开注册，也没有第二个管理员。`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只引导或认领唯一管理员。

## 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填本地用的 ADMIN_USERNAME 等变量
npm run db:migrate:local
npm run dev
npm test
npx tsc --noEmit
```

`.dev.vars` 里可放本地用的 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`DEVICE_JWT_SECRET`，可选 `CONTENT_KEY`、`GH_CLIENT_ID`、`GH_CLIENT_SECRET`。改了 `wrangler.jsonc` 的绑定后，运行 `npm run cf-typegen` 重新生成 `worker-configuration.d.ts`。

测试覆盖验证码提取（含分隔符分组码、Workers AI 兜底与防幻觉校验）、上报解析、去重、登录与限流、会话、TOTP、推送、加密、单用户归并与页面结构一致性；`test/release.integration.test.ts` 用本地 D1 跑完整迁移与上报链路，不连接生产。

更细的机密说明见 [docs/DEPLOY_SECRETS.md](docs/DEPLOY_SECRETS.md)，发布与迁移顺序见 [docs/RELEASE_IOS_V2.md](docs/RELEASE_IOS_V2.md)。
