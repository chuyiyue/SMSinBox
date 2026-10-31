# 快捷指令模板

推荐安装不依赖本目录的未签名文件，而是打开文档里的 iCloud 分享链接（**SMSinBox Next**，已签名）：

https://www.icloud.com/shortcuts/cdfde24d823a43318ee651bb4d2c9494

仓库里还有这些文件：

- `SMSinBox-iOS-Next.shortcut`：从上述 iCloud 记录下载的**已签名**二进制（AEA1），推送链接文本为空，可对照。`from`／`content` 使用信息自动化的 TriggerOutput（发件人／内容）。
- `SMSinBox-iOS-Next.unsigned.xml`：同一快捷指令的未签名 XML 导出，便于 diff，不能当作 iOS 安装主路径。
- `SMSinBox-iOS.shortcut`：未签名备用模板，由 `src/shortcut.ts` 的 `buildShortcut("all")` 生成；设备页「下载备用未签名文件」走这个。导入时只问「推送链接」，默认空。动作 POST JSON，标头只有 `Content-Type: application/json`。自动化里请把 `content` 绑成「信息 › 内容」。
- `SMSinBox-iOS-code.shortcut`：旧的关键词模板，对应 `buildShortcut("code")`，只保留给已经收藏的 `?variant=code` 下载。不要当成新的安装路径。

## 为什么没有签名

`shortcuts sign` 只随 macOS 的 Shortcuts 命令行提供。这个仓库在 Linux 上构建，签不了名，也不要放一个伪造的签名。iOS 15 及更高版本经常拒绝导入未签名文件。

请在 iPhone 上优先打开 [docs/ios-setup.md](../docs/ios-setup.md) 里的 iCloud 链接；备用再导入未签名文件或手动重建。生成器输出的未签名 plist **不会**写入 `icloud.com` URL（避免把分享地址编进下载文件）；链接只写在文档和设备页。

快捷指令的导入、立即运行、空格条件和通知，只能在使用者的 iPhone 上确认。

设备页的下载接口默认返回主模板，仍然不会写入 token 或推送密钥。`?variant=code` 继续返回关键词模板，并按当前站点填入 `/api/v1/sms`。
