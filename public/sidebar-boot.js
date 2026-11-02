// Paint the cached device list before the first frame. Keep STORAGE_KEY,
// the 7-day stale window, and the button markup aligned with
// public/device-store.js, public/common.js, and renderSidebarDevices().
// Device ids stay in data attributes only; they are never printed.
(function () {
  var STORAGE_KEY = "smsinbox.shell";
  var STALE_MS = 7 * 24 * 60 * 60 * 1000;
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
    empty.textContent = "还没有设备";
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

  function button(id, key, name, on, device) {
    var node = document.createElement("button");
    node.type = "button";
    node.className = on ? "device-link is-active" : "device-link";
    node.setAttribute("data-device-id", id);
    node.setAttribute("data-key", key);
    if (device) {
      var state = deviceState(device);
      node.setAttribute("data-state", state.key);
      node.title = name;
      var title = document.createElement("span");
      title.className = "device-name";
      title.textContent = name;
      var status = document.createElement("span");
      status.className = "device-state";
      status.textContent = state.text;
      node.append(icon(), title, status);
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
