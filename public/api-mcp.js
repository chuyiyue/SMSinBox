import {
  api,
  flashLabel,
  formatTime,
  initShell,
  mountSelect,
  openModal,
  showNotice,
  toast,
} from "./common.js";
import { ensureDevices, getDevices } from "./device-store.js";
import { registerView } from "./shell.js";

const PERMISSION_DEFS = [
  {
    key: "messages:read",
    name: "读取短信",
    description: "读取短信列表与正文",
    reads: "短信列表、正文、单条短信详情、按关键词/号码筛选的短信查询",
  },
  {
    key: "otp:read",
    name: "读取验证码",
    description: "读取最新验证码及检索验证码",
    reads: "最新验证码、验证码检索、带验证码的短信内容与来源",
  },
  {
    key: "devices:read",
    name: "读取设备",
    description: "查看授权设备列表",
    reads: "设备列表、设备名称、平台、创建时间、最后在线时间",
  },
  {
    key: "devices:status",
    name: "读取设备状态",
    description: "查看设备在线状态与最后上报时间",
    reads: "单台设备状态、在线/离线/未见、最后消息时间",
  },
];

const MCP_TOOLS = [
  {
    name: "list_messages",
    description: "按时间顺序列出区间内的短信，支持分页与设备/发送方过滤。",
    inputSchema: { limit: 10, offset: 0, device_id: "<device uuid>", since: 1710000000000 },
  },
  {
    name: "search_messages",
    description: "按关键词检索短信正文、发件人或验证码。",
    inputSchema: { q: "验证码", from: "10086", limit: 10, offset: 0 },
  },
  {
    name: "get_message",
    description: "读取单条短信的完整详情。",
    inputSchema: { id: "<message uuid>" },
  },
  {
    name: "get_latest_otp",
    description: "读取最新一条带验证码的短信。",
    inputSchema: { device_id: "<device uuid>", from: "10086" },
  },
  {
    name: "search_otp",
    description: "检索带验证码短信，支持时间范围与设备/发送方过滤。",
    inputSchema: { device_id: "<device uuid>", since: 1710000000000, until: 1710003600000 },
  },
  {
    name: "list_devices",
    description: "列出当前 Token 授权范围内的全部设备。",
    inputSchema: {},
  },
  {
    name: "get_device_status",
    description: "查询单个设备的状态与最近消息时间。",
    inputSchema: { id: "<device uuid>" },
  },
];

