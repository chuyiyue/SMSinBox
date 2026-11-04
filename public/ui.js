const THEME_KEY = "smsinbox-theme";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABEL = {
  system: "主题：跟随系统",
  light: "主题：浅色",
  dark: "主题：深色",
};

let menuNode = null;

export function currentTheme() {
  const value = document.documentElement.dataset.theme;
  return THEME_ORDER.includes(value) ? value : "system";
}

export function applyTheme(theme) {
  const next = THEME_ORDER.includes(theme) ? theme : "system";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Private mode and disabled storage still keep the choice for this view.
  }
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    const label = button.querySelector(".btn-label");
    if (label) label.textContent = THEME_LABEL[next];
    else button.textContent = THEME_LABEL[next];
    button.setAttribute("aria-label", THEME_LABEL[next]);
  }
}

export function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
  applyTheme(next);
}

export function takeFlash() {
  try {
    const value = sessionStorage.getItem("smsinbox-flash") || "";
    sessionStorage.removeItem("smsinbox-flash");
    return value;
  } catch {
    return "";
  }
}

export function rememberFlash(message) {
  try {
    sessionStorage.setItem("smsinbox-flash", message);
  } catch {
    // The next page still works if storage is blocked.
  }
}

export function toast(message, options = {}) {
  const text = String(message || "").trim();
  if (!text) return;
  let root = document.querySelector("#toasts");
  if (!root) {
    root = document.createElement("div");
    root.id = "toasts";
    root.className = "toasts";
    document.body.append(root);
  }
  while (root.children.length >= 3) root.firstElementChild?.remove();
  const item = document.createElement("div");
  item.className = options.tone === "danger" ? "toast is-danger" : "toast";
  item.setAttribute("role", options.tone === "danger" ? "alert" : "status");
  const body = document.createElement("span");
  body.textContent = text;
  item.append(body);
  if (options.href) {
    const link = document.createElement("a");
    link.href = options.href;
    link.textContent = options.linkLabel || "查看";
    item.append(link);
  }
  if (options.tone === "danger") {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.textContent = "关闭";
    close.addEventListener("click", () => item.remove());
    item.append(close);
  }
  root.append(item);
  window.setTimeout(() => item.remove(), options.tone === "danger" ? 5000 : 3000);
}

export function closeMenu() {
  menuNode?.cleanup?.();
  menuNode?.remove();
  menuNode = null;
}

