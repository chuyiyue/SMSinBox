<p align="center">
  <img src="./public/logo.png" alt="SMSinBox" width="128" />
</p>

<h1 align="center">SMSinBox</h1>

<p align="center">
  运行在 <strong>Cloudflare Workers</strong> 上的自部署 <strong>短信收件箱</strong><br/>
  多设备接入 · 验证码识别 · 自动翻译 · 8 种推送渠道 · API / MCP
</p>

<p align="center">
  <a href="https://github.com/chuyiyue/SMSinBox/stargazers"><img src="https://img.shields.io/github/stars/chuyiyue/SMSinBox?style=for-the-badge&logo=github" alt="Stars" /></a>
  <a href="https://github.com/chuyiyue/SMSinBox/network/members"><img src="https://img.shields.io/github/forks/chuyiyue/SMSinBox?style=for-the-badge&logo=github" alt="Forks" /></a>
  <a href="https://github.com/chuyiyue/SMSinBox/graphs/contributors"><img src="https://img.shields.io/github/contributors/chuyiyue/SMSinBox?style=for-the-badge" alt="Contributors" /></a>
  <a href="https://github.com/chuyiyue/SMSinBox/issues"><img src="https://img.shields.io/github/issues/chuyiyue/SMSinBox?style=for-the-badge" alt="Issues" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare" alt="Workers" />
  <img src="https://img.shields.io/badge/Cloudflare-D1-F38020?style=flat-square&logo=cloudflare" alt="D1" />
  <img src="https://img.shields.io/badge/Workers-AI-orange?style=flat-square" alt="Workers AI" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=nodedotjs" alt="Node" />
</p>

<p align="center">
  <a href="./README.md"><strong>简体中文</strong></a> ·
  <a href="https://github.com/chuyiyue/SMSinBox">GitHub</a>
</p>

---

手机把收到的短信转发到你自己的 Cloudflare Worker，存入你自己的 D1 数据库。你在网页里查看、搜索、复制验证码，也可以把新短信继续推送到 Telegram、企业微信等渠道，或通过 API / MCP 交给其它程序读取。只有一个管理员，没有公开注册；所有数据都在你自己的 Cloudflare 账号里，服务端日志不记录短信正文、验证码、token 或密码。

---

## 目录