const API_ENDPOINTS = [
  {
    method: "GET",
    path: "/health",
    summary: "健康检查",
    description: "验证 API 是否在线且当前 Token 有效。",
    permission: "无需额外权限；有效 Token 即可",
    params: [],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/health\"",
    response: JSON.stringify({ ok: true, data: { status: "ok", version: "1.2.3", time: 1710000000000 } }, null, 2),
  },
  {
    method: "GET",
    path: "/me",
    summary: "当前 Token 详情",
    description: "返回 Token 的名称、权限、设备范围和过期时间。",
    permission: "有效 Token",
    params: [],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/me\"",
    response: JSON.stringify({ ok: true, data: { id: "<token-id>", name: "Cursor Agent", permissions: ["messages:read", "otp:read"], device_scope: [], expires_at: 1710000000000 } }, null, 2),
  },
  {
    method: "GET",
    path: "/messages",
    summary: "短信列表",
    description: "按分页与过滤条件返回短信列表。",
    permission: "messages:read",
    params: [
      { name: "limit", required: false, meaning: "返回数量，默认 20，最大 100" },
      { name: "offset", required: false, meaning: "分页偏移，默认 0" },
      { name: "device_id", required: false, meaning: "按设备 UUID 过滤" },
      { name: "from", required: false, meaning: "按发件人号码或名称过滤" },
      { name: "since", required: false, meaning: "只返回收到时间 >= 此毫秒时间戳的短信" },
      { name: "until", required: false, meaning: "只返回收到时间 <= 此毫秒时间戳的短信" },
      { name: "q", required: false, meaning: "按正文、发件人或验证码关键字搜索" },
    ],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/messages?limit=2&device_id=<device-id>&q=验证码\"",
    response: JSON.stringify({ ok: true, data: [{ id: "<message-id>", device_id: "<device-id>", device_name: "Device Alpha", from: "10086", from_number: "10086", to: "13800000000", to_number: "13800000000", content: "【中国移动】您的验证码是 889900，请勿泄露给他人。", code: "889900", received_at: 1710000000000, created_at: 1710000000000 }], page: { limit: 2, offset: 0, total: 1 } }, null, 2),
  },
  {
    method: "GET",
    path: "/messages/{id}",
    summary: "单条短信详情",
    description: "返回指定 messageId 的完整内容与识别结果。",
    permission: "messages:read",
    params: [
      { name: "id", required: true, meaning: "短信 UUID，需与当前 Token 授权范围内的消息匹配" },
    ],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/messages/<message-id>\"",
    response: JSON.stringify({ ok: true, data: { id: "<message-id>", device_id: "<device-id>", device_name: "Device Alpha", from: "10086", from_number: "10086", to: "13800000000", to_number: "13800000000", content: "【中国移动】您的验证码是 889900，请勿泄露给他人。", code: "889900", received_at: 1710000000000, created_at: 1710000000000 } }, null, 2),
  },
  {
    method: "GET",
    path: "/otp/latest",
    summary: "最新验证码",
    description: "返回当前范围内最新一条带验证码的短信。",
    permission: "otp:read",
    params: [
      { name: "device_id", required: false, meaning: "按设备 UUID 过滤" },
      { name: "from", required: false, meaning: "按发件人过滤" },
      { name: "since", required: false, meaning: "只返回收到时间 >= 此毫秒时间戳的验证码" },
    ],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/otp/latest?device_id=<device-id>\"",
    response: JSON.stringify({ ok: true, data: { id: "<message-id>", code: "889900", from: "10086", content: "【中国移动】您的验证码是 889900，请勿泄露给他人。", device_id: "<device-id>", device_name: "Device Alpha", received_at: 1710000000000, code_source: "regex", code_status: "recognized" } }, null, 2),
  },
  {
    method: "GET",
    path: "/otp/search",
    summary: "验证码检索",
    description: "按时间范围和设备/发件人条件搜索验证码列表。",
    permission: "otp:read",
    params: [
      { name: "limit", required: false, meaning: "返回数量，默认 20，最大 100" },
      { name: "offset", required: false, meaning: "分页偏移，默认 0" },
      { name: "device_id", required: false, meaning: "按设备 UUID 过滤" },
      { name: "from", required: false, meaning: "按发件人过滤" },
      { name: "since", required: false, meaning: "起始时间戳，毫秒" },
      { name: "until", required: false, meaning: "结束时间戳，毫秒" },
    ],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/otp/search?limit=20&since=1710000000000\"",
    response: JSON.stringify({ ok: true, data: [{ id: "<message-id>", code: "889900", from: "10086", content: "【中国移动】您的验证码是 889900，请勿泄露给他人。", device_id: "<device-id>", device_name: "Device Alpha", received_at: 1710000000000, code_source: "regex", code_status: "recognized" }], page: { limit: 20, offset: 0, total: 1 } }, null, 2),
  },
  {
    method: "GET",
    path: "/devices",
    summary: "授权设备列表",
    description: "返回当前 Token 授权范围内的设备列表与派生状态。",
    permission: "devices:read",
    params: [],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/devices\"",
    response: JSON.stringify({ ok: true, data: [{ id: "<device-id>", name: "Device Alpha", platform: "ios", created_at: 1700000000000, last_seen_at: 1710000000000, status: "online" }] }, null, 2),
  },
  {
    method: "GET",
    path: "/devices/{id}/status",
    summary: "单设备状态",
    description: "返回指定设备的在线状态和最后一条消息时间。",
    permission: "devices:status",
    params: [
      { name: "id", required: true, meaning: "设备 UUID，需在当前 Token 授权范围内" },
    ],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/devices/<device-id>/status\"",
    response: JSON.stringify({ ok: true, data: { id: "<device-id>", name: "Device Alpha", platform: "ios", last_seen_at: 1710000000000, status: "online", last_message_at: 1710000000000 } }, null, 2),
  },
];
let tokenListEl;

