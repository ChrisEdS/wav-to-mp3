import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, Menu, dialog, session, shell } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;
import { startServer, stopServer } from "../server.js";

const APP_TITLE = "WAV to MP3";
let mainWindow = null;
let serverUrl = "";
let quitting = false;
let logFile = "";

function platformKey() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

function ffmpegFileName() {
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function bundledFfmpegPath() {
  const fileName = ffmpegFileName();
  if (app.isPackaged) return path.join(process.resourcesPath, "ffmpeg", fileName);
  return path.join(app.getAppPath(), "vendor", "ffmpeg", `${platformKey()}-${process.arch}`, fileName);
}

function setupLogging() {
  const dir = app.getPath("logs");
  mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, "wav-to-mp3.log");
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${line}\n`);
  } catch {
    // Logging must not take the app down.
  }
}

function checkForUpdates() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: "info",
      title: APP_TITLE,
      message: "Update checks run in the installed app.",
    });
    return;
  }
  autoUpdater.checkForUpdates().catch((error) => log(`Update check failed: ${error.message}`));
}

function buildMenu() {
  const helpSubmenu = [
    { label: "Check for Updates", click: checkForUpdates },
    { type: "separator" },
    {
      label: "WAV to MP3 on GitHub",
      click: () => shell.openExternal("https://github.com/ChrisEdS/wav-to-mp3"),
    },
  ];
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: helpSubmenu },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function attachWindowGuards(win) {
  const allowed = new URL(serverUrl).origin;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== allowed) event.preventDefault();
  });
}

function createWindow() {
  const icon = path.join(app.getAppPath(), "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 960,
    height: 860,
    minWidth: 420,
    minHeight: 640,
    title: APP_TITLE,
    show: false,
    backgroundColor: "#efe6d8",
    icon: existsSync(icon) ? icon : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  attachWindowGuards(mainWindow);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(serverUrl);
}

function setupUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.on("error", (error) => log(`Update error: ${error.message}`));
  autoUpdater.on("update-available", (info) => log(`Update available: ${info.version}`));
  autoUpdater.on("update-not-available", () => log("No update available"));
  autoUpdater.on("update-downloaded", (info) => log(`Update downloaded: ${info.version}`));
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdatesAndNotify().catch((error) => log(`Update check failed: ${error.message}`));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    setupLogging();
    app.setAppUserModelId("com.chriseds.wavtomp3");
    await session.defaultSession.setProxy({ proxyBypassRules: "<-loopback>" });
    buildMenu();

    const ffmpegPath = bundledFfmpegPath();
    if (!existsSync(ffmpegPath)) {
      dialog.showErrorBox(
        APP_TITLE,
        `Bundled ffmpeg was not found at:\n${ffmpegPath}\n\nRun npm run fetch-ffmpeg and start again.`,
      );
      app.exit(1);
      return;
    }

    try {
      const started = await startServer({ ffmpegPath, openBrowser: false, port: 0 });
      serverUrl = started.url;
      log(`Server ${serverUrl}`);
      log(`ffmpeg ${ffmpegPath}`);
      createWindow();
      setupUpdates();
    } catch (error) {
      log(error.stack || error.message);
      dialog.showErrorBox(APP_TITLE, error.message);
      await stopServer();
      app.exit(1);
    }
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stopServer().finally(() => app.quit());
  });

  app.on("window-all-closed", () => app.quit());
}
