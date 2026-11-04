# GitHub Actions 部署机密

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中添加以下 repository secrets：

| Secret 名称 | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Wrangler 部署和应用 D1 迁移；令牌需要 Workers 和 D1 编辑权限。 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID：`df9099b08aefcec67ce14c18f00c7b52`。 |
| `GH_OAUTH_CLIENT_ID` | GitHub OAuth App 的 Client ID。 |
| `GH_OAUTH_CLIENT_SECRET` | GitHub OAuth App 的 Client Secret。 |
| `ADMIN_GH_USERNAME` | 管理员的 GitHub 用户名；只有这个账号能使用 GitHub 登录或首次注册成为管理员。 |

GitHub OAuth App 的回调地址应为：

```text
https://smsinbox.lokfu.workers.dev/api/v1/auth/github/callback
```

如果登录使用自定义域名 `sms.1791147.xyz`，回调地址应改为该域名对应的 origin：

```text
https://sms.1791147.xyz/api/v1/auth/github/callback
```

部署工作流在推送到 `main` 或手动触发时运行：安装依赖、测试、将已设置的 OAuth secrets 同步到 Worker，再应用远程 D1 迁移并部署。OAuth 对应的 repository secret 为空或未设置时，工作流会跳过该项，不会用空值覆盖已有 Worker secret。Cloudflare API token 和账号 ID 则必须配置，Wrangler 才能连接 Cloudflare。

本地手动部署仍可沿用 README 中的 Wrangler 命令。若启用 GitHub OAuth，在本地部署前需要自行用 `npx wrangler secret put` 设置 Worker secrets：`GH_CLIENT_ID`、`GH_CLIENT_SECRET` 和 `ADMIN_GH_USERNAME`。管理员密码仍使用既有 Worker secrets `ADMIN_USERNAME` / `ADMIN_PASSWORD`，不会由该流水线同步。