let pageErrorEl;
let pageStatusEl;
let dialogEl;
let formEl;
let formErrorEl;
let resultBoxEl;
let tokenPlaintextEl;
let scopePickerEl;
let deviceCheckboxListEl;

export function start() {
  initShell();

  const expiresSlot = document.querySelector("#token-expires");
  if (expiresSlot) {
    const field = mountSelect({
      name: "expires_in_days",
      value: "0",
      options: [
        { value: "0", label: "永不过期" },
        { value: "30", label: "30 天" },
        { value: "90", label: "90 天" },
        { value: "365", label: "365 天" },
      ],
      ariaLabel: "有效期",
    });
    expiresSlot.replaceWith(field.root);
  }
  tokenListEl = document.querySelector("#token-list");
  pageErrorEl = document.querySelector("#page-error");
  pageStatusEl = document.querySelector("#page-status");
  dialogEl = document.querySelector("#token-dialog");
  formEl = document.querySelector("#token-form");
  formErrorEl = document.querySelector("#token-form-error");
  resultBoxEl = document.querySelector("#token-result-box");
  tokenPlaintextEl = document.querySelector("#new-token-plaintext");
  scopePickerEl = document.querySelector("#scope-device-picker");
  deviceCheckboxListEl = document.querySelector("#device-checkbox-list");

  const origin = window.location.origin;
  const apiBase = `${origin}/api/ext/v1`;
  const mcpUrl = `${origin}/mcp`;

  const apiBaseEl = document.querySelector("#api-base-url");
  if (apiBaseEl) apiBaseEl.textContent = apiBase;

  const mcpUrlEl = document.querySelector("#mcp-endpoint-url");
  if (mcpUrlEl) mcpUrlEl.textContent = mcpUrl;

  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        smsinbox: {
          url: mcpUrl,
          headers: {
            Authorization: "Bearer <token>",
          },
        },
      },
    },
    null,
    2,
  );

  const mcpConfigEl = document.querySelector("#mcp-config-sample");
  if (mcpConfigEl) mcpConfigEl.textContent = mcpConfig;

  const curlExample = `curl -H "Authorization: Bearer <token>" "${apiBase}/messages?limit=10"`;
  const curlExampleEl = document.querySelector("#curl-example");
  if (curlExampleEl) curlExampleEl.textContent = curlExample;

  document.querySelector("#copy-base-url")?.addEventListener("click", async (e) => {
    const copied = await flashLabel(e.currentTarget, apiBase, "复制");
    if (copied) toast("已复制 API 地址");
  });

  document.querySelector("#copy-mcp-url")?.addEventListener("click", async (e) => {
    const copied = await flashLabel(e.currentTarget, mcpUrl, "复制");
    if (copied) toast("已复制 MCP 地址");
  });

  document.querySelector("#copy-mcp-config")?.addEventListener("click", async (e) => {
    const copied = await flashLabel(e.currentTarget, mcpConfig, "复制代码");
    if (copied) toast("已复制 MCP 配置");
  });

  document.querySelector("#copy-curl-example")?.addEventListener("click", async (e) => {
    const copied = await flashLabel(e.currentTarget, curlExample, "复制");
    if (copied) toast("已复制 curl 示例");
  });

  document.querySelector("#copy-new-token-btn")?.addEventListener("click", async (e) => {
    const text = tokenPlaintextEl.textContent || "";
    const copied = await flashLabel(e.currentTarget, text, "复制 Token");
    if (copied) toast("Token 已复制到剪贴板");
  });

  renderMcpTools();
  renderApiDocs(apiBase);

  bindTabs();
  const initialTab = location.hash === "#mcp-panel" || location.hash === "#panel-mcp"
    ? "mcp"
    : location.hash === "#permissions-panel" || location.hash === "#panel-permissions"
      ? "permissions"
      : location.hash === "#api-panel" || location.hash === "#panel-docs"
        ? "docs"
        : "tokens";
  switchTab(initialTab);

  document.querySelector("#add-token")?.addEventListener("click", () => {
    switchTab("tokens");
    openCreateModal();
  });
  document.querySelector("#refresh")?.addEventListener("click", loadTokens);
  document.querySelector("#token-dialog-cancel")?.addEventListener("click", closeDialog);
  document.querySelector("#token-result-close")?.addEventListener("click", () => {
    closeDialog();
    loadTokens();
  });

  formEl?.querySelectorAll('input[name="scope_type"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      const isCustom = e.target.value === "custom";
      scopePickerEl.hidden = !isCustom;
    });
  });

  formEl?.addEventListener("submit", handleCreateSubmit);

  void loadTokens();
}

