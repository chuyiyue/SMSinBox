// Paint the cached device list and the primary nav before the first frame.
// Keep STORAGE_KEY, the 7-day stale window, and the button markup aligned with
// public/device-store.js, public/common.js, and renderSidebarDevices().
// Device ids stay in data attributes only; they are never printed.
//
// The primary nav entries come from the single module registry in
// public/registry.js (loaded before this script on every page) and are
// rendered here for every page, so the HTML shells carry no sidebar links.
// The registry also feeds the route map in public/shell.js.
(function () {
  var STORAGE_KEY = "smsinbox.shell";
  var SIDEBAR_KEY = "smsinbox-sidebar";
  var STALE_MS = 7 * 24 * 60 * 60 * 1000;
  // The sidebar device list is a plain list, never collapsible: it shows
  // the pinned devices (or the first devices when nothing is pinned),
  // capped at this many, with an ellipsis row linking to the full list.
  var SIDEBAR_DEVICE_LIMIT = 5;

  // Only modules marked for the nav render here; a module with nav: false
  // (users / 系统管理) stays routable but is entered through the sidebar
  // account button, so SMSINBOX_NAV mirrors exactly what is rendered.
  var NAV_ITEMS = (window.SMSINBOX_MODULES || []).filter(function (item) {
    return item.nav !== false;
  });
  window.SMSINBOX_NAV = NAV_ITEMS;

  // The sidebar chrome is defined ONCE here and rendered into every page's
  // empty <aside>: no per-page copies to drift apart. The markup below is
  // the single source for the brand, nav shell, device section, and the
  // account footer; renderNav() then fills the nav from the registry.
  var SIDEBAR_CHROME =
    '<a class="brand" href="/">' +
    '<span class="mark" aria-hidden="true"><img src="/logo.png" width="18" height="18" alt="" /></span>' +
    '<span class="brand-name">SMSinBox</span>' +
    "</a>" +
    '<nav class="sidebar-nav" aria-label="主导航"></nav>' +
    '<div class="sidebar-devices" aria-labelledby="sidebar-devices-title">' +
    '<div class="sidebar-label-row">' +
    '<span class="sidebar-label" id="sidebar-devices-title">设备</span>' +
    "</div>" +
    '<div id="sidebar-devices" class="device-list"></div>' +
    "</div>" +
    '<div class="sidebar-footer">' +
    '<a class="account-btn" href="/users.html" title="系统管理" aria-label="系统管理">' +
    '<span class="account-avatar" id="sidebar-avatar" aria-hidden="true">管</span>' +
    '<span class="account-name btn-label" id="sidebar-account-name">管理员</span>' +
    "</a>" +
    '<button class="account-logout ghost" type="button" data-logout title="退出登录" aria-label="退出登录">' +
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#icon-log-out"/></svg>' +
    "</button>" +
    "</div>";

  function renderSidebarChrome() {
    var aside = document.querySelector(".sidebar");
    if (!aside || aside.querySelector(".brand")) return;
    aside.innerHTML = SIDEBAR_CHROME;
  }

  function initSidebarChrome() {
    renderSidebarChrome();
    renderNav();
    markAccountEntry();
    var collapsed = readCollapsed();
    injectCollapseButton();
    applySidebarState(collapsed, false);
  }

  function renderNav() {
    var nav = document.querySelector(".sidebar-nav");
    if (!nav) return;
    var active = canonicalPath(location.pathname);
    nav.replaceChildren();
    for (var index = 0; index < NAV_ITEMS.length; index += 1) {
      var item = NAV_ITEMS[index];
      var link = document.createElement("a");
      link.href = item.href;
      link.setAttribute("data-nav-key", item.key);
      link.title = item.title;
      if (item.href === active) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      }
      link.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#' +
        item.icon +
        '"/></svg><span class="nav-label">' +
        item.title +
        "</span>";
      nav.append(link);
    }
  }

  // The account button is the system-management entry now that the module
  // no longer renders in the nav; give it the same current-page marking the
  // nav links get. shell.js re-marks it on in-app navigation.
  function markAccountEntry() {
    var button = document.querySelector(".account-btn");
    if (!button) return;
    var on = canonicalPath(location.pathname) === "/users";
    button.classList.toggle("active", on);
    if (on) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  }

  function canonicalPath(pathname) {
    if (pathname === "/" || pathname === "/index.html" || pathname === "/index") return "/";
    return pathname.endsWith(".html") ? pathname.slice(0, -".html".length) : pathname;
  }

  function readCollapsed() {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch (error) {
      return false;
    }
  }

  function applySidebarState(collapsed, persist) {
    document.documentElement.setAttribute("data-sidebar", collapsed ? "collapsed" : "expanded");
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
      } catch (error) {
        // Private mode and disabled storage still keep the rail for this view.
      }
    }
    var button = document.querySelector(".sidebar-collapse");
    if (button) {
      var label = collapsed ? "展开侧栏" : "收起侧栏";
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    var brandEl = document.querySelector(".sidebar .brand");
    if (brandEl) {
      if (collapsed) brandEl.setAttribute("title", "展开侧栏");
      else brandEl.removeAttribute("title");
    }
  }

  function injectCollapseButton() {
    var nav = document.querySelector(".sidebar-nav");
    var brand = document.querySelector(".sidebar > .brand");
    if (!nav || !brand) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "sidebar-collapse ghost icon-btn";
    button.setAttribute("aria-label", "收起侧栏");
    button.setAttribute("title", "收起侧栏");
    button.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#icon-panel-left"/></svg>';
    button.addEventListener("click", function () {
      var collapsed = document.documentElement.getAttribute("data-sidebar") === "collapsed";
      applySidebarState(!collapsed, true);
    });
    // In the collapsed rail the separate button disappears and the logo
    // itself becomes the expand control: hovering swaps the mark for the
    // panel icon (pure CSS), and clicking expands instead of navigating.
    var expandIcon = document.createElement("span");
    expandIcon.className = "brand-expand";
    expandIcon.setAttribute("aria-hidden", "true");
    expandIcon.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#icon-panel-left"/></svg>';
    var mark = brand.querySelector(".mark");
    if (mark) mark.after(expandIcon);
    else brand.prepend(expandIcon);
    brand.addEventListener("click", function (event) {
      var isCollapsed = document.documentElement.getAttribute("data-sidebar") === "collapsed";
      if (isCollapsed && window.matchMedia("(min-width: 1024px)").matches) {
        event.preventDefault();
        applySidebarState(false, true);
      }
    });
    var row = document.createElement("div");
    row.className = "sidebar-brand-row";
    brand.parentNode.insertBefore(row, brand);
    row.append(brand, button);
  }

  // Mirrors selectSidebarDevices in device-panel.js (this script cannot
  // import modules): pinned devices when any exist, else the first ones,
  // capped at the limit; hasMore drives the ellipsis row.
  function sidebarSelection(devices) {
    var all = [];
    for (var i = 0; i < devices.length; i += 1) {
      if (devices[i] && devices[i].id) all.push(devices[i]);
    }
    var pinned = all.filter(function (device) { return device.pinned_at != null; });
    var shown = (pinned.length ? pinned : all).slice(0, SIDEBAR_DEVICE_LIMIT);
    return { shown: shown, hasMore: all.length > shown.length };
  }

  function moreRow() {
    var link = document.createElement("a");
    link.className = "device-more";
    link.href = "/devices.html";
    link.textContent = "…";
    link.title = "查看全部设备";
    link.setAttribute("aria-label", "查看全部设备");
    return link;
  }

  function paintCachedDevices() {
    var raw = "";
    try {
      raw = sessionStorage.getItem(STORAGE_KEY) || "";
    } catch (error) {
      return;
    }
    if (!raw) return;
    var data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      return;
    }
    if (!data || data.devicesKnown !== true) return;
    var box = document.getElementById("sidebar-devices");
    if (!box || box.childElementCount) return;
    var devices = Array.isArray(data.devices) ? data.devices : [];
    var path = location.pathname;
    var active = "";
    if (path === "/" || path === "/index.html") {
      active = readInboxDevice();
    } else {
      active = String(data.activeId || "");
    }
    if (!devices.length) {
      var empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "还没有设备。";
      box.append(empty);
      return;
    }
    var selection = sidebarSelection(devices);
    for (var index = 0; index < selection.shown.length; index += 1) {
      var device = selection.shown[index];
      box.append(button(String(device.id), String(device.id), String(device.name || "未命名设备"), String(device.id) === active, device));
    }
    if (selection.hasMore) box.append(moreRow());
  }

  function button(id, key, name, on, device) {
    var node = document.createElement("button");
    node.type = "button";
    node.className = on ? "device-link is-active" : "device-link";
    node.setAttribute("data-device-id", id);
    node.setAttribute("data-key", key);
    if (device) {
      var state = deviceState(device);
      node.setAttribute("data-state", state.key);
      var dotStatus = state.key === "recent" ? "ok" : "idle";
      var dotLabel = state.key === "recent" ? "在线" : (state.key === "stale" ? "离线" : "未上报");
      node.title = name + " (" + dotLabel + " · " + state.text + ")";

      var dot = document.createElement("span");
      dot.className = "ui-status-dot";
      dot.setAttribute("data-status", dotStatus);
      dot.setAttribute("aria-hidden", "true");

      var title = document.createElement("span");
      title.className = "device-name";
      title.textContent = name;

      var status = document.createElement("span");
      status.className = "device-state";
      status.textContent = state.text;

      node.append(dot, icon(), title, status);
    } else {
      node.textContent = name;
    }
    return node;
  }

  function icon() {
    var wrap = document.createElement("span");
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24"><use href="/icons.svg#icon-smartphone"/></svg>';
    return wrap.firstChild;
  }

  function deviceState(device) {
    var seen = Number(device && device.last_seen_at);
    if (!isFinite(seen) || seen <= 0) return { key: "none", text: "尚未收到" };
    var stale = Date.now() - seen > STALE_MS;
    return { key: stale ? "stale" : "recent", text: "最近上报 " + relative(seen) };
  }

  function relative(ms) {
    var diff = Date.now() - ms;
    if (diff >= 0 && diff < 60000) return "刚刚";
    if (diff >= 0 && diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    var date = new Date(ms);
    var now = new Date();
    var clock = pad(date.getHours()) + ":" + pad(date.getMinutes());
    if (date.toDateString() === now.toDateString()) return clock;
    var yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "昨天 " + clock;
    var monthDay = pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + clock;
    if (date.getFullYear() === now.getFullYear()) return monthDay;
    return date.getFullYear() + "-" + monthDay;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function readInboxDevice() {
    try {
      var params = new URLSearchParams(location.search);
      return params.get("device") || params.get("device_id") || "";
    } catch (error) {
      return "";
    }
  }

  // Runs last on purpose: the calls above this comment only declare, so by
  // the time initSidebarChrome() executes, SIDEBAR_CHROME is assigned.
  initSidebarChrome();
  paintCachedDevices();
})();
