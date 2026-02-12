const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const sharp = require("sharp");

let mainWindow = null;

const handlers = ["pick-images", "pick-output-dir", "read-image-dataurl", "get-image-metadata", "crop-save", "fit-save"];
handlers.forEach(ch => ipcMain.removeHandler(ch));

ipcMain.handle("pick-images", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "heic"] }]
  });
  return res.canceled ? { canceled: true } : { canceled: false, files: res.filePaths };
});

ipcMain.handle("pick-output-dir", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return res.canceled ? { canceled: true } : { canceled: false, dir: res.filePaths[0] };
});

ipcMain.handle("read-image-dataurl", async (_, p) => {
  const buf = await fs.readFile(p);
  const ext = path.extname(p).toLowerCase().replace(".", "");
  return `data:image/${ext === "jpg" ? "jpeg" : (ext === "png" ? "png" : "webp")};base64,${buf.toString("base64")}`;
});

ipcMain.handle("fit-save", async (_, { inputPath, outDir, aspectRatio }) => {
  const name = path.basename(inputPath, path.extname(inputPath));
  const outPath = path.join(outDir, `${name}_fitted_${aspectRatio.replace(":", "x")}.jpg`);
  
  const img = sharp(inputPath).rotate();
  const meta = await img.metadata();
  const bg = { r: 255, g: 255, b: 255, alpha: 1 };
  
  if (aspectRatio === "Original") {
    // 元の比率：長辺の5%の余白を四方に追加（実質的に画像を縮小して枠を足す）
    const border = Math.round(Math.max(meta.width, meta.height) * 0.05);
    await img.extend({
      top: border, bottom: border, left: border, right: border,
      background: bg
    }).jpeg({ quality: 95 }).toFile(outPath);
  } else {
    // 4:3 / 1:1：指定比率のキャンバスを作成し、その中の90%のサイズに画像を縮小して配置
    const ratio = aspectRatio === "1:1" ? 1 : 4 / 3;
    let canvasW, canvasH;
    
    if (meta.width / meta.height > ratio) {
      canvasW = meta.width;
      canvasH = Math.round(meta.width / ratio);
    } else {
      canvasH = meta.height;
      canvasW = Math.round(meta.height * ratio);
    }

    // 画像をキャンバスの90%サイズにリサイズ
    const contentW = Math.round(canvasW * 0.9);
    const contentH = Math.round(canvasH * 0.9);

    await img.resize({
      width: contentW,
      height: contentH,
      fit: "contain",
      background: bg
    }).extend({
      top: Math.floor((canvasH - contentH) / 2),
      bottom: Math.ceil((canvasH - contentH) / 2),
      left: Math.floor((canvasW - contentW) / 2),
      right: Math.ceil((canvasW - contentW) / 2),
      background: bg
    }).jpeg({ quality: 95 }).toFile(outPath);
  }
  return { ok: true };
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 850,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile("index.html");
}
app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
