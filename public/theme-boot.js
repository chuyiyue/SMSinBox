try {
  var stored = localStorage.getItem("smsinbox-theme");
  var theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  document.documentElement.setAttribute("data-theme", theme);
} catch (error) {
  document.documentElement.setAttribute("data-theme", "system");
}
try {
  var storedLocale = localStorage.getItem("smsinbox.locale");
  var locale = storedLocale === "en" || storedLocale === "zh-CN" ? storedLocale : "zh-CN";
  document.documentElement.lang = locale;
  document.documentElement.setAttribute("data-locale", locale);
  if (locale === "en") {
    var hide = document.createElement("style");
    hide.textContent = "html[data-locale=en]:not(.i18n-ready) body{visibility:hidden}";
    document.head.appendChild(hide);
  }
} catch (error) {
  document.documentElement.lang = "zh-CN";
  document.documentElement.setAttribute("data-locale", "zh-CN");
}
