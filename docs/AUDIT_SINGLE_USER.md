# SMSinBox 批次 0 审计：侧栏稳定性与单用户架构收敛

- **审计分支 / HEAD**：`stage2-audit` @ `452e255`（本 worktree）
- **审计时间**：2026-10-31（Asia/Singapore）
- **范围**：只读分析；本文件为批次 0 唯一交付物；不改业务代码、不推送、不部署
- **后续基线提示**：UI/UX 升级已合入 `main`（`120a6f9`）并已上线。批次 1（侧栏）须基于含 UI/UX 的分支开 worktree，勿直接在本 `452e255` 上改 `public/`。本审计对侧栏加载路径的结论在 UI/UX 后仍成立（MPA + 各页空 `#sidebar-devices` + 事后 API 填充），但具体行号/样式类名以最新 `main` 为准。

---

## 1. 侧栏设备列表闪烁：真实根因

### 1.1 一句话结论

管理后台是**静态多页（MPA）**：点侧栏导航会整页卸载重建；每页 HTML 里 `#sidebar-devices` 初始为空，设备列表只在页面 JS 请求 `/api/v1/devices` 后才用 `replaceChildren()` 填入，因此切换收件箱 / 设备 / 推送 / 用户时必然出现「先空后满」的闪烁。没有跨页持久 Layout，也没有全局设备 Store / sessionStorage 预填。

### 1.2 对照计划排查点

| 排查点 | 结论（对照 `public/common.js`、`inbox.js`、`devices.js`、`notify.js`、`users.js` 与各页 HTML） |
|--------|------|
| 侧栏是否随路由卸载重挂 | **是。** 导航是普通 `<a href>`（`/`、`/devices.html`、`/notify.html`、`/users.html`），整文档重建。不存在 SPA 壳或共享 Layout 组件。 |
| 设备列表是否只在设备页加载 | **否。** 四处都会拉：inbox/devices 各自 `loadDevices()`；notify/users 仅靠 `loadNav()` 在 `dataset.loaded !== "1"` 时拉 `/api/v1/devices`。 |
| 切菜单是否把设备态重置为空 | **是。** 新文档里 `#sidebar-devices` 为空；内存态随页面销毁。无跨文档 Store。 |
| 是否重复请求设备 API | **有条件重复。** inbox：先 `loadDevices`（标 `loaded=1`）再 `loadNav` → 单次 devices。devices：`loadDevices()` 与 `loadNav()` **并行**启动，但 `loadDevices` 同步写 `loaded=1`，故 loadNav 通常跳过第二次。notify/users：顺序 me → devices，各一次。**刷新竞态**：devices 页 `onRefresh` 再调 `loadDevices` 时无 Abort/generation，重叠请求均可 `renderSidebarDevices`。 |
| API 加载是否先清空已有数据 | **是。** `renderSidebarDevices` 一律 `box.replaceChildren()` 再全量重建；首屏本就无旧数据可保留。 |
| 多请求竞态旧盖新 | **存在风险。** 无请求 generation / AbortController；devices 快速刷新时旧响应可覆盖新列表。 |
| SSE/WS 是否拖垮侧栏 | **否。** inbox `EventSource(/api/v1/events)` 只推消息；侧栏设备不随 SSE 重绘。 |
| 列表 key 是否不稳定 | **无 reconciler。** 每次销毁重建 DOM；按钮用 `data-device-id`（设备 UUID 或「全部」空串），委托点击在父节点，事件本身稳定，但节点身份不保留 → 滚动/焦点/激活态易丢。 |
| 全局态与局部态互相覆盖 | **双写入者。** 页面局部 `loadDevices` 与 `loadNav` 都可写侧栏；靠脆弱的 `dataset.loaded` 互斥。inbox/devices 在 **await 前** 就把 `loaded=1`：请求失败时 loadNav **不会补拉**，侧栏可永久空白。 |

### 1.3 次要但真实的视觉跳动

1. **`#users-link` 默认 `hidden`**，等 `/api/v1/auth/me` 后对 admin 解除 → 导航块高度变化，可把已渲染的设备区下推约一行（devices 页 me 与 devices 响应顺序不确定时更明显）。
2. **`renderSidebarDevices` 硬编码「全部设备」`is-active`**，inbox 再 `setActiveDevice(url device_id)` → 带 `?device_id=` 时有一帧错误高亮。
3. **`#who` / `[data-who]` 首屏空**，me 返回后填用户名。
4. 桌面侧栏常显，空→满最刺眼；移动端抽屉默认藏，未打开时不易察觉。
5. 导航 `active` 类写在各页 HTML 上，随新文档即时正确，**不是**闪烁源。

