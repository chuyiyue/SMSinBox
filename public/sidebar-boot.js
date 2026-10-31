// Paint the cached device list before the first frame. Keep STORAGE_KEY,
// the 600000ms presence window, and the button markup aligned with
// public/device-store.js and renderSidebarDevices().
(function () {
  var STORAGE_KEY = "smsinbox.shell";
  var ONLINE_MS = 600000;
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
    active = new URLSearchParams(location.search).get("device_id") || "";
  } else {
    active = String(data.activeId || "");
  }
  addButton(box, "", "all", "全部设备", active === "");
  if (!devices.length) {
    var empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = "还没有设备。";
    box.appendChild(empty);
  } else {
    for (var index = 0; index < devices.length; index += 1) {
      var device = devices[index];
      if (!device || !device.id) continue;
      var id = String(device.id);
      var name = String(device.name || "未命名设备");
      addButton(box, id, id, name, id === active, presence(device), device);
    }
  }
  var me = data.me;
  if (me && me.username) {
    var who = document.getElementById("who");
    if (who && !who.textContent) who.textContent = me.username;
  }
  if (me && me.role === "admin") {
    var link = document.getElementById("users-link");
    if (link) link.hidden = false;
    var tab = document.getElementById("users-tab");
    if (tab) tab.hidden = false;
  }

  function addButton(parent, id, key, name, on, state, device) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = on ? "device-link is-active" : "device-link";
    button.setAttribute("data-device-id", id);
    button.setAttribute("data-key", key);
    button.textContent = name;
    if (id) button.title = name;
    if (state) {
      button.setAttribute("data-presence", state);
      var seen = Number(device && device.last_seen_at);
      if (isFinite(seen) && seen > 0) button.setAttribute("data-last-seen", String(seen));
      if (state === "online") button.setAttribute("aria-label", name + "，在线");
    }
    parent.appendChild(button);
  }

  function presence(device) {
    var seen = Number(device && device.last_seen_at);
    if (!isFinite(seen) || seen <= 0) return "";
    return Date.now() - seen <= ONLINE_MS ? "online" : "idle";
  }
})();