function bindTabs() {
  const tabs = [...document.querySelectorAll("[data-tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      next.focus();
      switchTab(next.dataset.tab);
    });
  }
}

function switchTab(name) {
  for (const tab of document.querySelectorAll("[data-tab]")) {
    const on = tab.dataset.tab === name;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.hidden = panel.dataset.panel !== name;
  }
  // Creating a token only applies to the tokens tab; the button sits in
  // the toolbar beside the tabs and follows the active tab.
  const addToken = document.querySelector("#add-token");
  if (addToken) addToken.hidden = name !== "tokens";
}

registerView("/api-mcp.html", start);

async function loadTokens() {
  showError("");
  const result = await api("/api/v1/api-tokens");
  if (!result.response.ok) {
    showError(result.data?.error || "加载 Token 列表失败");
    return;
  }

  const tokens = result.data?.tokens || [];

  renderTokenList(tokens);
  renderPermissionSummary(tokens);
}

function renderPermissionSummary(tokens) {
  const container = document.querySelector("#permissions-list");
  if (!container) return;

  const counts = Object.create(null);
  for (const token of tokens) {
    for (const perm of token.permissions || []) {
      counts[perm] = (counts[perm] || 0) + 1;
    }
  }

  container.replaceChildren();
  const total = tokens.length || 1;

  for (const perm of PERMISSION_DEFS) {
    const card = document.createElement("article");
    card.className = "record stack permission-card";

    const head = document.createElement("div");
    head.className = "record-head";

    const titleArea = document.createElement("div");
    titleArea.className = "device-title";
    const name = document.createElement("strong");
    name.className = "device-name";
    name.textContent = perm.name;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = `${counts[perm.key] || 0}/${tokens.length} 个 Token`;
    titleArea.append(name, badge);

    const hint = document.createElement("span");
    hint.className = "subtle";
    hint.textContent = `已分配给 ${counts[perm.key] || 0} 个 Token`;
    head.append(titleArea, hint);

    const meta = document.createElement("dl");
    meta.className = "device-facts";

    const idRow = document.createElement("div");
    idRow.innerHTML = `<dt>标识</dt><dd><code>${escapeHtml(perm.key)}</code></dd>`;
    const descRow = document.createElement("div");
    descRow.innerHTML = `<dt>说明</dt><dd>${escapeHtml(perm.description)}</dd>`;
    const readsRow = document.createElement("div");
    readsRow.className = "span-2";
    readsRow.innerHTML = `<dt>能读什么</dt><dd>${escapeHtml(perm.reads)}</dd>`;

    meta.append(idRow, descRow, readsRow);
    card.append(head, meta);
    container.append(card);
  }
}

function renderMcpTools() {
  const list = document.querySelector("#mcp-tools-list");
  if (!list) return;
  list.replaceChildren();

  for (const tool of MCP_TOOLS) {
    const article = document.createElement("article");
    article.className = "record stack tool-card";

    const head = document.createElement("div");
    head.className = "record-head";
    const title = document.createElement("strong");
    title.className = "device-name";
    title.textContent = tool.name;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "ghost";
    copy.textContent = "复制示例";
    const example = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: tool.inputSchema } }, null, 2);
    copy.addEventListener("click", async (event) => {
      const copied = await flashLabel(event.currentTarget, example, "复制示例");
      if (copied) toast(`已复制 ${tool.name} 调用示例`);
    });
    head.append(title, copy);

    const desc = document.createElement("p");
    desc.className = "subtle";
    desc.textContent = tool.description;

    const codeWrap = document.createElement("div");
    codeWrap.className = "code-block compact";
    const pre = document.createElement("pre");
    pre.textContent = example;
    codeWrap.append(pre);

    article.append(head, desc, codeWrap);
    list.append(article);
  }
}

