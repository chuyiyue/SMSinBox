import { api, applyI18n, copyText, formatTime, isUnauthorized, showNotice, toast } from "./common.js";
import { t } from "./i18n.js";
import qrcode from "./vendor/qrcode.mjs";

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

  const setError = (message, key) => {
    if (!errorBox) return;
    if (key) {
      errorBox.setAttribute("data-i18n", key);
      showNotice(errorBox, t(key));
      return;
    }
    errorBox.removeAttribute("data-i18n");
    showNotice(errorBox, message);
  };
  const setOk = (message, key) => {
    if (!okBox) return;
    if (key) {
      okBox.setAttribute("data-i18n", key);
      showNotice(okBox, t(key));
      return;
    }
    okBox.removeAttribute("data-i18n");
    showNotice(okBox, message);
  };

  async function load() {
    try {
      const result = await api("/api/v1/auth/totp");
      if (disposed) return;
      if (!result.response.ok) {
        if (result.data.error) setError(result.data.error);
        else setError("", "totp.loadFailed");
        return;
      }
      status = result.data;
      render();
    } catch (error) {
      if (disposed || isUnauthorized(error)) return;
      setError("", "totp.loadFailed");
    }
  }

  function render() {
    actions.replaceChildren();
    extraLine.textContent = "";
    extraLine.className = "subtle";
    extraLine.removeAttribute("data-i18n");
    if (!status) return;
    stateLine.removeAttribute("data-i18n");
    if (status.enabled) {
      const since = Number(status.enabled_at);
      stateLine.textContent = Number.isFinite(since) && since > 0
        ? t("totp.enabledSince", { time: formatTime(since) })
        : t("totp.enabled");
      const remaining = Number(status.recovery_codes_remaining) || 0;
      if (remaining > 0) {
        extraLine.textContent = t("totp.recoveryLeft", { count: remaining });
      } else {
        extraLine.textContent = t("totp.recoveryEmpty");
        extraLine.className = "callout warn";
      }
      actions.append(button(t("totp.regen"), "recovery", "secondary"));
      actions.append(button(t("totp.disable"), "disable", "secondary"));
      return;
    }
    stateLine.textContent = status.pending ? t("totp.pendingHint") : t("totp.off");
    if (status.pending && Number(status.pending_expires_at) > Date.now()) {
      extraLine.textContent = t("totp.pendingExpires", { time: formatTime(Number(status.pending_expires_at)) });
    }
    actions.append(button(status.pending ? t("totp.restart") : t("totp.enable"), "enable", "primary"));
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
        if (result.data.error) setError(result.data.error);
        else setError("", "totp.setupFailed");
        return;
      }
      openDialog("enable", {
        secret: String(result.data.secret || ""),
        uri: String(result.data.otpauth_uri || ""),
      });
    } catch (error) {
      if (disposed || isUnauthorized(error)) return;
      setError("", "totp.setupRetry");
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
    elements.codeLabel.textContent = nextMode === "enable" ? t("auth.code") : t("auth.codeOrRecovery");
    if (nextMode === "enable") {
      elements.title.textContent = t("totp.enable");
      elements.text.textContent = t("totp.enableHelp");
      renderQr(elements.qr, data.uri || "");
      elements.uri.textContent = data.uri || "";
      elements.submit.textContent = t("totp.confirmEnable");
    } else if (nextMode === "disable") {
      elements.title.textContent = t("totp.disable");
      elements.text.textContent = t("totp.disableHelp");
      elements.submit.textContent = t("totp.disable");
    } else {
      elements.title.textContent = t("totp.regen");
      elements.text.textContent = t("totp.regenHelp");
      elements.submit.textContent = t("totp.generate");
    }
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("modal-open");
    if (nextMode === "enable") elements.code.focus();
    else elements.password.focus();
  }

  function showCodes(codes) {
    const elements = dialogElements();
    mode = "done";
    elements.title.textContent = t("totp.saveTitle");
    elements.text.textContent = t("totp.saveHelp");
    elements.secretBlock.hidden = true;
    elements.codeField.hidden = true;
    elements.passwordField.hidden = true;
    elements.codesBlock.hidden = false;
    elements.codes.textContent = codes.join("\n");
    elements.submit.disabled = false;
    elements.submit.textContent = t("totp.savedClose");
    setOk("", "totp.updated");
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
    if (!code) return showDialogError(elements, mode === "enable" ? t("auth.enterCode") : t("auth.enterCodeOrRecovery"));
    const passwordValue = elements.password.value;
    if (mode !== "enable" && !passwordValue) return showDialogError(elements, t("auth.passwordRequired"));

    const path = mode === "enable"
      ? "/api/v1/auth/totp/enable"
      : mode === "disable"
        ? "/api/v1/auth/totp/disable"
        : "/api/v1/auth/totp/recovery";
    const body = mode === "enable" ? { code } : { password: passwordValue, code };
    setBusy(true);
    try {
      const result = await api(path, { method: "POST", body: JSON.stringify(body), allowUnauthorized: true });
      if (disposed || !dialog) return;
      if (!result.response.ok) {
        if (!dialog.open) return;
        showDialogError(elements, result.data.error || t("totp.actionFailed"));
        return;
      }
      if (mode === "disable") {
        closeDialog();
        toast(t("totp.disabledToast"));
        await load();
        return;
      }
      showCodes(Array.isArray(result.data.recovery_codes) ? result.data.recovery_codes.map(String) : []);
      if (!dialog.open) {
        dialog.showModal();
        document.body.classList.add("modal-open");
      }
      await load();
    } catch (error) {
      if (disposed || isUnauthorized(error)) return;
      if (!dialog?.open) return;
      showDialogError(elements, t("auth.networkError"));
    } finally {
      setBusy(false);
    }
  }

  function setBusy(next) {
    busy = next;
    if (!dialog) return;
    const elements = dialogElements();
    elements.submit.disabled = next;
    elements.submit.textContent = next ? t("totp.working") : currentSubmitLabel();
  }

  function currentSubmitLabel() {
    if (mode === "enable") return t("totp.confirmEnable");
    if (mode === "disable") return t("totp.disable");
    if (mode === "recovery") return t("totp.generate");
    return t("totp.savedClose");
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
        <h2 data-totp="title"></h2>
        <p class="subtle" data-totp="text"></p>
        <div class="stack" data-totp="secret-block" hidden>
          <div class="totp-qr" data-totp="qr" hidden></div>
          <p class="subtle" data-i18n="totp.linkHint">或使用这个链接添加账户：</p>
          <pre data-totp="uri"></pre>
          <div class="actions">
            <button class="ghost" type="button" data-totp="copy-uri" data-i18n="totp.copyLink">复制链接</button>
          </div>
        </div>
        <label data-totp="code-field"><span data-totp="code-label"></span>
          <input data-totp="code" autocomplete="one-time-code" inputmode="numeric" maxlength="24" />
        </label>
        <label data-totp="password-field" data-i18n="users.currentPassword" hidden>当前密码
          <input data-totp="password" type="password" autocomplete="current-password" maxlength="256" />
        </label>
        <div class="stack" data-totp="codes-block" hidden>
          <p class="callout warn" data-i18n="totp.codesOnce">恢复码只显示这一次。请保存到安全的地方；每个码只能用一次。</p>
          <pre data-totp="codes"></pre>
          <div class="actions">
            <button class="ghost" type="button" data-totp="copy-codes" data-i18n="totp.copyAll">复制全部恢复码</button>
          </div>
        </div>
        <p class="field-error" data-totp="error" hidden></p>
        <div class="modal-actions">
          <button class="secondary" type="button" data-totp="cancel" data-i18n="common.cancel">取消</button>
          <button type="submit" data-totp="submit"></button>
        </div>
      </form>`;
    document.body.append(dialog);
    applyI18n(dialog);

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener("close", () => document.body.classList.remove("modal-open"));
    dialog.querySelector("form").addEventListener("submit", submit);
    dialog.querySelector('[data-totp="cancel"]').addEventListener("click", closeDialog);
    dialog.querySelector('[data-totp="copy-uri"]').addEventListener("click", () => {
      copyWithToast(dialogElements().uri.textContent, t("totp.linkCopied"));
    });
    dialog.querySelector('[data-totp="copy-codes"]').addEventListener("click", () => {
      copyWithToast(dialogElements().codes.textContent, t("totp.codesCopied"));
    });
    return dialog;
  }

  function dialogElements() {
    const find = (name) => dialog.querySelector(`[data-totp="${name}"]`);
    return {
      title: find("title"),
      text: find("text"),
      secretBlock: find("secret-block"),
      qr: find("qr"),
      uri: find("uri"),
      codeLabel: find("code-label"),
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

  function renderQr(container, uri) {
    container.replaceChildren();
    container.hidden = true;
    if (!uri) return;
    try {
      const qr = qrcode(0, "M");
      qr.addData(uri);
      qr.make();
      container.innerHTML = qr.createSvgTag(4, 8);
      container.hidden = false;
    } catch {
      // QR is a convenience; the manual secret below always works.
    }
  }

  function copyWithToast(value, message) {
    copyText(value)
      .then(() => toast(message))
      .catch(() => toast(t("totp.copyFailed"), { tone: "danger" }));
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

  const onLocale = () => {
    if (status) render();
    if (dialog?.open) closeDialog();
  };
  document.addEventListener("smsinbox:locale", onLocale);

  void load();

  return () => {
    disposed = true;
    document.removeEventListener("smsinbox:locale", onLocale);
    closeDialog();
    dialog?.remove();
    dialog = null;
  };
}
