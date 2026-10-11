// Automatic updates for the installed desktop app, from this repo's GitHub
// Releases (published by the CI build on every push to the main branch).
// Updates download in the background; installing waits for the user to
// restart, or happens when they next close the app.
const { app, ipcMain, shell } = require("electron");

const RELEASES_URL = "https://github.com/Lolmain2/printer/releases/latest";
const FIRST_CHECK_MS = 5 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

function setupUpdates(getWindow) {
  let status = { state: "idle" };
  const withVersion = (s) => ({ ...s, current: app.getVersion() });
  const send = (next) => {
    status = next;
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("update:status", withVersion(status));
  };

  ipcMain.handle("update:get", () => withVersion(status));
  ipcMain.handle("update:releases", () => shell.openExternal(RELEASES_URL));

  // The portable exe and a run from source (npm start) can't update themselves.
  const fixed = process.env.PORTABLE_EXECUTABLE_FILE ? "portable" : !app.isPackaged ? "dev" : null;
  if (fixed) {
    status = { state: fixed };
    ipcMain.handle("update:check", () => withVersion(status));
    ipcMain.handle("update:install", () => false);
    return;
  }

  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  const busy = () => status.state === "downloading" || status.state === "ready";
  autoUpdater.on("checking-for-update", () => {
    if (!busy()) send({ state: "checking" });
  });
  autoUpdater.on("update-available", (info) => send({ state: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (p) => send({ state: "downloading", version: status.version, percent: p.percent }));
  autoUpdater.on("update-not-available", () => send({ state: "current" }));
  autoUpdater.on("update-downloaded", (info) => send({ state: "ready", version: info.version }));
  autoUpdater.on("error", (err) => {
    // A failed later check shouldn't hide an update that's already downloaded.
    if (status.state !== "ready") send({ state: "error", message: String((err && err.message) || err) });
  });

  let checking = false;
  async function check() {
    if (checking || busy()) return withVersion(status);
    checking = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      /* reported through the "error" event */
    } finally {
      checking = false;
    }
    return withVersion(status);
  }

  ipcMain.handle("update:check", () => check());
  ipcMain.handle("update:install", () => {
    if (status.state !== "ready") return false;
    // Silent install, then start the new version.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });

  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { setupUpdates };
