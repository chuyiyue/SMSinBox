// Single source of truth for the app's primary modules.
//
// Every page loads this classic script before public/sidebar-boot.js, which
// renders the primary nav from SMSINBOX_MODULES. public/shell.js imports the
// same file and derives its route map (href -> view script) from it, so a
// module is defined exactly once: key, title, href, icon, script, permission.
// Field meanings:
//   key        stable module id, also the nav item's data-nav-key
//   title      nav label shown in the sidebar
//   href       canonical path of the module's page
//   icon       symbol id in /icons.svg used by the nav link
//   script     view module the shell lazy-loads for href
//   permission who may open the module; every module currently needs the
//              signed-in admin session ("admin")
//   nav        whether the module appears in the sidebar nav; defaults to
//              shown when absent. "nav: false" keeps the module routable
//              (the shell still maps its href) but out of the nav — the
//              users module is reached through the sidebar account button
//              instead, so it must not also render as a nav entry.
window.SMSINBOX_MODULES = Object.freeze([
  Object.freeze({ key: "inbox", title: "收件箱", href: "/", icon: "icon-inbox", script: "/inbox.js", permission: "admin" }),
  Object.freeze({ key: "devices", title: "设备列表", href: "/devices.html", icon: "icon-smartphone", script: "/devices.js", permission: "admin" }),
  Object.freeze({ key: "notify", title: "推送渠道", href: "/notify.html", icon: "icon-bell", script: "/notify.js", permission: "admin" }),
  Object.freeze({ key: "api-mcp", title: "API 与 MCP", href: "/api-mcp.html", icon: "icon-terminal", script: "/api-mcp.js", permission: "admin" }),
  Object.freeze({ key: "users", title: "系统管理", href: "/users.html", icon: "icon-settings", script: "/users.js", permission: "admin", nav: false }),
]);
