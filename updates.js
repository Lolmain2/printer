// Auto-update status as the user sees it. The desktop app's main process
// (desktop/main.js) reports a status; this turns it into words and the one
// action that makes sense. Pure, unit tested in Node (tests/updates.test.js).
//
// status = { state, version?, percent?, message?, current }
//   state: "dev" | "portable" | "idle" | "checking" | "current" |
//          "downloading" | "ready" | "error"

(function (root) {
  function updateView(status) {
    const s = status || {};
    const v = s.current ? `Version ${s.current}` : "";
    switch (s.state) {
      case "checking":
        return { line: `${v} · Checking for updates…`, action: null, banner: false };
      case "current":
        return { line: `${v} · Up to date`, action: "check", banner: false };
      case "downloading": {
        const pct = Number.isFinite(s.percent) ? ` ${Math.round(s.percent)}%` : "";
        return { line: `${v} · Downloading ${s.version || "an update"}…${pct}`, action: null, banner: false };
      }
      case "ready":
        return {
          line: `${v} · Version ${s.version} is ready. It installs when you restart (or next time you close the app).`,
          action: "install",
          banner: true,
        };
      case "error":
        return { line: `${v} · Couldn't check for updates${s.message ? ` (${shortError(s.message)})` : ""}.`, action: "check", banner: false };
      case "portable":
        return { line: `${v} · This copy can't update itself. Install the app once to get automatic updates.`, action: "download", banner: false };
      case "dev":
        return { line: `${v} · Running from source: updates are off.`, action: null, banner: false };
      default:
        return { line: v, action: "check", banner: false };
    }
  }

  // Network errors are long; keep the gist.
  function shortError(message) {
    const m = String(message);
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|net::ERR_INTERNET_DISCONNECTED|net::ERR_NAME_NOT_RESOLVED/i.test(m)) return "no internet connection";
    const first = m.split("\n")[0];
    return first.length > 80 ? `${first.slice(0, 77)}…` : first;
  }

  const api = { updateView, shortError };
  root.Updates = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