### 1.4 推荐改法（批次 1）

#### 优先：持久 Layout（验收「切菜单侧栏 DOM 不换」）

1. 抽单一管理壳：侧栏 + topbar 常驻；主内容区 `.main`（或等价）按视图切换。
2. 客户端拦截壳内导航：`preventDefault` + `history.pushState`；硬刷新仍依赖现有真实 HTML（`index.html` / `devices.html` / `notify.html` / `users.html`），避免 Workers 复杂 fallback。
3. 模块级 **deviceStore**：`{ me, devices, activeId, generation, status }`；进壳拉一次 me + devices；切页不拉、不清空；创删改设备后再拉。
4. 渲染：按 `device.id` keyed 原地更新；「全部设备」用稳定哨兵 key；`is-active` 同一次绘制按 `activeId` 设置，禁止先全选「全部」再改。
5. 竞态：generation 或 AbortController；去掉「请求发出前写 `loaded=1`」。
6. 用户名 / 管理员入口从缓存的 me 同步渲染；避免靠 `hidden` 从文档流移除造成跳动（可用占位或首屏内联读缓存）。
7. **生命周期**：切走视图时关闭 EventSource、卸监听（inbox SSE 等），否则持久壳会泄漏/重复绑定。
8. 页面脚本在 layout 外：换 `.main` 须 **动态 import** 对应 `inbox.js` / `devices.js` 等，不能只替换 HTML 片段。

#### 次选：保留 MPA 的最小补丁（只能减空白，挡不住整文档重绘）

1. `<head>` 内联脚本在首绘前从 `sessionStorage` 同步回填设备列表与 me（角色）。
2. `renderSidebarDevices` 改为按 `data-device-id` diff，保留节点。
3. generation 防旧响应；失败时清除 `loaded` 允许重试。
4. 管理员链接触摸占位，减少布局跳动。

**明确：不能只靠藏 loading 动画交差；验收必须是切菜单时设备列表不消失、不整栏重建。sessionStorage 预填不能冒充持久 Layout。**

### 1.5 各页加载对照（452e255）

| 页面 | 启动 | 设备请求 | 备注 |
|------|------|----------|------|
| `index.html` + `inbox.js` | `loadDevices` → `loadNav` | 1 次 | 失败仍 `loaded=1`，侧栏可能空 |
| `devices.html` + `devices.js` | `loadDevices` ∥ `loadNav` | 通常 1 次 | 并行；刷新无取消 |
| `notify.html` + `notify.js` | 仅 `loadNav` | 1 次（经 loadNav） | |
| `users.html` + `users.js` | `loadNav`（赋给 me） | 1 次 | `#users-link` 同时 `hidden`+`active`，me 前当前项不可见 |

---

## 2. 多用户相关清单

### 2.1 数据库

| 对象 | 要点 |
|------|------|
| `users`（0001 + 0004） | `id`, `username` UNIQUE, `password_hash`, `created_at`；`role` DEFAULT `'member'`；`disabled_at` 可空 |
| `devices` | `user_id` NOT NULL → `users(id)`；0005：`push_token_hash` UNIQUE（多 NULL 允许）、`push_revoked_at`；`token_hash` UNIQUE |
| `messages` | **无 `user_id`**；经 `device_id` → devices；`content_hash` 全局唯一（含 device_id） |
| `sessions` | `user_id` → users；无列表 API；改密时 `deleteUserSessions` |
| `notify_channels` | `user_id` → users |
| `rate_limits` | `(token_hash, window_start)`；按设备/推送 token，非用户维 |
| 外键 | 均无 `ON DELETE CASCADE`；应用层 `deleteUserCascade` 显式删子表 |

### 2.2 API（`src/routes/api.ts`）

