// Captures the install prompt and registers the service worker.
// Every failure stays in this file so the rest of the page keeps running.
(function () {
  var deferred = null;
  var installed = false;

  function standalone() {
    try {
      if (window.matchMedia("(display-mode: standalone)").matches) return true;
    } catch (error) {}
    try {
      if (window.navigator.standalone === true) return true;
    } catch (error) {}
    return false;
  }

  function markInstalled() {
    installed = true;
    deferred = null;
  }

  if (standalone()) markInstalled();

  window.__pwaInstall = {
    canInstall: function () {
      try {
        return !installed && !standalone() && deferred != null;
      } catch (error) {
        return false;
      }
    },
    promptInstall: function () {
      try {
        if (!deferred || installed || standalone()) return Promise.resolve(false);
        var promptEvent = deferred;
        deferred = null;
        return Promise.resolve()
          .then(function () {
            return promptEvent.prompt();
          })
          .then(function () {
            return promptEvent.userChoice;
          })
          .then(function (choice) {
            var accepted = !!(choice && choice.outcome === "accepted");
            if (accepted) markInstalled();
            return accepted;
          })
          .catch(function () {
            return false;
          });
      } catch (error) {
        return Promise.resolve(false);
      }
    },
    isInstalled: function () {
      try {
        return installed || standalone();
      } catch (error) {
        return false;
      }
    },
  };

  try {
    window.addEventListener("beforeinstallprompt", function (event) {
      try {
        if (installed || standalone()) return;
        event.preventDefault();
        deferred = event;
      } catch (error) {}
    });
  } catch (error) {}

  try {
    window.addEventListener("appinstalled", function () {
      try {
        markInstalled();
      } catch (error) {}
    });
  } catch (error) {}

  try {
    window.addEventListener("load", function () {
      try {
        if (!("serviceWorker" in navigator)) return;
        navigator.serviceWorker.register("/sw.js").catch(function () {});
      } catch (error) {}
    });
  } catch (error) {}
})();
