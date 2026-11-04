import { t } from "./i18n.js";
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
    name: () => t("api.permMessagesName"),
    description: () => t("api.permMessagesDesc"),
    reads: () => t("api.permMessagesReads"),
  },
  {
    key: "otp:read",
    name: () => t("api.permOtpName"),
    description: () => t("api.permOtpDesc"),
    reads: () => t("api.permOtpReads"),
  },
  {
    key: "devices:read",
    name: () => t("api.permDevicesName"),
    description: () => t("api.permDevicesDesc"),
    reads: () => t("api.permDevicesReads"),
  },
  {
    key: "devices:status",
    name: () => t("api.permStatusName"),
    description: () => t("api.permStatusDesc"),
    reads: () => t("api.permStatusReads"),
  },
];

const MCP_TOOLS = [
  {
    name: "list_messages",
    description: () => t("api.toolListMessages"),
    inputSchema: { limit: 10, offset: 0, device_id: "<device uuid>", since: 1710000000000 },
  },
  {
    name: "search_messages",
    description: () => t("api.toolSearchMessages"),
    inputSchema: { q: "验证码", from: "10086", limit: 10, offset: 0 },
  },
  {
    name: "get_message",
    description: () => t("api.toolGetMessage"),
    inputSchema: { id: "<message uuid>" },
  },
  {
    name: "get_latest_otp",
    description: () => t("api.toolLatestOtp"),
    inputSchema: { device_id: "<device uuid>", from: "10086" },
  },
  {
    name: "search_otp",
    description: () => t("api.toolSearchOtp"),
    inputSchema: { device_id: "<device uuid>", since: 1710000000000, until: 1710003600000 },
  },
  {
    name: "list_devices",
    description: () => t("api.toolListDevices"),
    inputSchema: {},
  },
  {
    name: "get_device_status",
    description: () => t("api.toolDeviceStatus"),
    inputSchema: { id: "<device uuid>" },
  },
];

