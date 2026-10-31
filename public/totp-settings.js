import { api, copyText, formatTime, isUnauthorized, showNotice, toast } from "./common.js";

// Minimal two-factor settings card for /users.html. The full four-zone system
// page arrives in a later batch; this only wires the TOTP API.
const PANEL = "#totp-panel";
const DIALOG_ID = "totp-dialog";

export function initTotpSettings() {
  const panel = document.querySelector(PANEL);
  if (!panel) return () => {};

  const stateLine = panel.querySelector("#totp-state");
  const extraLine = panel.querySelector("#totp-extra");
  const errorBox = panel.querySelector("#totp-error");
  const okBox = panel.querySelector("#totp-ok");
  const actions = panel.querySelector("#totp-actions");

  let disposed = false;
  let status = null;
  let dialog = null;
  let mode = "enable";
  let busy = false;
  let currentSecret = "";

  const setError = (message) => showNotice(errorBox, message);
  const setOk = (message) => showNotice(okBox, message);

  async function load() {
    try {
      const result = await api("/api/v1/auth/totp");
      if (disposed) return;
      if (!result.response.ok) {
        setError(result.data.error || "读取两步验证状态失败");
        return;
      }
      status = result.data;
      render();
    } catch (error) {
      if (disposed || isUnauthorized(error)) return;
      setError("读取两步验证状态失败");
    }
  }

  function render() {
    actions.replaceChildren();
    extraLine.textContent = "";
    extraLine.className = "subtle";
    if (!status) return;
    if (status.enabled) {
      const since = Number(status.enabled_at);
      stateLine.textContent = Number.isFinite(since) && since > 0
        ? `已启用，${formatTime(since)}开始生效。登录时需要验证器上的 6 位码或一个恢复码。`
        : "已启用。登录时需要验证器上的 6 位码或一个恢复码。";
      const remaining = Number(status.recovery_codes_remaining) || 0;
      if (remaining > 0) {
        extraLine.textContent = `剩余恢复码 ${remaining} 个，每个只能用一次。`;
      } else {
        extraLine.textContent = "恢复码已用完，请重新生成，或关闭两步验证后重新绑定。";
        extraLine.className = "callout warn";
      }
      actions.append(button("重新生成恢复码", "recovery", "secondary"));
      actions.append(button("关闭两步验证", "disable", "secondary"));
      return;
    }
    stateLine.textContent = status.pending
      ? "上一次绑定还没确认，请重新开始并输入验证器上的验证码。"
      : "未启用。启用后，登录还需要验证器上的一次性验证码。";
    if (status.pending && Number(status.pending_expires_at) > Date.now()) {
      extraLine.textContent = `待确认的绑定会在 ${formatTime(Number(status.pending_expires_at))} 过期。`;
    }
    actions.append(button(status.pending ? "重新开始绑定" : "启用两步验证", "enable", "primary"));
  }

  function button(label, action, variant) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = variant || "primary";
    node.dataset.totpAction = action;
    node.textContent = label;
    return node;
  }

  async function beginEnable() {
    setError("");
    setOk("");
    if (!dialog) buildDialog();
    const enableButton = actions.querySelector('[data-totp-action="enable"]');
    if (enableButton) enableButton.disabled = true;
    try {
      const result = await api("/api/v1/auth/totp/setup", { method: "POST", body: "{}" });
      if (disposed) return;
      if (!result.response.ok) {
        setError(result.data.error || "无法开始绑定");
        return;
      }
      openDialog("enable", {
        secret: String(result.data.secret || ""),
        uri: String(result.data.otpauth_uri || ""),
      });
    } catch (error) {
      if (disposed || isUnauthorized(error)) return;
      setError("无法开始绑定，请重试");
    } finally {
      if (enableButton) enableButton.disabled = false;
    }
  }

  function openDialog(nextMode, data = {}) {
    if (!dialog) buildDialog();
    mode = nextMode;
    const elements = dialogElements();
    elements.error.hidden = true;
    elements.codesBlock.hidden = true;
    elements.secretBlock.hidden = nextMode !== "enable";
    elements.passwordField.hidden = nextMode === "enable";
    elements.codeField.hidden = false;
    elements.password.value = "";
    elements.code.value = "";
    elements.code.disabled = false;
    elements.submit.disabled = false;
    currentSecret = nextMode === "enable" ? String(data.secret || "") : "";
    if (nextMode === "enable") {
      elements.title.textContent = "启用两步验证";
      elements.text.textContent =
        "在身份验证器里添加账户，然后输入它显示的 6 位验证码。若无法扫码，请手动输入下面的密钥。";
      elements.secret.textContent = groupSecret(data.secret || "");
      elements.uri.textContent = data.uri || "";
      elements.submit.textContent = "确认启用";
    } else if (nextMode === "disable") {
      elements.title.textContent = "关闭两步验证";
      elements.text.textContent = "需要当前密码，再加一个验证器验证码或未使用的恢复码。";
      elements.submit.textContent = "关闭两步验证";
    } else {
      elements.title.textContent = "重新生成恢复码";
      elements.text.textContent = "需要当前密码，再加一个验证器验证码或未使用的恢复码。旧恢复码会立即作废。";
      elements.submit.textContent = "生成新的恢复码";
    }
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("modal-open");
    if (nextMode === "enable") elements.code.focus();
    else elements.password.focus();
  }

  function showCodes(codes) {
    const elements = dialogElements();
    mode = "done";
    elements.title.textContent = "保存恢复码";
    elements.text.textContent = "每个恢复码只能使用一次。关闭后无法再次查看。";
    elements.secretBlock.hidden = true;
    elements.codeField.hidden = true;
    elements.passwordField.hidden = true;
    elements.codesBlock.hidden = false;
    elements.codes.textContent = codes.join("\n");
    elements.submit.disabled = false;
    elements.submit.textContent = "我已保存，关闭";
    setOk("两步验证设置已更新。");
    elements.submit.focus();
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const elements = dialogElements();
    elements.error.hidden = true;
    if (mode === "done") {
      closeDialog();
      return;
    }
    const code = elements.code.value.trim();
    if (!code) return showDialogError(elements, "请输入验证码或恢复码");
    const passwordValue = elements.password.value;
    if (mode !== "enable" && !passwordValue) return showDialogError(elements, "请填写当前密码");

    const path = mode === "enable"
      ? "/api/v1/auth/totp/enable"
      : mode === "disable"
        ? "/api/v1/auth/totp/disable"
        : "/api/v1/auth/totp/recovery";
    const body = mode === "enable" ? { code } : { password: passwordValue, code };
    setBusy(true);
    try {
      const result = await api(path, { method: "POST", body: JSON.stringify(body), allowUnauthorized: true });
      if (disposed || !dialog?.open) return;
      if (!result.response.ok) {
        showDialogError(elements, result.data.error || "操作失败");
        return;
      }
      if (mode === "disable") {
        closeDialog();
        toast("两步验证已关闭");
        await load();
        return;
      }
      showCodes(Array.isArray(result.data.recovery_codes) ? result.data.recovery_codes.map(String) : []);
      await load();
    } catch (error) {
      if (disposed || isUnauthorized(error)) return;
      showDialogError(elements, "网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  function setBusy(next) {
    busy = next;
    if (!dialog) return;
    const elements = dialogElements();
    elements.submit.disabled = next;
    elements.submit.textContent = next ? "处理中…" : currentSubmitLabel();
  }

  function currentSubmitLabel() {
    if (mode === "enable") return "确认启用";
    if (mode === "disable") return "关闭两步验证";
    if (mode === "recovery") return "生成新的恢复码";
    return "我已保存，关闭";
  }

  function showDialogError(elements, message) {
    elements.error.textContent = message;
    elements.error.hidden = false;
  }

  function closeDialog() {
    if (dialog?.open) dialog.close();
    document.body.classList.remove("modal-open");
    busy = false;
  }

  function buildDialog() {
    dialog = document.createElement("dialog");
    dialog.id = DIALOG_ID;
    dialog.className = "modal";
    dialog.innerHTML = `
      <form class="modal-card stack" novalidate>
        <h2 data-totp="title">启用两步验证</h2>
        <p class="subtle" data-totp="text"></p>
        <div class="stack" data-totp="secret-block" hidden>
          <p class="subtle">密钥（在验证器里选择手动输入）：</p>
          <pre data-totp="secret"></pre>
          <div class="actions">
            <button class="ghost" type="button" data-totp="copy-secret">复制密钥</button>
          </div>
          <p class="subtle">或使用这个链接添加账户：</p>
          <pre data-totp="uri"></pre>
          <div class="actions">
            <button class="ghost" type="button" data-totp="copy-uri">复制链接</button>
          </div>
        </div>
        <label data-totp="code-field">验证码或恢复码
          <input data-totp="code" autocomplete="one-time-code" inputmode="numeric" maxlength="24" />
        </label>
        <label data-totp="password-field" hidden>当前密码
          <input data-totp="password" type="password" autocomplete="current-password" maxlength="256" />
        </label>
        <div class="stack" data-totp="codes-block" hidden>
          <p class="callout warn">恢复码只显示这一次。请保存到安全的地方；每个码只能用一次。</p>
          <pre data-totp="codes"></pre>
          <div class="actions">
            <button class="ghost" type="button" data-totp="copy-codes">复制全部恢复码</button>
          </div>
        </div>
        <p class="field-error" data-totp="error" hidden></p>
        <div class="modal-actions">
          <button class="secondary" type="button" data-totp="cancel">取消</button>
          <button type="submit" data-totp="submit">确认</button>
        </div>
      </form>`;
    document.body.append(dialog);

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener("close", () => document.body.classList.remove("modal-open"));
    dialog.querySelector("form").addEventListener("submit", submit);
    dialog.querySelector('[data-totp="cancel"]').addEventListener("click", closeDialog);
    dialog.querySelector('[data-totp="copy-secret"]').addEventListener("click", () => {
      copyWithToast(currentSecret, "密钥已复制");
    });
    dialog.querySelector('[data-totp="copy-uri"]').addEventListener("click", () => {
      copyWithToast(dialogElements().uri.textContent, "链接已复制");
    });
    dialog.querySelector('[data-totp="copy-codes"]').addEventListener("click", () => {
      copyWithToast(dialogElements().codes.textContent, "恢复码已复制");
    });
    return dialog;
  }

  function dialogElements() {
    const find = (name) => dialog.querySelector(`[data-totp="${name}"]`);
    return {
      title: find("title"),
      text: find("text"),
      secretBlock: find("secret-block"),
      secret: find("secret"),
      uri: find("uri"),
      codeField: find("code-field"),
      code: find("code"),
      passwordField: find("password-field"),
      password: find("password"),
      codesBlock: find("codes-block"),
      codes: find("codes"),
      error: find("error"),
      submit: find("submit"),
    };
  }

  function copyWithToast(value, message) {
    copyText(value)
      .then(() => toast(message))
      .catch(() => toast("复制失败，请手动选择", { tone: "danger" }));
  }

  actions.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-totp-action]") : null;
    if (!target) return;
    const action = target.getAttribute("data-totp-action");
    setError("");
    setOk("");
    if (action === "enable") void beginEnable();
    else if (action === "disable") openDialog("disable");
    else if (action === "recovery") openDialog("recovery");
  });

  void load();

  return () => {
    disposed = true;
    closeDialog();
    dialog?.remove();
    dialog = null;
  };
}

function groupSecret(secret) {
  return String(secret || "").replace(/(.{4})/g, "$1 ").trim();
}
