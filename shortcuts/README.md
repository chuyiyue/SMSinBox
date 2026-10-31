# 快捷指令模板

这两个文件是未签名的快捷指令 plist，由 `src/shortcut.ts` 的 `buildShortcut()` 生成。默认 Webhook 是 `https://example.workers.dev/api/v1/sms`，里面没有设备 token。

- `SMSinBox-iOS.shortcut`：导入后自行把自动化条件设为「信息包含一个空格」。
- `SMSinBox-iOS-code.shortcut`：正文不包含「验证码」或 `code` 时停止，不发送请求。

## 为什么没有签名

`shortcuts sign` 只随 macOS 的 Shortcuts 命令行提供。这个仓库在 Linux 上构建，签不了名，也不要放一个伪造的签名。iOS 15 及更高版本经常拒绝导入未签名文件。

请在 iPhone 上按 [docs/ios-setup.md](../docs/ios-setup.md) 导入或手动重建，或使用维护者之后发布的 iCloud 分享链接。文档里写着「尚未发布」时，还没有可用链接。

设备页的下载接口会用当前站点的地址重新生成同一份模板，仍然不会写入 token。导入时快捷指令会询问 Webhook URL 和设备 token。