function renderApiDocs(baseUrl) {
  const target = document.querySelector("#api-endpoints-details");
  if (!target) return;
  target.replaceChildren();

  for (const endpoint of API_ENDPOINTS) {
    const card = document.createElement("article");
    card.className = "record stack endpoint-detail";

    const brief = document.createElement("div");
    brief.className = "record-head";
    const methodPill = document.createElement("span");
    methodPill.className = "method";
    methodPill.textContent = endpoint.method;
    const path = document.createElement("code");
    path.className = "endpoint-path";
    path.textContent = endpoint.path;
    brief.append(methodPill, path);

    const summary = document.createElement("p");
    summary.className = "subtle";
    summary.textContent = endpoint.summary;

    const desc = document.createElement("p");
    desc.textContent = endpoint.description;

    const line = document.createElement("div");
    line.className = "device-facts";
    const perm = document.createElement("div");
    perm.innerHTML = `<dt>权限</dt><dd>${escapeHtml(endpoint.permission)}</dd>`;
    const req = document.createElement("div");
    req.className = "span-2";
    req.innerHTML = `<dt>参数</dt><dd>${renderParamList(endpoint.params)}</dd>`;
    line.append(perm, req);

    const requestExample = endpoint.request.replace("${base}", baseUrl);
    const responseExample = endpoint.response;

    const sampleBlock = document.createElement("div");
    sampleBlock.className = "stack";
    const reqHead = document.createElement("h4");
    reqHead.textContent = "请求示例";
    const reqCode = document.createElement("div");
    reqCode.className = "code-block compact";
    const reqPre = document.createElement("pre");
    reqPre.textContent = requestExample;
    reqCode.append(reqPre);

    const resHead = document.createElement("h4");
    resHead.textContent = "返回示例";
    const resCode = document.createElement("div");
    resCode.className = "code-block compact";
    const resPre = document.createElement("pre");
    resPre.textContent = responseExample;
    resCode.append(resPre);

    sampleBlock.append(reqHead, reqCode, resHead, resCode);
    card.append(brief, summary, desc, line, sampleBlock);
    target.append(card);
  }
}

function renderParamList(params) {
  if (!params || params.length === 0) return "无";
  return params.map((param) => {
    const reqLabel = param.required ? "必填" : "可选";
    return `<code>${escapeHtml(param.name)}</code> (${reqLabel}): ${escapeHtml(param.meaning)}`;
  }).join("； ");
}