- [功能一览](#功能一览)
- [技术栈](#技术栈)
- [快速开始（本地开发）](#快速开始本地开发)
- [环境变量一览](#环境变量一览)
- [部署方式](#部署方式)
  - [方式 A：命令行（Wrangler CLI）](#方式-a命令行wrangler-cli)
  - [方式 B：GitHub Actions 自动部署](#方式-bgithub-actions-自动部署)
  - [方式 C：AI Agent 代部署](#方式-cai-agent-代部署)
- [数据模型（D1）](#数据模型d1)
- [目录结构](#目录结构)
- [生产加固建议](#生产加固建议)
- [限制与注意事项](#限制与注意事项)
- [贡献者](#贡献者)

---

## 功能一览

| 模块 | 说明 |
|------|------|
| 短信接入 | 每台设备一条专属推送链接（随机 Bearer 或设备 JWT 两种凭证），可轮换、撤销；iOS 快捷指令、Android SmsForwarder、OpenWrt 路由器脚本或任意 HTTP 客户端都能上报 |
| 网页收件箱 | SSE 实时到达；按正文、号码、验证码搜索，按设备、号码、时间范围筛选；验证码一键复制 |
| 验证码识别 | 正则提取 + Workers AI 兜底两级识别；带分隔符的分组验证码（如 `613-408`）也能识别并拼合 |
| 短信翻译 | 新短信自动翻译为系统语言（管理员的界面语言）：m2m100 主路径 + 对话模型兜底，推送与详情里附原文 |
| 推送通知 | 8 种渠道：Telegram、企业微信、Bark、邮件（Resend / SMTP / Webhook 三种模式）、Webhook、NotifyX、飞书、钉钉；渠道可加备注、启停、编辑与发送测试 |
| 推送标题 | 统一模板「来自{设备}的新短信」，带验证码时追加「· 验证码 {code}」，通知横幅上一眼看出短信来自哪台设备 |
| 推送历史 | 每次推送的渠道、成败与内容预览都可查 |
| 设备管理 | 设备分组、置顶（侧边栏最多 5 台）、按操作系统划分的设备类型、在线状态与最近上报时间 |
| 对外 API 与 MCP | REST API（`/api/ext/v1`）与 MCP 服务器（Streamable HTTP，`/mcp`，10 个工具）；Token 可命名、轮换、禁用，可按设备范围和权限分配；持 `devices:create` / `devices:push` 权限的 Token 还可添加设备、获取与轮换推送链接 |
| 账号与登录 | 单管理员、无公开注册；密码登录 + TOTP 两步验证（带恢复码）；可选 GitHub OAuth 登录（跳过两步验证）；可自定义显示名与头像 |
| 双语界面 | 简体中文 / English 全站切换，在系统管理里选择；短信翻译的目标语言随界面语言 |
| 数据控制 | 短信正文、验证码等可选 AES-GCM 加密后再写入 D1（`CONTENT_KEY`）；超过保留期（默认 90 天）的记录由每日定时任务自动删除 |

---

## 技术栈

- **Cloudflare Workers**（TypeScript，`src/`）：HTTP API、短信上报、SSE 实时推送、每日定时任务、MCP 服务器
- **Cloudflare D1**：全部业务数据，表结构由 `migrations/` 管理
- **Workers AI**：翻译主路径 m2m100；翻译兜底与验证码识别共用一个对话模型，由 `AI_MODEL` 机密统一配置
- **静态前端**（`public/`）：原生 HTML / CSS / JS，无框架、无构建步骤；文案由中英双语字典驱动

---

## 快速开始（本地开发）

**要求：** Node.js **20+**（见 `package.json` 的 `engines`）· 一个 Cloudflare 账号（本地开发用 Wrangler 的本地 D1 即可跑通大部分功能）

```bash
git clone https://github.com/chuyiyue/SMSinBox.git
cd SMSinBox
npm ci
cp .dev.vars.example .dev.vars   # 填本地用的 ADMIN_USERNAME / ADMIN_PASSWORD
npm run db:migrate:local
npm run dev
```

| 入口 | 地址（本地默认） |
|------|------|
| 收件箱 | http://localhost:8787/ |
| 设备列表 | http://localhost:8787/devices.html |
| 推送渠道 | http://localhost:8787/notify.html |
| API 与 MCP | http://localhost:8787/api-mcp.html |
| 系统管理 | http://localhost:8787/users.html |

`.dev.vars` 里可放本地用的 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`DEVICE_JWT_SECRET`，可选 `CONTENT_KEY`、`GH_CLIENT_ID`、`GH_CLIENT_SECRET`。改了 `wrangler.jsonc` 的绑定后，运行 `npm run cf-typegen` 重新生成 `worker-configuration.d.ts`。

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | `wrangler dev` 本地开发 |
| `npm run deploy` | `wrangler deploy` 部署到 Cloudflare |
| `npm test` | Vitest 全套测试（含用本地 D1 跑完整迁移与上报链路的集成测试，不连接生产） |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run cf-typegen` | 按 `wrangler.jsonc` 重新生成 Worker 类型 |
| `npm run db:migrate:local` | 对本地 D1 应用迁移 |
| `npm run db:migrate:remote` | 对远程 D1 应用迁移 |

测试覆盖验证码提取（含分隔符分组码、Workers AI 兜底与防幻觉校验）、上报解析、去重、登录与限流、会话、TOTP、推送、翻译、加密、单用户归并与页面结构一致性。

更细的机密说明见 [docs/DEPLOY_SECRETS.md](docs/DEPLOY_SECRETS.md)，发布与迁移顺序见 [docs/RELEASE_IOS_V2.md](docs/RELEASE_IOS_V2.md)。

---

## 环境变量一览

分四类：**绑定（Bindings）**、**普通变量（vars）**、**Worker 机密（Secrets）**、**GitHub Actions 仓库机密**。

### 1. 绑定（`wrangler.jsonc`，非字符串变量）

| 绑定名 | 类型 | 说明 |
|--------|------|------|
| `DB` | D1 | 业务数据库（数据库名 `smsinbox`） |
| `ASSETS` | Assets | `public/` 静态页面 |
| `AI` | Workers AI | 翻译兜底与验证码识别；本地缺失时 AI 路径自动跳过 |

### 2. 普通变量（`wrangler.jsonc` 的 `vars`）

| 变量 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `RETENTION_DAYS` | string | 否 | `90` | 短信和推送历史保留天数，每天 00:00 UTC 的定时任务删除更早的记录（按写入时间） |
| `CONTENT_KEY` | string | 否 | 空（不加密） | 配置里以空值占位；真正启用加密时按下面的机密方式设置，不要把明文写进仓库 |

### 3. Worker 机密（Secrets，勿提交到 Git）

| 变量 | 必填 | 设置方式 | 说明 |
|------|------|----------|------|
| `ADMIN_USERNAME` | **是** | `wrangler secret put ADMIN_USERNAME` | 管理员用户名。第一次用它加密码登录成功时创建管理员账号；启用 GitHub 登录后，它同时是 GitHub 管理员校验名（不区分大小写） |
| `ADMIN_PASSWORD` | **是** | `wrangler secret put ADMIN_PASSWORD` | 管理员密码，建议足够长且随机 |
| `DEVICE_JWT_SECRET` | 建议 | `wrangler secret put DEVICE_JWT_SECRET` | 设备 JWT 的签名密钥，32 字节 base64。不设时从 `CONTENT_KEY`、再从 `ADMIN_PASSWORD` 派生；更换它会让已签发的设备 JWT 立即失效（旧设备仍可用随机 Bearer 上报） |
| `CONTENT_KEY` | 否 | `wrangler secret put CONTENT_KEY` | 32 字节 base64 的 AES-GCM 密钥。设置后短信正文、验证码、原始请求体、推送与 Token 密钥、TOTP 密钥都加密存储。**更换或清空后，之前加密的内容无法解密**，请先备份再改 |
| `GH_CLIENT_ID` | 否 | `wrangler secret put GH_CLIENT_ID` | GitHub OAuth App 的 Client ID。与下一项同时设置才启用 GitHub 登录 |
| `GH_CLIENT_SECRET` | 否 | `wrangler secret put GH_CLIENT_SECRET` | GitHub OAuth App 的 Client Secret |
| `AI_MODEL` | 否 | `wrangler secret put AI_MODEL` | 翻译兜底与验证码识别共用的 Workers AI 对话模型；不设时用内置默认 `@cf/google/gemma-4-26b-a4b-it`。换模型只改这个值并重新部署 |

### 4. GitHub Actions 仓库机密（仅方式 B 用）

| 名称 | 必填 | 说明 |
|------|------|------|
| `CLOUDFLARE_API_TOKEN` | **是** | 流水线用它跑 Wrangler，需要 Workers 与 D1 的编辑权限 |
| `CLOUDFLARE_ACCOUNT_ID` | **是** | 你的 Cloudflare 账号 ID |
| `GH_CLIENT_ID` | 否 | 非空时由流水线同步为同名 Worker 机密；为空则跳过，不覆盖已有值 |
| `GH_CLIENT_SECRET` | 否 | 同上 |
| `AI_MODEL` | 否 | 非空时由流水线同步为同名 Worker 机密；为空则跳过 |

> Worker 上的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `DEVICE_JWT_SECRET` / `CONTENT_KEY` 须提前单独设置，流水线**不会**同步这几项。

### 5. 本地开发（`.dev.vars`，gitignored）

复制自 [`.dev.vars.example`](./.dev.vars.example)：`ADMIN_USERNAME`、`ADMIN_PASSWORD` 必填，`CONTENT_KEY` 留空即明文存储。

---

## 部署方式

三种方式任选其一。**都需要 Cloudflare 账号，且都是先迁移、再部署 Worker**——顺序反了新代码会读不到新列。

### 公共准备

1. 创建 D1 数据库（只需一次）：

   ```bash
   npx wrangler d1 create smsinbox
   ```

   `wrangler.jsonc` 里的 `database_id` 可以留空，Wrangler 按数据库名绑定；部署时若提示找不到数据库，再把创建输出的 UUID 填回 `d1_databases`。

2. 数据库迁移按文件名顺序执行（`0001_init.sql` 到 `0019_user_locale.sql`，其中 `0005_device_push.sql` 起设备改用专属推送链接，`0018_push_logs.sql` 开始记录推送历史）。

3. 想好[环境变量一览](#环境变量一览)里必填项的值（随机密钥可用 `openssl rand -base64 32` 生成）。

---

### 方式 A：命令行（Wrangler CLI）

适合本机发布。需要 Node.js 20+ 和 Cloudflare 账号。

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

### 方式 B：GitHub Actions 自动部署

推送到 `main` 分支后自动测试、应用迁移并部署，流水线在 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)。适合持续更新：改完代码合并即可上线，不用本地装环境。也可以在 Actions 页面手动触发（workflow_dispatch）。

**一次性准备（流水线不会替你做）：**

1. 按「公共准备」创建好 D1 数据库 `smsinbox`。
2. 先给 Worker 设置好流水线**不会同步**的机密（用方式 A 的命令，或在 Cloudflare 控制台里设置）：`ADMIN_USERNAME`、`ADMIN_PASSWORD`，以及建议设置的 `DEVICE_JWT_SECRET`、可选的 `CONTENT_KEY`。
3. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 里添加[第 4 类仓库机密](#环境变量一览)。

流水线每次运行依次做：安装依赖 → `npm test` → 把非空的 `GH_*` / `AI_MODEL` 仓库机密同步到 Worker → `wrangler d1 migrations apply smsinbox --remote` → `wrangler deploy`。

### 方式 C：AI Agent 代部署

让带电脑操作能力的 AI Agent（如 Muse）替你完成全部部署：你给访问权限和变量值，Agent 执行命令、设置机密、跑迁移、部署并验证登录页，最后向你汇报地址和结果。

**你要提供的：**

- 本仓库地址（或让 Agent 克隆你的分支）。
- Cloudflare 访问（二选一）：在 Agent 的浏览器里登录你的 Cloudflare 账号，或给一个 API Token（需 Workers 与 D1 编辑权限）加账号 ID。
- 变量值：`ADMIN_USERNAME`、`ADMIN_PASSWORD` 由你定；`DEVICE_JWT_SECRET`、`CONTENT_KEY` 可以让 Agent 生成随机值（生成后应写入你的密码管理器，不要把明文留在聊天记录里）。

Agent 执行的步骤与方式 A 相同，只是它来敲命令。

---

### 部署之后

1. 打开 Worker 的 `*.workers.dev` 地址（或你绑定的自定义域名），用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录——第一次成功登录会在 D1 里创建管理员账号。
2. 在「设备列表」里添加设备，把生成的推送链接填进手机上的转发工具，发一条测试短信确认收件箱能收到。iOS 点 [导入快捷指令](https://www.icloud.com/shortcuts/f7880f724c5443aebffc1ab5c5b7788f)（已签名，在 Apple 设备上会直接跳到快捷指令 App 导入），把推送链接填到指令里预留的位置即可；Android 用 SmsForwarder 的 Webhook 通道填推送链接。设备页的「接入指引」里有分平台的完整步骤，另见 [docs/ios-setup.md](docs/ios-setup.md)。
3. 按需在「推送渠道」里加通知渠道，在「API 与 MCP」里签发对外 Token。

**启用 GitHub 登录（可选）：**

1. 在 GitHub **Settings → Developer settings → OAuth Apps** 新建一个 OAuth App，回调地址填 `https://<你的域名>/api/v1/auth/github/callback`。
2. 把它的 Client ID / Client Secret 设置为 Worker 机密 `GH_CLIENT_ID` / `GH_CLIENT_SECRET`（方式 B 则填同名仓库机密，等流水线同步）。
3. 管理员就是 `ADMIN_USERNAME` 同名的 GitHub 账号（不区分大小写）；已绑定过的账号也可登录。GitHub 登录跳过两步验证，密码登录规则不变。

---

## 数据模型（D1）

| 表 | 内容 |
|----|------|
| `users` | 唯一管理员账号（密码哈希、界面语言等偏好） |
| `sessions` | 登录会话（可在系统管理里查看与撤销） |
| `devices` | 设备、推送凭证哈希、在线状态 |
| `device_groups` | 设备分组与排序 |
| `messages` | 短信正文、验证码、译文与来源语言（可加密存储） |
| `notify_channels` | 推送渠道配置（密钥可加密存储） |
| `push_logs` | 推送历史（渠道、成败、内容预览） |
| `api_tokens` | 对外 API / MCP Token（权限与设备范围） |
| `totp_recovery_codes` / `totp_tickets` | 两步验证的恢复码与验证票据 |
| `rate_limits` | 登录失败限流计数 |
| `schema_meta` | 站点级键值元信息（如管理员显示名） |

表结构由 `migrations/` 下 19 个迁移文件按序建立与演进。

---

## 目录结构

```
src/                 # Worker 源码（TypeScript）
  index.ts           # 入口：路由分发、定时任务
  routes/            # 页面 API、短信上报、对外 API、MCP、GitHub 登录等路由
  notify.ts          # 8 种推送渠道、推送渲染与标题模板
  translate.ts       # 短信翻译（m2m100 主路径 + 对话模型兜底）
  extract.ts         # 验证码正则提取
  code-recognition.ts # 验证码 Workers AI 兜底识别
public/              # 静态页面（原生 HTML/CSS/JS）、图标与双语字典
migrations/          # D1 迁移（0001–0019，按文件名顺序执行）
docs/                # 部署机密、iOS 接入与发布文档
shortcuts/           # iOS 快捷指令模板
test/                # Vitest 测试（含本地 D1 集成测试）
wrangler.jsonc       # Worker 配置：绑定、变量、定时任务
```

---

## 生产加固建议

- 给 `ADMIN_PASSWORD` 用足够长的随机密码，并开启 TOTP 两步验证（恢复码离线保存）。
- 设置 `CONTENT_KEY`，让短信正文、验证码、渠道与 Token 密钥加密存储；注意它**更换或清空后旧数据无法解密**，改之前先备份。
- 密钥一律用 `wrangler secret put` 从标准输入传入，不要写进仓库文件；GitHub Actions 方案也同理，只放仓库机密。
- 登录失败限流已内置（15 分钟窗口：用户名 8 次、来源 IP 30 次）；想要第二层防护，可再用 [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) 把整个站点保护起来。
- 按需把 `RETENTION_DAYS` 调小，减少历史短信在库里的留存时间。

---

## 限制与注意事项

这些限制是产品行为或免费套餐额度，不是配置写错。

- iOS 只会转发匹配自动化条件的新短信；手机需开机联网，重启后要先解锁一次；这条路径不支持彩信（MMS），且必须关闭「运行前询问」。
- 不设置 `CONTENT_KEY` 时，短信正文以明文存在你自己的 D1 里。设置之后，正文、验证码和原始请求体用 AES-GCM 加密，每条短信使用独立的 12 字节 IV；开启加密后关键词搜索只解密最近 500 条匹配，更早的短信需要缩小设备或号码筛选（接口返回 `search_truncated: true` 时即是这种情形）。
- 每天 00:00 UTC 删除超过 `RETENTION_DAYS`（默认 90）天的短信与推送历史，按写入时间计算。
- 去重键是设备、发件人、压成单行空格后的正文，以及接收时间所在的那一分钟；一分钟后再收到同样内容，会记成新短信。
- 管理员口令使用 PBKDF2-SHA256（10000 次迭代，受免费套餐 CPU 限制）。
- Workers / D1 免费套餐额度决定实际吞吐：每条新短信大约写入 3 行，收件箱页面一直开着时 SSE 与补拉会持续产生读取，请按自己的用量评估。
- 没有公开注册，也没有第二个管理员。`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只引导或认领唯一管理员。

---

## 贡献者

感谢所有为本仓库做出贡献的开发者：

<p align="left">
  <a href="https://github.com/chuyiyue/SMSinBox/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=chuyiyue/SMSinBox" alt="Contributors" />
  </a>
</p>

- 贡献者列表：https://github.com/chuyiyue/SMSinBox/graphs/contributors
- Star 趋势：https://github.com/chuyiyue/SMSinBox/stargazers

欢迎 Issue / PR。提交前请运行：

```bash
npm test
npx tsc --noEmit
```

<p align="center">
  <sub>SMSinBox · Built on Cloudflare Workers</sub>
</p>
