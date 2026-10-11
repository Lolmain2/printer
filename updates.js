// Auto-update status as the user sees it. The desktop app's main process
// (desktop/main.js) reports a status; this turns it into words and the one
// action that makes sense. Pure, unit tested in Node (tests/updates.test.js).
//
// status = { state, version?, percent?, message?, current }
//   state: "dev" | "idle" | "checking" | "current" | "downloading" |
//          "ready" | "error" (with phase "check" | "download")

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
      case "error": {
        const why = s.message ? ` (${shortError(s.message)})` : "";
        if (s.phase === "download") {
          return { line: `${v} · Couldn't download version ${s.version || "the update"}${why}. It will try again later.`, action: "check", banner: false };
        }
        return { line: `${v} · Couldn't check for updates${why}.`, action: "check", banner: false };
      }
      case "dev":
        return { line: `${v} · Running from source: updates are off.`, action: null, banner: false };
      default:
        return { line: v, action: "check", banner: false };
    }
  }

  // Network errors are long; keep the gist.
  function shortError(message) {
    const m = String(message);
    const offline =
      /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|ADDRESS_UNREACHABLE|NETWORK_IO_SUSPENDED|PROXY_CONNECTION_FAILED)/i;
    if (offline.test(m)) return "no internet connection";
    const first = m.split("\n")[0];
    return first.length > 80 ? `${first.slice(0, 77)}…` : first;
  }

  const api = { updateView, shortError };
  root.Updates = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
