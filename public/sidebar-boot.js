// Paint the cached device list and the primary nav before the first frame.
// Keep STORAGE_KEY, the 7-day stale window, and the button markup aligned with
// public/device-store.js, public/common.js, and renderSidebarDevices().
// Device ids stay in data attributes only; they are never printed.
//
// The five primary nav entries are defined once in NAV_ITEMS and rendered here
// for every page, so the HTML shells no longer carry duplicated sidebar links.
// Keep NAV_ITEMS aligned with the route map in public/shell.js.
(function () {
  var STORAGE_KEY = "smsinbox.shell";
  var SIDEBAR_KEY = "smsinbox-sidebar";
  var SIDEBAR_DEVICES_KEY = "smsinbox-sidebar-devices";
  var STALE_MS = 7 * 24 * 60 * 60 * 1000;

  var NAV_ITEMS = [
    { key: "inbox", title: "收件箱", href: "/", icon: "icon-inbox" },
    { key: "devices", title: "设备列表", href: "/devices.html", icon: "icon-smartphone" },
    { key: "notify", title: "推送渠道", href: "/notify.html", icon: "icon-bell" },
    { key: "api-mcp", title: "API 与 MCP", href: "/api-mcp.html", icon: "icon-terminal" },
    { key: "users", title: "系统管理", href: "/users.html", icon: "icon-settings" },
  ];
  window.SMSINBOX_NAV = NAV_ITEMS;

  initSidebarChrome();
  paintCachedDevices();

  function initSidebarChrome() {
    renderNav();
    var collapsed = readCollapsed();
    injectCollapseButton();
    applySidebarState(collapsed, false);
    initDevicesCollapse();
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

  function canonicalPath(pathname) {
    if (pathname === "/" || pathname === "/index.html") return "/";
    return pathname;
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
      var text = button.querySelector(".nav-label");
      if (text) text.textContent = label;
    }
  }

  function injectCollapseButton() {
    var nav = document.querySelector(".sidebar-nav");
    if (!nav) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "sidebar-collapse";
    button.setAttribute("aria-label", "收起侧栏");
    button.setAttribute("title", "收起侧栏");
    button.innerHTML =
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#icon-chevron-left"/></svg>' +
      '<span class="nav-label">收起侧栏</span>';
    button.addEventListener("click", function () {
      var collapsed = document.documentElement.getAttribute("data-sidebar") === "collapsed";
      applySidebarState(!collapsed, true);
    });
    nav.after(button);
  }

  function initDevicesCollapse() {
    var collapsed = readDevicesCollapsed();
    applyDevicesCollapsedState(collapsed, false);
    var button = document.querySelector("#sidebar-devices-toggle");
    if (button) {
      button.addEventListener("click", function () {
        var section = document.querySelector(".sidebar-devices");
        var isCurrentlyCollapsed = section ? section.classList.contains("is-collapsed") : false;
        applyDevicesCollapsedState(!isCurrentlyCollapsed, true);
      });
    }
  }

  function readDevicesCollapsed() {
    try {
      return localStorage.getItem(SIDEBAR_DEVICES_KEY) === "collapsed";
    } catch (error) {
      return false;
    }
  }

  function applyDevicesCollapsedState(collapsed, persist) {
    var section = document.querySelector(".sidebar-devices");
    if (section) {
      section.classList.toggle("is-collapsed", collapsed);
    }
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_DEVICES_KEY, collapsed ? "collapsed" : "expanded");
      } catch (error) {
        // Storage disabled or private browsing mode
      }
    }
    var button = document.querySelector("#sidebar-devices-toggle");
    if (button) {
      button.setAttribute("aria-expanded", collapsed ? "false" : "true");
      var label = collapsed ? "展开设备列表" : "收起设备列表";
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
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
    box.append(button("", "all", "全部设备", active === "", null));
    if (!devices.length) {
      var empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "还没有设备。";
      box.append(empty);
      var add = document.createElement("a");
      add.className = "sidebar-empty-add";
      add.href = "/devices.html#add";
      add.textContent = "添加设备";
      box.append(add);
      return;
    }
    for (var index = 0; index < devices.length; index += 1) {
      var device = devices[index];
      if (!device || !device.id) continue;
      box.append(button(String(device.id), String(device.id), String(device.name || "未命名设备"), String(device.id) === active, device));
    }
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
      '<svg class="icon" viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>';
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
})();
