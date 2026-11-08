# GitHub Actions 部署机密

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中添加以下 repository secrets：

| Secret 名称 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署和应用 D1 迁移；令牌需要 Workers 和 D1 编辑权限。 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID：`df9099b08aefcec67ce14c18f00c7b52`。 |
| `GH_CLIENT_ID` | GitHub OAuth App 的 Client ID。 |
| `GH_CLIENT_SECRET` | GitHub OAuth App 的 Client Secret。 |
| `AI_MODEL` | 统一 AI 模型名：翻译兜底与验证码识别共用这一个模型。部署时同步为同名 Worker secret，代码读到就用它；不设置时用代码内置默认值 `@cf/google/gemma-4-26b-a4b-it`。 |
| `ADMIN_USERNAME` | 管理员登录用户名的唯一来源。流水线把它同步为同名 Worker secret，并在部署后写入 D1 里唯一的管理员行。运行时登录不读这个值。 |
| `ADMIN_PASSWORD` | 管理员密码的唯一来源。同步方式与 `ADMIN_USERNAME` 相同。改密码就是改这个仓库机密后重新部署。没有忘记密码工具。 |

GitHub 登录不使用 `ADMIN_USERNAME`。能登录的只有系统设置里绑定的数字 GitHub ID；GitHub 登录仍然跳过两步验证。两个 `GH_` 机密缺一则 GitHub 登录关闭。

GitHub OAuth App 的回调地址应为：

```text
https://smsinbox.lokfu.workers.dev/api/v1/auth/github/callback
```

如果登录使用自定义域名 `sms.1791147.xyz`，回调地址应改为该域名对应的 origin：

```text
https://sms.1791147.xyz/api/v1/auth/github/callback
```

部署工作流在推送到 `main` 或手动触发时运行：安装依赖、测试、将已设置的 OAuth secrets 同步到 Worker，再应用远程 D1 迁移并部署。部署之后，若 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD` 两个仓库机密都非空，流水线先把它们写成同名 Worker secret，再执行 `npm run sync-admin`，按「唯一一行」规则把用户名和密码哈希写入管理员行。任一为空则整段跳过，不报错，也不覆盖已有 Worker secret 或管理员行。OAuth 与 `AI_MODEL` 对应的 repository secret 为空或未设置时，工作流同样跳过该项，不会用空值覆盖已有 Worker secret。Cloudflare API token 和账号 ID 则必须配置，Wrangler 才能连接 Cloudflare。

本地手动部署仍可沿用 README 中的 Wrangler 命令。若启用 GitHub OAuth，在本地部署前需要自行用 `npx wrangler secret put` 设置 Worker secrets：`GH_CLIENT_ID` 和 `GH_CLIENT_SECRET`（流水线会把仓库机密 `GH_CLIENT_ID` / `GH_CLIENT_SECRET` 同步成这两个）。管理员用户名与密码的来源是仓库机密 `ADMIN_USERNAME` / `ADMIN_PASSWORD`：流水线在两者都非空时同步到 Worker，并在部署后写入管理员行。本地 `wrangler dev` 不会在登录时建管理员；远程同步脚本只打 `--remote`。`AI_MODEL` 同理：流水线会把仓库机密 `AI_MODEL` 同步成同名 Worker secret；仓库机密为空时跳过，Worker 继续用内置默认模型。