function renderTokenList(tokens) {
  if (!tokenListEl) return;
  tokenListEl.replaceChildren();

  if (tokens.length === 0) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.style.padding = "24px 0";
    empty.textContent = "还没有创建外部访问 Token。点击右上角「新建 Token」为程序或 AI Agent 创建凭证。";
    tokenListEl.append(empty);
    return;
  }

  for (const token of tokens) {
    const card = document.createElement("article");
    card.className = "record stack";
    card.id = `token-${token.id}`;

    const head = document.createElement("div");
    head.className = "record-head";

    const titleArea = document.createElement("div");
    titleArea.className = "device-title";

    const name = document.createElement("strong");
    name.className = "device-name";
    name.textContent = token.name;

    const statusBadge = document.createElement("span");
    statusBadge.className = `badge ${token.status === "active" ? "ok" : token.status === "disabled" ? "warn" : "danger"}`;
    statusBadge.textContent =
      token.status === "active"
        ? "有效"
        : token.status === "disabled"
          ? "已禁用"
          : token.status === "revoked"
            ? "已撤销"
            : "已过期";

    titleArea.append(name, statusBadge);

    const actions = document.createElement("div");
    actions.className = "actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "ghost";
    renameBtn.type = "button";
    renameBtn.textContent = "改名";
    renameBtn.addEventListener("click", () => startTokenRename(token, titleArea));
    actions.append(renameBtn);

    // Rotation replaces revocation (Roye): same row, fresh secret. It is
    // offered for every token — rotating a revoked one revives it.
    const rotateBtn = document.createElement("button");
    rotateBtn.className = "ghost";
    rotateBtn.type = "button";
    rotateBtn.textContent = "轮换";
    rotateBtn.addEventListener("click", () => rotateToken(token));
    actions.append(rotateBtn);

    // Enable/disable sits right before delete, with the same filled
    // toggle treatment as the notify channel cards (black enables,
    // white disables).
    if (token.status === "active") {
      const disableBtn = document.createElement("button");
      disableBtn.className = "btn-disable";
      disableBtn.type = "button";
      disableBtn.textContent = "禁用";
      disableBtn.addEventListener("click", () => setTokenDisabled(token.id, true));
      actions.append(disableBtn);
    } else if (token.status === "disabled") {
      const enableBtn = document.createElement("button");
      enableBtn.className = "btn-enable";
      enableBtn.type = "button";
      enableBtn.textContent = "启用";
      enableBtn.addEventListener("click", () => setTokenDisabled(token.id, false));
      actions.append(enableBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger ghost";
    deleteBtn.type = "button";
    deleteBtn.textContent = "删除";
    deleteBtn.addEventListener("click", () => deleteToken(token));
    actions.append(deleteBtn);

    head.append(titleArea, actions);

    const facts = document.createElement("dl");
    facts.className = "device-facts";

    const prefixGroup = document.createElement("div");
    if (token.token) {
      const dt = document.createElement("dt");
      dt.textContent = "Token";
      const dd = document.createElement("dd");
      dd.className = "device-id";
      const code = document.createElement("code");
      code.textContent = token.token;
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "secondary";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", async (event) => {
        const copied = await flashLabel(event.currentTarget, token.token, "复制");
        if (copied) toast("已复制 Token");
      });
      dd.append(code, copyBtn);
      prefixGroup.append(dt, dd);
    } else {
      prefixGroup.innerHTML = `<dt>Token 前缀</dt><dd><code>${escapeHtml(token.token_prefix)}</code> <span class="subtle">旧令牌未保存明文，重新创建后可查看完整 Token。</span></dd>`;
    }

    const scopeDesc = !token.device_scope || token.device_scope.length === 0 ? "全部设备" : `${token.device_scope.length} 台指定设备`;
    const scopeGroup = document.createElement("div");
    scopeGroup.innerHTML = `<dt>设备范围</dt><dd>${escapeHtml(scopeDesc)}</dd>`;

    const permsDesc = (token.permissions || []).join(", ") || "无";
    const permsGroup = document.createElement("div");
    permsGroup.className = "span-2";
    permsGroup.innerHTML = `<dt>权限</dt><dd><code style="font-size: var(--fs-xs);">${escapeHtml(permsDesc)}</code></dd>`;

    const createdGroup = document.createElement("div");
    createdGroup.innerHTML = `<dt>创建时间</dt><dd>${formatTime(token.created_at)}</dd>`;

    const usedGroup = document.createElement("div");
    const usedText = token.last_used_at ? formatTime(token.last_used_at) : "从未";
    usedGroup.innerHTML = `<dt>最后使用</dt><dd>${usedText}</dd>`;

    const expiresGroup = document.createElement("div");
    const expireText = token.expires_at ? formatTime(token.expires_at) : "永不过期";
    expiresGroup.innerHTML = `<dt>有效期</dt><dd>${expireText}</dd>`;

    facts.append(prefixGroup, scopeGroup, permsGroup, createdGroup, usedGroup, expiresGroup);
    card.append(head, facts);
    tokenListEl.append(card);
  }
}

async function openCreateModal() {
  if (formErrorEl) formErrorEl.hidden = true;
  formEl.reset();
  formEl.hidden = false;
  resultBoxEl.hidden = true;
  scopePickerEl.hidden = true;

  await ensureDevices();
  const devices = getDevices();
  if (deviceCheckboxListEl) {
    deviceCheckboxListEl.replaceChildren();
    if (devices.length === 0) {
      deviceCheckboxListEl.innerHTML = '<span class="subtle">当前暂无设备，创建后将无法读取任何设备。</span>';
    } else {
      for (const dev of devices) {
        const label = document.createElement("label");
        label.style.display = "flex";
        label.style.alignItems = "center";
        label.style.gap = "8px";
        label.innerHTML = `<input type="checkbox" name="device_scope" value="${escapeHtml(dev.id)}" /> <span>${escapeHtml(dev.name)} (${escapeHtml(dev.platform || "other")})</span>`;
        deviceCheckboxListEl.append(label);
      }
    }
  }

  dialogEl?.showModal();
}

