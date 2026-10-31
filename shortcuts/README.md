# 快捷指令模板

这两份文件都是未签名的快捷指令 plist，由 `src/shortcut.ts` 的 `buildShortcut()` 生成。

- `SMSinBox-iOS.shortcut`：主模板，对应 `buildShortcut("all")`。导入时只问「推送链接」，默认空。动作 POST 到用户填写的链接，标头只有 `Content-Type: application/json`。文件里没有设备 token，也没有写死 `/api/v1/sms` 或某台设备的地址。自动化条件在手机上设置，例如「信息包含一个空格」。
- `SMSinBox-iOS-code.shortcut`：旧的关键词模板，对应 `buildShortcut("code")`。正文不包含「验证码」或 `code` 时停止，不发送请求。导入时询问 Webhook URL 和设备 token。默认 Webhook 是 `https://example.workers.dev/api/v1/sms`，里面没有设备 token。不要重写这个文件。

## 为什么没有签名

`shortcuts sign` 只随 macOS 的 Shortcuts 命令行提供。这个仓库在 Linux 上构建，签不了名，也不要放一个伪造的签名。iOS 15 及更高版本经常拒绝导入未签名文件。

请在 iPhone 上按 [docs/ios-setup.md](../docs/ios-setup.md) 导入或手动重建，或使用维护者之后发布的 iCloud 分享链接。文档里写着「尚未发布」时，还没有可用链接。

设备页的下载接口默认返回主模板，仍然不会写入 token 或推送密钥。`?variant=code` 继续返回关键词模板，并按当前站点填入 `/api/v1/sms`。