| 路径 | 行为 |
|------|------|
| `POST /api/v1/auth/login` | 密码或 `ADMIN_*` bootstrap；**无限流**；跨站 `isCrossSite` 拒绝 |
| `POST /api/v1/auth/logout` | 删当前会话 Cookie |
| `GET /api/v1/auth/me` | 当前用户 |
| `GET/POST /api/v1/users` | 管理员列表 / 创建（角色 admin\|member） |
| `POST /api/v1/users/:id` | 改 password / disabled / role；**不能改 username**（`readUserPatch` 无此字段） |
| `DELETE /api/v1/users/:id` | `deleteUserCascade`（含 **DELETE messages**） |
| 业务 API | devices / messages / events / notify 均按会话 `user_id` 过滤 |

**无公开注册路由。** 新用户入口：管理员 `POST /users`，或登录时 `ADMIN_USERNAME` 不存在则 insert admin。

Cookie：`HttpOnly`、`Path=/`、`SameSite=Lax`、HTTPS 下 `Secure`；会话 TTL 7 天。状态变更靠 `isCrossSite`（Sec-Fetch-Site / Origin），无独立 CSRF token。无会话列表 / 撤销其它会话接口。

### 2.3 前端

- `public/users.html`、`public/users.js`：用户列表、创建、改密/角色/停用、删除
- 各管理页 `#users-link`（文案「用户管理」）→ `/users.html`；`loadNav` 仅 `role === "admin"` 显示
- 导航文案现状：收件箱 / 设备管理 / 推送设置 / 用户管理（产品目标「我的设备 / 通知管理 / 系统管理」留给批次 5，批次 1 可不改文案）

### 2.4 Bootstrap / 限流 / 配额

- 空库且无 `ADMIN_*` → 登录 503；有用户无 env → 普通验密，不 bootstrap
- `ADMIN_USERNAME` 变更会 **再 insert 第二个 admin**，旧行残留 → 单用户隐患
- `rate_limits` / `consumeRateLimit` 用于短信 ingest（`sms.ts`），**登录无尝试限流**
- `MAX_DEVICES=50`、`MAX_NOTIFY_CHANNELS=10` 按 **每 user_id**；合并后若已超上限，后续创建会失败（勿为压数删历史）

### 2.5 已确认缺口（产品下一批要补）

| 项 | 现状 |
|----|------|
| TOTP / 2FA | **无**：无列、无路由、无前端；`extract.ts` 的 otp 仅为短信验证码 |
| 登录限流 | **无** |
| API 改用户名 | **不支持** |
| 会话列表 / 撤其它会话 | **无**（仅当前 logout；改密清该用户全部 session） |
| iOS 快捷指令 / 设备推送链接 | **已有，必须保留**（0005、`shortcut.ts`、devices 页推送 UI）；收敛时不得轮转 token / 改 `CONTENT_KEY` |

---

## 3. 单用户迁移：风险与步骤

### 3.1 致命风险

`deleteUserCascade`（`src/db.ts`）顺序包含：

`rate_limits` → **`messages`** → `devices` → `sessions` → `notify_channels` → `users`

若用它「删成员」会 **丢掉该用户设备下全部短信**。单用户收敛 **禁止** 对该路径用于数据归并。

### 3.2 正确归并顺序（运行时，非盲目 SQL）

1. **选定唯一管理员 `target_id`**：优先 `username === ADMIN_USERNAME`；对不上则 **中止**，勿默取「最老 admin」。
2. `UPDATE devices SET user_id = target WHERE user_id <> target`
3. `UPDATE notify_channels SET user_id = target WHERE user_id <> target`
4. `DELETE FROM sessions WHERE user_id <> target`（**不要**把成员 session 改挂到 admin，否则旧 Cookie 提权）
5. `DELETE FROM users WHERE id <> target`（此时子行已迁走，messages 经 devices 仍在）
6. 若 target 曾被 disable：清 `disabled_at` 或依赖下次 env 登录 `ensureAdmin`
7. 幂等标记（如 `schema_meta` / `single_user_merged_at`），防重复执行
8. **之后** 再关多用户 API / 拒非管理员登录

### 3.3 为何不把「删多余用户」写成纯 SQL migration

`wrangler d1 migrations` 跑纯 SQL，**读不到** Worker 的 `ADMIN_USERNAME`。按 `created_at` 猜存活管理员易误杀。SQL migration 只做安全 schema/检查；**数据归并由应用一次性脚本或受控管理端点**在运行时执行，且须操作员先登录一次完成 bootstrap。

### 3.4 其它注意