const API_ENDPOINTS = [
  {
    method: "GET",
    path: "/health",
    summary: () => t("api.healthSummary"),
    description: () => t("api.healthDesc"),
    permission: () => t("api.permTokenOnly"),
    params: [],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/health\"",
    response: JSON.stringify({ ok: true, data: { status: "ok", version: "1.2.3", time: 1710000000000 } }, null, 2),
  },
  {
    method: "GET",
    path: "/me",
    summary: () => t("api.meSummary"),
    description: () => t("api.meDesc"),
    permission: () => t("api.permValidToken"),
    params: [],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/me\"",
    response: JSON.stringify({ ok: true, data: { id: "<token-id>", name: "Cursor Agent", permissions: ["messages:read", "otp:read"], device_scope: [], expires_at: 1710000000000 } }, null, 2),
  },
  {
    method: "GET",
    path: "/messages",
    summary: () => t("api.messagesSummary"),
    description: () => t("api.messagesDesc"),
    permission: () => "messages:read",
    params: [
      { name: "limit", required: false, meaning: () => t("api.paramLimit") },
      { name: "offset", required: false, meaning: () => t("api.paramOffset") },
      { name: "device_id", required: false, meaning: () => t("api.paramDeviceId") },
      { name: "from", required: false, meaning: () => t("api.paramFromName") },
      { name: "since", required: false, meaning: () => t("api.paramSinceMessages") },
      { name: "until", required: false, meaning: () => t("api.paramUntilMessages") },
      { name: "q", required: false, meaning: () => t("api.paramQuery") },
    ],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/messages?limit=2&device_id=<device-id>&q=验证码\"",
    response: JSON.stringify({ ok: true, data: [{ id: "<message-id>", device_id: "<device-id>", device_name: "Device Alpha", from: "10086", from_number: "10086", to: "13800000000", to_number: "13800000000", content: "【中国移动】您的验证码是 889900，请勿泄露给他人。", code: "889900", received_at: 1710000000000, created_at: 1710000000000 }], page: { limit: 2, offset: 0, total: 1 } }, null, 2),
  },
  {
    method: "GET",
    path: "/messages/{id}",
    summary: () => t("api.messageSummary"),
    description: () => t("api.messageDesc"),
    permission: () => "messages:read",
    params: [
      { name: "id", required: true, meaning: () => t("api.paramMessageId") },
    ],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/messages/<message-id>\"",
    response: JSON.stringify({ ok: true, data: { id: "<message-id>", device_id: "<device-id>", device_name: "Device Alpha", from: "10086", from_number: "10086", to: "13800000000", to_number: "13800000000", content: "【中国移动】您的验证码是 889900，请勿泄露给他人。", code: "889900", received_at: 1710000000000, created_at: 1710000000000 } }, null, 2),
  },
  {
    method: "GET",
    path: "/otp/latest",
    summary: () => t("api.otpLatestSummary"),
    description: () => t("api.otpLatestDesc"),
    permission: () => "otp:read",
    params: [
      { name: "device_id", required: false, meaning: () => t("api.paramDeviceId") },
      { name: "from", required: false, meaning: () => t("api.paramFrom") },
      { name: "since", required: false, meaning: () => t("api.paramSinceOtp") },
    ],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/otp/latest?device_id=<device-id>\"",
    response: JSON.stringify({ ok: true, data: { id: "<message-id>", code: "889900", from: "10086", content: "【中国移动】您的验证码是 889900，请勿泄露给他人。", device_id: "<device-id>", device_name: "Device Alpha", received_at: 1710000000000, code_source: "regex", code_status: "recognized" } }, null, 2),
  },
  {
    method: "GET",
    path: "/otp/search",
    summary: () => t("api.otpSearchSummary"),
    description: () => t("api.otpSearchDesc"),
    permission: () => "otp:read",
    params: [
      { name: "limit", required: false, meaning: () => t("api.paramLimit") },
      { name: "offset", required: false, meaning: () => t("api.paramOffset") },
      { name: "device_id", required: false, meaning: () => t("api.paramDeviceId") },
      { name: "from", required: false, meaning: () => t("api.paramFrom") },
      { name: "since", required: false, meaning: () => t("api.paramSinceMs") },
      { name: "until", required: false, meaning: () => t("api.paramUntilMs") },
    ],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/otp/search?limit=20&since=1710000000000\"",
    response: JSON.stringify({ ok: true, data: [{ id: "<message-id>", code: "889900", from: "10086", content: "【中国移动】您的验证码是 889900，请勿泄露给他人。", device_id: "<device-id>", device_name: "Device Alpha", received_at: 1710000000000, code_source: "regex", code_status: "recognized" }], page: { limit: 20, offset: 0, total: 1 } }, null, 2),
  },
  {
    method: "GET",
    path: "/devices",
    summary: () => t("api.devicesSummary"),
    description: () => t("api.devicesDesc"),
    permission: () => "devices:read",
    params: [],
    request: "curl -H \"Authorization: Bearer <token>\" \"${base}/devices\"",
    response: JSON.stringify({ ok: true, data: [{ id: "<device-id>", name: "Device Alpha", platform: "ios", created_at: 1700000000000, last_seen_at: 1710000000000, status: "online" }] }, null, 2),
  },
  {
    method: "GET",
    path: "/devices/{id}/status",
    summary: () => t("api.deviceStatusSummary"),
    description: () => t("api.deviceStatusDesc"),
    permission: () => "devices:status",
    params: [
      { name: "id", required: true, meaning: () => t("api.paramDeviceUuid") },
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
let expiresSelect = null;
let loadedTokens = null;
let bannerErrorKey = "";

function expiresOptions() {
  return [
    { value: "0", label: t("api.expiresNever") },
    { value: "30", label: t("api.expires30") },
    { value: "90", label: t("api.expires90") },
    { value: "365", label: t("api.expires365") },
  ];
}

export function start() {
  const expiresSlot = document.querySelector("#token-expires");
  if (expiresSlot) {
    const field = mountSelect({
      name: "expires_in_days",
      value: "0",
      options: expiresOptions(),
      ariaLabel: t("api.expires"),
    });
    expiresSelect = field;
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
    const copied = await flashLabel(e.currentTarget, apiBase, t("common.copy"));
    if (copied) toast(t("api.copiedApiBase"));
  });

  document.querySelector("#copy-mcp-url")?.addEventListener("click", async (e) => {
    const copied = await flashLabel(e.currentTarget, mcpUrl, t("common.copy"));
    if (copied) toast(t("api.copiedMcpUrl"));
  });

  document.querySelector("#copy-mcp-config")?.addEventListener("click", async (e) => {
    const copied = await flashLabel(e.currentTarget, mcpConfig, t("api.copyCode"));
    if (copied) toast(t("api.copiedMcpConfig"));
  });

  document.querySelector("#copy-curl-example")?.addEventListener("click", async (e) => {
    const copied = await flashLabel(e.currentTarget, curlExample, t("common.copy"));
    if (copied) toast(t("api.copiedCurl"));
  });

  document.querySelector("#copy-new-token-btn")?.addEventListener("click", async (e) => {
    const text = tokenPlaintextEl.textContent || "";
    const copied = await flashLabel(e.currentTarget, text, t("api.copyToken"));
    if (copied) toast(t("api.tokenCopied"));
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

  const onLocale = () => {
    if (expiresSelect) {
      expiresSelect.setOptions(expiresOptions());
      expiresSelect.root.querySelector("button")?.setAttribute("aria-label", t("api.expires"));
    }
    renderMcpTools();
    renderApiDocs(`${window.location.origin}/api/ext/v1`);
    if (loadedTokens) {
      renderTokenList(loadedTokens);
      renderPermissionSummary(loadedTokens);
    }
    if (bannerErrorKey) showErrorKey(bannerErrorKey);
    if (dialogEl?.open) closeDialog();
  };
  document.addEventListener("smsinbox:locale", onLocale);
  initShell();
  void loadTokens();
  return () => {
    document.removeEventListener("smsinbox:locale", onLocale);
  };
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
    if (result.data?.error) showError(result.data.error);
    else showErrorKey("api.loadFailed");
    return;
  }

  const tokens = result.data?.tokens || [];
  loadedTokens = tokens;

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

  for (const perm of PERMISSION_DEFS) {
    const card = document.createElement("article");
    card.className = "record stack permission-card";

    const head = document.createElement("div");
    head.className = "record-head";

    const titleArea = document.createElement("div");
    titleArea.className = "device-title";
    const name = document.createElement("strong");
    name.className = "device-name";
    name.textContent = perm.name();
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = t("api.tokenCount", { count: counts[perm.key] || 0, total: tokens.length });
    titleArea.append(name, badge);

    const hint = document.createElement("span");
    hint.className = "subtle";
    hint.textContent = t("api.assignedTo", { n: counts[perm.key] || 0 });
    head.append(titleArea, hint);

    const meta = document.createElement("dl");
    meta.className = "device-facts";

    const idRow = document.createElement("div");
    idRow.innerHTML = `<dt>${escapeHtml(t("api.identifier"))}</dt><dd><code>${escapeHtml(perm.key)}</code></dd>`;
    const descRow = document.createElement("div");
    descRow.innerHTML = `<dt>${escapeHtml(t("api.description"))}</dt><dd>${escapeHtml(perm.description())}</dd>`;
    const readsRow = document.createElement("div");
    readsRow.className = "span-2";
    readsRow.innerHTML = `<dt>${escapeHtml(t("api.readsWhat"))}</dt><dd>${escapeHtml(perm.reads())}</dd>`;

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
    copy.textContent = t("api.copyExample");
    const example = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: tool.inputSchema } }, null, 2);
    copy.addEventListener("click", async (event) => {
      const copied = await flashLabel(event.currentTarget, example, t("api.copyExample"));
      if (copied) toast(t("api.copiedToolExample", { name: tool.name }));
    });
    head.append(title, copy);

    const desc = document.createElement("p");
    desc.className = "subtle";
    desc.textContent = tool.description();

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
    summary.textContent = endpoint.summary();

    const desc = document.createElement("p");
    desc.textContent = endpoint.description();

    const line = document.createElement("div");
    line.className = "device-facts";
    const perm = document.createElement("div");
    perm.innerHTML = `<dt>${escapeHtml(t("api.permission"))}</dt><dd>${escapeHtml(endpoint.permission())}</dd>`;
    const req = document.createElement("div");
    req.className = "span-2";
    req.innerHTML = `<dt>${escapeHtml(t("api.params"))}</dt><dd>${renderParamList(endpoint.params)}</dd>`;
    line.append(perm, req);

    const requestExample = endpoint.request.replace("${base}", baseUrl);
    const responseExample = endpoint.response;

    const sampleBlock = document.createElement("div");
    sampleBlock.className = "stack";
    const reqHead = document.createElement("h4");
    reqHead.textContent = t("api.requestSample");
    const reqCode = document.createElement("div");
    reqCode.className = "code-block compact";
    const reqPre = document.createElement("pre");
    reqPre.textContent = requestExample;
    reqCode.append(reqPre);

    const resHead = document.createElement("h4");
    resHead.textContent = t("api.responseSample");
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
  if (!params || params.length === 0) return escapeHtml(t("api.none"));
  return params.map((param) => {
    const reqLabel = param.required ? t("api.required") : t("api.optional");
    const meaning = typeof param.meaning === "function" ? param.meaning() : param.meaning;
    return `<code>${escapeHtml(param.name)}</code> (${escapeHtml(reqLabel)}): ${escapeHtml(meaning)}`;
  }).join(t("api.paramJoiner"));
}

function renderTokenList(tokens) {
  if (!tokenListEl) return;
  tokenListEl.replaceChildren();

  if (tokens.length === 0) {
    const empty = document.createElement("p");
    empty.className = "subtle";
    empty.style.padding = "24px 0";
    empty.textContent = t("api.emptyTokens");
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
    statusBadge.textContent = tokenStatusLabel(token.status);

    titleArea.append(name, statusBadge);

    const actions = document.createElement("div");
    actions.className = "actions";

    const renameBtn = document.createElement("button");
    renameBtn.className = "ghost";
    renameBtn.type = "button";
    renameBtn.textContent = t("api.rename");
    renameBtn.addEventListener("click", () => startTokenRename(token, titleArea));
    actions.append(renameBtn);

    // Rotation replaces revocation (Roye): same row, fresh secret. It is
    // offered for every token — rotating a revoked one revives it.
    const rotateBtn = document.createElement("button");
    rotateBtn.className = "ghost";
    rotateBtn.type = "button";
    rotateBtn.textContent = t("api.rotate");
    rotateBtn.addEventListener("click", () => rotateToken(token));
    actions.append(rotateBtn);

    // Enable/disable sits right before delete, with the same filled
    // toggle treatment as the notify channel cards (black enables,
    // white disables).
    if (token.status === "active") {
      const disableBtn = document.createElement("button");
      disableBtn.className = "btn-disable";
      disableBtn.type = "button";
      disableBtn.textContent = t("notify.disable");
      disableBtn.addEventListener("click", () => setTokenDisabled(token.id, true));
      actions.append(disableBtn);
    } else if (token.status === "disabled") {
      const enableBtn = document.createElement("button");
      enableBtn.className = "btn-enable";
      enableBtn.type = "button";
      enableBtn.textContent = t("notify.enable");
      enableBtn.addEventListener("click", () => setTokenDisabled(token.id, false));
      actions.append(enableBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger ghost";
    deleteBtn.type = "button";
    deleteBtn.textContent = t("common.delete");
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
      copyBtn.textContent = t("common.copy");
      copyBtn.addEventListener("click", async (event) => {
        const copied = await flashLabel(event.currentTarget, token.token, t("common.copy"));
        if (copied) toast(t("api.copiedToken"));
      });
      dd.append(code, copyBtn);
      prefixGroup.append(dt, dd);
    } else {
      prefixGroup.innerHTML = `<dt>${escapeHtml(t("api.tokenPrefix"))}</dt><dd><code>${escapeHtml(token.token_prefix)}</code> <span class="subtle">${escapeHtml(t("api.legacyToken"))}</span></dd>`;
    }

    const scopeDesc = !token.device_scope || token.device_scope.length === 0
      ? t("api.scopeAllShort")
      : t("api.scopeCount", { n: token.device_scope.length });
    const scopeGroup = document.createElement("div");
    scopeGroup.innerHTML = `<dt>${escapeHtml(t("api.deviceScopeLabel"))}</dt><dd>${escapeHtml(scopeDesc)}</dd>`;

    const permsDesc = (token.permissions || []).join(", ") || t("api.none");
    const permsGroup = document.createElement("div");
    permsGroup.className = "span-2";
    permsGroup.innerHTML = `<dt>${escapeHtml(t("api.permission"))}</dt><dd><code style="font-size: var(--fs-xs);">${escapeHtml(permsDesc)}</code></dd>`;

    const createdGroup = document.createElement("div");
    createdGroup.innerHTML = `<dt>${escapeHtml(t("api.createdAt"))}</dt><dd>${formatTime(token.created_at)}</dd>`;

    const usedGroup = document.createElement("div");
    const usedText = token.last_used_at ? formatTime(token.last_used_at) : t("api.never");
    usedGroup.innerHTML = `<dt>${escapeHtml(t("api.lastUsed"))}</dt><dd>${escapeHtml(usedText)}</dd>`;

    const expiresGroup = document.createElement("div");
    const expireText = token.expires_at ? formatTime(token.expires_at) : t("api.expiresNever");
    expiresGroup.innerHTML = `<dt>${escapeHtml(t("api.expires"))}</dt><dd>${escapeHtml(expireText)}</dd>`;

    facts.append(prefixGroup, scopeGroup, permsGroup, createdGroup, usedGroup, expiresGroup);
    card.append(head, facts);
    tokenListEl.append(card);
  }
}

function tokenStatusLabel(status) {
  if (status === "active") return t("api.statusActive");
  if (status === "disabled") return t("api.statusDisabled");
  if (status === "revoked") return t("api.statusRevoked");
  return t("api.statusExpired");
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
      deviceCheckboxListEl.innerHTML = `<span class="subtle">${escapeHtml(t("api.noDevices"))}</span>`;
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
    formErrorEl.textContent = t("api.nameRequired");
    formErrorEl.hidden = false;
    return;
  }

  const permissions = formData.getAll("permissions").map((p) => p.toString());
  if (permissions.length === 0) {
    formErrorEl.textContent = t("api.permRequired");
    formErrorEl.hidden = false;
    return;
  }

  const scopeType = formData.get("scope_type");
  let deviceScope = [];
  if (scopeType === "custom") {
    deviceScope = formData.getAll("device_scope").map((d) => d.toString());
    if (deviceScope.length === 0) {
      formErrorEl.textContent = t("api.deviceRequired");
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
    formErrorEl.textContent = result.data?.error || t("api.createFailed");
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
    if (result.data?.error) showError(result.data.error);
    else showErrorKey("api.actionFailed");
    return;
  }
  toast(disabled ? t("api.tokenDisabled") : t("api.tokenEnabled"));
  await loadTokens();
}

function startTokenRename(token, titleArea) {
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 64;
  input.value = token.name;
  input.setAttribute("aria-label", t("api.tokenName"));
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = t("common.save");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = t("common.cancel");
  cancel.addEventListener("click", () => loadTokens());
  save.addEventListener("click", async () => {
    const next = input.value.trim();
    if (!next) {
      showErrorKey("api.nameEmpty");
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
      if (result.data?.error) showError(result.data.error);
      else showErrorKey("api.renameFailed");
      save.disabled = false;
      return;
    }
    toast(t("api.renamed"));
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
    title: t("api.rotateTitle"),
    body: t("api.rotateBody", { name: token.name }),
    confirmLabel: t("api.rotate"),
    danger: true,
  });
  if (!confirmed) return;

  const result = await api(`/api/v1/api-tokens/${encodeURIComponent(token.id)}/rotate`, {
    method: "POST",
  });
  if (!result.response.ok) {
    if (result.data?.error) showError(result.data.error);
    else showErrorKey("api.rotateFailed");
    return;
  }
  toast(t("api.rotated"));
  await loadTokens();
}

async function deleteToken(token) {
  const confirmed = await openModal({
    title: t("api.deleteTitle"),
    body: t("api.deleteBody", { name: token.name }),
    confirmLabel: t("common.delete"),
    danger: true,
  });
  if (!confirmed) return;

  const result = await api(`/api/v1/api-tokens/${encodeURIComponent(token.id)}`, {
    method: "DELETE",
  });
  if (!result.response.ok) {
    if (result.data?.error) showError(result.data.error);
    else showErrorKey("notify.deleteFailed");
    return;
  }
  toast(t("api.deleted"));
  await loadTokens();
}

function showError(msg) {
  bannerErrorKey = "";
  showNotice(pageErrorEl, msg);
}

function showErrorKey(key) {
  bannerErrorKey = key || "";
  showNotice(pageErrorEl, errorKeyText(key));
}

function errorKeyText(key) {
  if (key === "api.loadFailed") return t("api.loadFailed");
  if (key === "api.actionFailed") return t("api.actionFailed");
  if (key === "api.nameEmpty") return t("api.nameEmpty");
  if (key === "api.renameFailed") return t("api.renameFailed");
  if (key === "api.rotateFailed") return t("api.rotateFailed");
  if (key === "notify.deleteFailed") return t("notify.deleteFailed");
  return "";
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
