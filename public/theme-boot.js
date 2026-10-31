try {
  var stored = localStorage.getItem("smsinbox-theme");
  var theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  document.documentElement.setAttribute("data-theme", theme);
} catch (error) {
  document.documentElement.setAttribute("data-theme", "system");
}
