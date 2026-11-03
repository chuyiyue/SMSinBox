import {
  api,
  flashLabel,
  formatTime,
  initShell,
  openModal,
  toast,
} from "./common.js";
import { ensureDevices, getDevices } from "./device-store.js";
import { registerView } from "./shell.js";

let tokenListEl;
let tokenCountEl;
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

  tokenListEl = document.querySelector("#token-list");
  tokenCountEl = document.querySelector("#token-count");
  pageErrorEl = document.querySelector("#page-error");
  pageStatusEl = document.querySelector("#page-status");
  dialogEl = document.querySelector("#token-dialog");
  formEl = document.querySelector("#token-form");
  formErrorEl = document.querySelector("#token-form-error");
  resultBoxEl = document.querySelector("#token-result-box");
  tokenPlaintextEl = document.querySelector("#new-token-plaintext");
  scopePickerEl = document.querySelector("#scope-device-picker");
  deviceCheckboxListEl = document.querySelector("#device-checkbox-list");

  // Populate URLs and samples
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
            Authorization: "Bearer smsx_YOUR_TOKEN_HERE",
          },
        },
      },
    },
    null,
    2,
  );

  const mcpConfigEl = document.querySelector("#mcp-config-sample");
  if (mcpConfigEl) mcpConfigEl.textContent = mcpConfig;

  const curlExample = `curl -H "Authorization: Bearer smsx_YOUR_TOKEN_HERE" \\\n  "${apiBase}/messages?limit=10"`;
  const curlExampleEl = document.querySelector("#curl-example");
  if (curlExampleEl) curlExampleEl.textContent = curlExample;

  // Copy buttons
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

  // Modal open & close
  document.querySelector("#add-token")?.addEventListener("click", openCreateModal);
  document.querySelector("#refresh")?.addEventListener("click", loadTokens);
  document.querySelector("#token-dialog-cancel")?.addEventListener("click", closeDialog);
  document.querySelector("#token-result-close")?.addEventListener("click", () => {
    closeDialog();
    loadTokens();
  });

  // Scope radio toggle
  formEl?.querySelectorAll('input[name="scope_type"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      const isCustom = (e.target).value === "custom";
      scopePickerEl.hidden = !isCustom;
    });
  });

  formEl?.addEventListener("submit", handleCreateSubmit);

  void loadTokens();
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
  if (tokenCountEl) tokenCountEl.textContent = String(tokens.length);
  renderTokenList(tokens);
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

    // Header
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

    if (token.status === "active") {
      const disableBtn = document.createElement("button");
      disableBtn.className = "ghost";
      disableBtn.type = "button";
      disableBtn.textContent = "禁用";
      disableBtn.addEventListener("click", () => setTokenDisabled(token.id, true));
      actions.append(disableBtn);
    } else if (token.status === "disabled") {
      const enableBtn = document.createElement("button");
      enableBtn.className = "ghost";
      enableBtn.type = "button";
      enableBtn.textContent = "启用";
      enableBtn.addEventListener("click", () => setTokenDisabled(token.id, false));
      actions.append(enableBtn);
    }

    if (token.status !== "revoked") {
      const revokeBtn = document.createElement("button");
      revokeBtn.className = "danger ghost";
      revokeBtn.type = "button";
      revokeBtn.textContent = "撤销";
      revokeBtn.addEventListener("click", () => revokeToken(token));
      actions.append(revokeBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger ghost";
    deleteBtn.type = "button";
    deleteBtn.textContent = "删除";
    deleteBtn.addEventListener("click", () => deleteToken(token));
    actions.append(deleteBtn);

    head.append(titleArea, actions);

    // Facts
    const facts = document.createElement("dl");
    facts.className = "device-facts";

    const prefixGroup = document.createElement("div");
    prefixGroup.innerHTML = `<dt>Token 前缀</dt><dd><code>${escapeHtml(token.token_prefix)}</code></dd>`;

    const scopeDesc =
      !token.device_scope || token.device_scope.length === 0
        ? "全部设备"
        : `${token.device_scope.length} 台指定设备`;
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

  // Populate devices for scope
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

async function revokeToken(token) {
  const confirmed = await openModal({
    title: "撤销 Token",
    body: `确定要撤销 "${token.name}" 吗？撤销后，该 Token 的后续请求将立即失败，且无法重新启用。`,
    confirmLabel: "撤销凭证",
    danger: true,
  });
  if (!confirmed) return;

  const result = await api(`/api/v1/api-tokens/${encodeURIComponent(token.id)}/revoke`, {
    method: "POST",
  });
  if (!result.response.ok) {
    showError(result.data?.error || "撤销失败");
    return;
  }
  toast("Token 已撤销");
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
  if (!pageErrorEl) return;
  pageErrorEl.textContent = msg;
  pageErrorEl.hidden = !msg;
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