function closeDialog() {
  dialogEl?.close();
}

async function handleCreateSubmit(event) {
  event.preventDefault();
  formErrorEl.hidden = true;

  const formData = new FormData(formEl);
  const name = (formData.get("name") || "").toString().trim();
  if (!name) {
    formErrorEl.textContent = "请填写 Token 名称";
    formErrorEl.hidden = false;
    return;
  }

  const permissions = formData.getAll("permissions").map((p) => p.toString());
  if (permissions.length === 0) {
    formErrorEl.textContent = "请至少勾选一项有效权限";
    formErrorEl.hidden = false;
    return;
  }

  const scopeType = formData.get("scope_type");
  let deviceScope = [];
  if (scopeType === "custom") {
    deviceScope = formData.getAll("device_scope").map((d) => d.toString());
    if (deviceScope.length === 0) {
      formErrorEl.textContent = "请勾选至少一台指定设备，或选择全部设备";
      formErrorEl.hidden = false;
      return;
    }
  }

  const expiresInDays = parseInt((formData.get("expires_in_days") || "0").toString(), 10);

  const payload = {
    name,
    permissions,
    device_scope: deviceScope,
    expires_in_days: expiresInDays > 0 ? expiresInDays : null,
  };

  const result = await api("/api/v1/api-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!result.response.ok) {
    formErrorEl.textContent = result.data?.error || "创建 Token 失败";
    formErrorEl.hidden = false;
    return;
  }

  const tokenPlaintext = result.data?.token || "";
  formEl.hidden = true;
  resultBoxEl.hidden = false;
  tokenPlaintextEl.textContent = tokenPlaintext;
}

async function setTokenDisabled(tokenId, disabled) {
  const action = disabled ? "disable" : "enable";
  const result = await api(`/api/v1/api-tokens/${encodeURIComponent(tokenId)}/${action}`, {
    method: "POST",
  });
  if (!result.response.ok) {
    showError(result.data?.error || `操作失败`);
    return;
  }
  toast(disabled ? "Token 已禁用" : "Token 已启用");
  await loadTokens();
}

function startTokenRename(token, titleArea) {
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 64;
  input.value = token.name;
  input.setAttribute("aria-label", "Token 名称");
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "保存";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => loadTokens());
  save.addEventListener("click", async () => {
    const next = input.value.trim();
    if (!next) {
      showError("Token 名称不能为空");
      input.focus();
      return;
    }
    if (next === token.name) {
      await loadTokens();
      return;
    }
    save.disabled = true;
    const result = await api(`/api/v1/api-tokens/${encodeURIComponent(token.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: next }),
    });
    if (!result.response.ok) {
      showError(result.data?.error || "改名失败");
      save.disabled = false;
      return;
    }
    toast("Token 已改名");
    await loadTokens();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save.click();
    }
    if (event.key === "Escape") loadTokens();
  });
  titleArea.replaceChildren(input, save, cancel);
  input.focus();
  input.select();
}

async function rotateToken(token) {
  const confirmed = await openModal({
    title: "轮换 Token",
    body: `确定要轮换 "${token.name}" 吗？轮换后会生成新的 Token 值，旧值立即失效；名称、权限和设备范围不变。`,
    confirmLabel: "轮换",
    danger: true,
  });
  if (!confirmed) return;

  const result = await api(`/api/v1/api-tokens/${encodeURIComponent(token.id)}/rotate`, {
    method: "POST",
  });
  if (!result.response.ok) {
    showError(result.data?.error || "轮换失败");
    return;
  }
  toast("Token 已轮换，新值已生效");
  await loadTokens();
}

async function deleteToken(token) {
  const confirmed = await openModal({
    title: "删除 Token",
    body: `确定要删除 "${token.name}" 吗？此操作无法撤销。`,
    confirmLabel: "删除",
    danger: true,
  });
  if (!confirmed) return;

  const result = await api(`/api/v1/api-tokens/${encodeURIComponent(token.id)}`, {
    method: "DELETE",
  });
  if (!result.response.ok) {
    showError(result.data?.error || "删除失败");
    return;
  }
  toast("Token 已删除");
  await loadTokens();
}

function showError(msg) {
  showNotice(pageErrorEl, msg);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[m] || m));
}
