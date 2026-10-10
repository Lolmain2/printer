// Electron shell: shows the web app (../index.html) in a desktop window.
const { app, BrowserWindow, session, shell } = require("electron");
const path = require("path");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 380,
    minHeight: 560,
    title: "Scream Coach",
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#0f1115",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "..", "index.html"));
  win.once("ready-to-show", () => win.show());

  // The app is a single page: never navigate the window away from it, and
  // send any web link to the normal browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  // The pitch check needs the microphone; nothing else is ever granted.
  const audioOnly = (details) => !details.mediaTypes || details.mediaTypes.every((t) => t === "audio");
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === "media" && audioOnly(details));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");
  createWindow();
});

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on("window-all-closed", () => app.quit());