- `messages` / `content_hash` / 设备 `token_hash` / `push_token_hash`：改 `user_id` 不冲突；**勿旋转**推送/Bearer，iOS 链接保持有效
- 归并前保留 SQL 里的 `user_id` 过滤；「去多余隔离」指去掉多用户产品面（注册、用户管理 UI、member 运营），不是先删列
- **不要 DROP `users` 表**；保留唯一管理员行与成熟登录机制
- 改 `ADMIN_USERNAME` 的 bootstrap：收敛后应改为「只维护唯一管理员密码」，禁止再 insert 第二 admin
- 合并后设备/通知若已超 50/10：放宽创建校验或仅拦截新增，**不删历史**

---

## 4. 分阶段修改计划（批次 1–6）

与 `/workspace/smsinbox-queue/single-user-admin-plan.md` 对齐；每批约 ≤10 项；测完再议推送；**生产部署须用户明确批准**。

### 批次 1 — 侧栏稳定（P0）· 基于 `120a6f9`+ 的 worktree

**目标**：切菜单侧栏不卸、设备列表不清空、无空白闪、无重复有害请求。

建议文件：`public/common.js`（或新建 `device-store.js` / shell 路由）、`public/index.html`、`devices.html`、`notify.html`、`users.html`、`inbox.js`、`devices.js`、`notify.js`、`users.js`、`style.css`；更新 `test/site-consistency.test.ts` 等壳/导航断言。

要点：持久壳 + store + generation + keyed 更新 + 视图 leave 钩子；不要用假 loading 掩盖。

### 批次 2 — 单用户收敛（P1）· 可并行后端 worktree

建议文件：`src/routes/api.ts`、`src/db.ts`、migrations 增量、`test/users.test.ts`、`test/release.integration.test.ts`、README 用户章节。

1. 运行时归并（§3.2）；禁用/移除 `POST/GET/DELETE /api/v1/users` 多用户能力（或 404/410）
2. 登录仅唯一管理员；收敛 bootstrap 禁止第二 admin
3. 保留 devices/messages/notify/iOS/push 数据与凭证
4. 保留 `users` 表与 `user_id` 列；查询过滤可暂留

### 批次 3 — 管理员账号（P1）

建议文件：`src/routes/api.ts`、`src/auth.ts`、`src/db.ts`、相关测试。

改用户名 / 改密码（验当前密码）/ 改密撤会话 / 登录限流防爆破 / Cookie 与敏感操作 CSRF 加固 / 会话列表与撤销。**不允许**公开注册或第二管理员。

### 批次 4 — TOTP 2FA（P2）

增量列（如加密 `totp_secret`、`totp_enabled_at`、恢复码哈希）；绑定须先验码；关闭须密码+TOTP；恢复码单次失效；防重放与尝试验流；密钥不进日志。可复用 `CONTENT_KEY` 思路加密 secret（实现时再定）。

### 批次 5 — 系统管理页（P2）· 等 UI/UX + 3/4 API

`users.html` / `users.js` → 系统管理四区：管理员账号、安全（2FA/会话）、系统配置、关于。导航文案对齐产品；响应式与现有后台一致。

### 批次 6 — 全站回归（P3）

唯一管理员登录；未登录不可进管理页；注册不可用；改名改密；2FA 开关与恢复码；会话撤销；侧栏稳定；短信/设备/通知/iOS/推送链接；`npm test` + `tsc`；禁止删测试或放宽断言混过。

---

## 5. 明确不改 / 保留

- 已完成的 iOS 快捷指令、设备专属推送链接、0005 推送字段与相关测试
- 历史短信、设备凭证、`CONTENT_KEY` 加密
- 不因本阶段重做 iOS v2 策划
- 批次 0 不提交业务代码（仅本审计文档）

---

## 6. 建议的下一批

1. **批次 1（侧栏）**已具备条件：UI/UX `120a6f9` 已上线；在独立 worktree（如 `stage2-sidebar`）按 §1.4 持久 Layout 实施并跑前端一致性测试。
2. **批次 2**可在审计确认后另开后端 worktree：先设计运行时归并入口与幂等标记，再关多用户 API；**任何删除用户路径都不得走 `deleteUserCascade` 直到归并完成且产品不再需要级联删短信。**

---

*文档结束。源码结论均已在 `452e255` worktree 核对；若 `main` 后续提交改变侧栏加载函数名，以最新文件为准，根因（MPA 整页重建 + 空容器后填）不变。*