export function openMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  const buttons = [];
  // Menus that act as a select (one current value) mark it with a check;
  // the slot is rendered for every item so the labels stay aligned.
  const hasSelected = items.some((item) => "selected" in item);
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `menu-item${item.danger ? " is-danger" : ""}${item.selected ? " is-selected" : ""}`;
    button.setAttribute("role", "menuitem");
    if (hasSelected) {
      const slot = document.createElement("span");
      slot.className = "menu-check";
      slot.setAttribute("aria-hidden", "true");
      if (item.selected) {
        slot.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
        button.setAttribute("aria-checked", "true");
      }
      button.append(slot);
    }
    button.append(document.createTextNode(item.label));
    if (item.disabled) {
      button.classList.add("is-disabled");
      button.setAttribute("aria-disabled", "true");
      button.title = item.reason || "";
      if (item.reason) button.setAttribute("aria-label", `${item.label}。${item.reason}`);
    }
    button.addEventListener("click", () => {
      if (item.disabled) return;
      closeMenu();
      item.onSelect?.();
    });
    menu.append(button);
    buttons.push(button);
  }
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 8)}px`;
  menu.style.left = `${Math.max(8, rect.left)}px`;
  window.requestAnimationFrame(() => {
    const box = menu.getBoundingClientRect();
    if (box.right > window.innerWidth - 8) menu.style.left = `${Math.max(8, window.innerWidth - box.width - 8)}px`;
    if (box.bottom > window.innerHeight - 8) menu.style.top = `${Math.max(8, rect.top - box.height - 6)}px`;
  });
  const onKey = (event) => {
    if (!menu.isConnected) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      anchor.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = buttons[(current + step + buttons.length) % buttons.length];
    next?.focus();
  };
  const onPointer = (event) => {
    if (!menu.contains(event.target) && event.target !== anchor) closeMenu();
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointer);
  menu.cleanup = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onPointer);
  };
  menuNode = menu;
  buttons[0]?.focus();
}

// A select replacement built from the project's own parts (a form-styled
// toggle + openMenu), so no picker ever renders with browser-default UI.
// The value travels in a hidden input, so FormData and form submits keep
// working exactly as they did with a native <select>.
export function mountSelect({ name = "", value = "", options = [], onChange = null, ariaLabel = "" } = {}) {
  const root = document.createElement("div");
  root.className = "select-field";
  const input = document.createElement("input");
  input.type = "hidden";
  if (name) input.name = name;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "select-toggle";
  toggle.setAttribute("aria-haspopup", "true");
  if (ariaLabel) toggle.setAttribute("aria-label", ariaLabel);
  const label = document.createElement("span");
  label.className = "select-label";
  const chevron = document.createElement("span");
  chevron.className = "select-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#icon-chevron-down"/></svg>';
  toggle.append(label, chevron);
  root.append(toggle, input);

  let currentOptions = options.slice();
  let current = value;
  const paint = () => {
    const found = currentOptions.find((option) => option.value === current) || currentOptions[0];
    label.textContent = found ? found.label : "";
    input.value = current;
  };
  const choose = (next) => {
    if (next === current) return;
    current = next;
    paint();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    onChange?.(current);
  };
  toggle.addEventListener("click", () => {
    openMenu(
      toggle,
      currentOptions.map((option) => ({
        label: option.label,
        selected: option.value === current,
        onSelect: () => choose(option.value),
      })),
    );
  });
  paint();
  return {
    root,
    input,
    get value() {
      return current;
    },
    set value(next) {
      current = String(next ?? "");
      paint();
    },
    get label() {
      return currentOptions.find((option) => option.value === current)?.label || "";
    },
    setOptions(next, preferred) {
      currentOptions = next.slice();
      const wanted = preferred !== undefined ? preferred : current;
      current = currentOptions.some((option) => option.value === wanted)
        ? wanted
        : currentOptions[0]?.value ?? "";
      paint();
    },
  };
}

export function openModal(options) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const root = document.createElement("div");
    root.className = "modal-root";
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const dialog = document.createElement("div");
    dialog.className = "modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const titleId = `modal-${Math.random().toString(36).slice(2, 8)}`;
    dialog.setAttribute("aria-labelledby", titleId);
    const card = document.createElement("div");
    card.className = "modal-card";
    const heading = document.createElement("h2");
    heading.id = titleId;
    heading.textContent = options.title || "";
    card.append(heading);
    if (options.text) {
      const paragraph = document.createElement("p");
      paragraph.textContent = options.text;
      card.append(paragraph);
    }
    if (options.body) card.append(options.body);
    let gate = null;
    if (options.requireText) {
      const label = document.createElement("label");
      label.textContent = `输入「${options.requireText}」以确认`;
      gate = document.createElement("input");
      gate.autocomplete = "off";
      label.append(gate);
      card.append(label);
    }
    const error = document.createElement("p");
    error.className = "field-error";
    error.hidden = true;
    card.append(error);
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = options.cancelLabel || "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = options.danger ? "danger" : "primary";
    confirm.textContent = options.confirmLabel || "确定";
    if (options.requireText) confirm.disabled = true;
    actions.append(cancel, confirm);
    card.append(actions);
    dialog.append(card);
    root.append(overlay, dialog);
    document.body.append(root);
    document.body.classList.add("modal-open");

    const finish = (value) => {
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      document.body.classList.remove("modal-open");
      if (previous instanceof HTMLElement) previous.focus();
      resolve(value);
    };
    const tryConfirm = () => {
      const problem = options.beforeClose?.() || "";
      if (problem) {
        error.hidden = false;
        error.textContent = problem;
        return;
      }
      finish(true);
    };
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", tryConfirm);
    gate?.addEventListener("input", () => {
      confirm.disabled = gate.value !== options.requireText;
    });
    if (options.dismissible !== false) overlay.addEventListener("click", () => finish(false));
    const onKey = (event) => {
      if (event.key === "Escape") {
        if (options.dismissible === false) return;
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...dialog.querySelectorAll("button, input, select, textarea, a[href]")].filter(
        (node) => !node.disabled,
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const preferred = gate || card.querySelector("input, select, textarea");
    (preferred || confirm).focus();
  });
}

export function openHelp() {
  let dialog = document.querySelector("#help-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "help-dialog";
    dialog.className = "modal";
    const card = document.createElement("div");
    card.className = "modal-card";
    const heading = document.createElement("h2");
    heading.id = "help-title";
    heading.textContent = "键盘快捷键";
    dialog.setAttribute("aria-labelledby", "help-title");
    const list = document.createElement("ul");
    for (const line of [
      ["/ 聚焦搜索", "/"],
      ["j / k 在收件箱上下移动", "j k"],
      ["Enter 展开或收起当前短信", "Enter"],
      ["c 复制当前短信的验证码", "c"],
      ["Esc 关闭弹出层", "Esc"],
    ]) {
      const item = document.createElement("li");
      item.textContent = line[0];
      list.append(item);
    }
    const note = document.createElement("p");
    note.className = "subtle";
    note.textContent = "光标在输入框里时，这些快捷键不会触发。";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "secondary";
    close.textContent = "关闭";
    close.addEventListener("click", () => dialog.close());
    card.append(heading, list, note, close);
    dialog.append(card);
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => document.body.classList.remove("modal-open"));
    document.body.append(dialog);
  }
  dialog.showModal();
  document.body.classList.add("modal-open");
}

export function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function passwordScore(password) {
  const value = String(password || "");
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score += 1;
  return Math.min(4, score);
}

export function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}
