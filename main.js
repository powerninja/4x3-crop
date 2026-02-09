const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const sharp = require("sharp");

let mainWindow = null;

// ---- ダイアログmutex（mac対策）----
let isOpenDialogActive = false;

// ---- IPC: 二重登録防止 ----
[
  "pick-images",
  "pick-output-dir",
  "read-image-dataurl",
  "get-image-metadata",
  "crop-save",
].forEach((ch) => ipcMain.removeHandler(ch));

ipcMain.handle("pick-images", async () => {
  const paths = dialog.showOpenDialogSync(mainWindow, {
    title: "画像を選択",
    buttonLabel: "開く",
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Images",
        extensions: ["jpg", "jpeg", "png", "webp", "tif", "tiff", "heic"],
      },
    ],
  });

  if (!paths || paths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, files: paths };
});

ipcMain.handle("pick-output-dir", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "保存先フォルダ",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled) return { canceled: true };
  return { canceled: false, dir: res.filePaths[0] };
});

ipcMain.handle("read-image-dataurl", async (_evt, inputPath) => {
  const buf = await fs.readFile(inputPath);
  const ext = path.extname(inputPath).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".png"
      ? "image/png"
      : ext === ".webp"
      ? "image/webp"
      : "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
});

ipcMain.handle("get-image-metadata", async (_evt, inputPath) => {
  const meta = await sharp(inputPath).rotate().metadata();
  return { width: meta.width, height: meta.height };
});

ipcMain.handle("crop-save", async (_evt, payload) => {
  const { inputPath, outDir, rect, aspectRatio } = payload;
  const name = path.basename(inputPath, path.extname(inputPath));
  const suffix = aspectRatio === "1:1" ? "1x1" : "4x3";
  const outPath = path.join(outDir, `${name}_${suffix}.jpg`);

  await sharp(inputPath)
    .rotate()
    .extract({
      left: Math.max(0, Math.floor(rect.x)),
      top: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
    })
    .jpeg({ quality: 95 })
    .toFile(outPath);

  return { ok: true, outPath };
});

// ---- Window ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  // mainWindow.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
