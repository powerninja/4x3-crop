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

ipcMain.handle("crop-save", async (_, { inputPath, outDir, rect, aspectRatio }) => {
  const name = path.basename(inputPath, path.extname(inputPath));
  const outPath = path.join(outDir, `${name}_crop_${aspectRatio.replace(":", "x")}.jpg`);
  
  await sharp(inputPath)
    .rotate()
    .extract({
      left: Math.max(0, Math.floor(rect.x)),
      top: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height))
    })
    .jpeg({ quality: 95 })
    .toFile(outPath);
  
  return { ok: true };
});

ipcMain.handle("fit-save", async (_, { inputPath, outDir, aspectRatio, borderPercent, borderType = "white" }) => {
  const name = path.basename(inputPath, path.extname(inputPath));
  const suffix = borderType === "film" ? "film" : "white";
  const outPath = path.join(outDir, `${name}_fitted_${aspectRatio.replace(":", "x")}_${borderPercent}pct_${suffix}.jpg`);

  const img = sharp(inputPath).rotate();
  const meta = await img.metadata();
  const p = parseFloat(borderPercent) / 100;
  const scale = 1 - p * 2;

  if (borderType === "white") {
    const bg = { r: 255, g: 255, b: 255, alpha: 1 };
    if (aspectRatio === "Original") {
      const margin = Math.round(Math.max(meta.width, meta.height) * p);
      await img.extend({ top: margin, bottom: margin, left: margin, right: margin, background: bg })
        .jpeg({ quality: 95 }).toFile(outPath);
    } else {
      const ratio = aspectRatio === "1:1" ? 1 : 4 / 3;
      let canvasW, canvasH;
      if (meta.width / meta.height > ratio) { canvasW = meta.width; canvasH = Math.round(meta.width / ratio); }
      else { canvasH = meta.height; canvasW = Math.round(meta.height * ratio); }
      const contentW = Math.max(1, Math.round(canvasW * scale));
      const contentH = Math.max(1, Math.round(canvasH * scale));
      await img.resize({ width: contentW, height: contentH, fit: "contain", background: bg })
        .extend({
          top: Math.floor((canvasH - contentH) / 2), bottom: Math.ceil((canvasH - contentH) / 2),
          left: Math.floor((canvasW - contentW) / 2), right: Math.ceil((canvasW - contentW) / 2),
          background: bg
        }).jpeg({ quality: 95 }).toFile(outPath);
    }
  } else {
    // Film border: dark background + feathered inner edge via SVG overlay
    const darkBg = { r: 10, g: 10, b: 10 };
    let canvasW, canvasH, leftOffset, topOffset, contentW, contentH;

    if (aspectRatio === "Original") {
      const margin = Math.round(Math.max(meta.width, meta.height) * p);
      canvasW = meta.width + margin * 2;
      canvasH = meta.height + margin * 2;
      contentW = meta.width;
      contentH = meta.height;
      leftOffset = margin;
      topOffset = margin;
    } else {
      const ratio = aspectRatio === "1:1" ? 1 : 4 / 3;
      if (meta.width / meta.height > ratio) { canvasW = meta.width; canvasH = Math.round(meta.width / ratio); }
      else { canvasH = meta.height; canvasW = Math.round(meta.height * ratio); }
      contentW = Math.max(1, Math.round(canvasW * scale));
      contentH = Math.max(1, Math.round(canvasH * scale));
      leftOffset = Math.floor((canvasW - contentW) / 2);
      topOffset = Math.floor((canvasH - contentH) / 2);
    }

    // Build extended image on dark background
    let extendedBuf;
    if (aspectRatio === "Original") {
      extendedBuf = await sharp(inputPath).rotate()
        .extend({ top: topOffset, bottom: topOffset, left: leftOffset, right: leftOffset, background: darkBg })
        .png().toBuffer();
    } else {
      extendedBuf = await sharp(inputPath).rotate()
        .resize({ width: contentW, height: contentH, fit: "contain", background: darkBg })
        .extend({
          top: topOffset, bottom: canvasH - contentH - topOffset,
          left: leftOffset, right: canvasW - contentW - leftOffset,
          background: darkBg
        }).png().toBuffer();
    }

    // SVG overlay: feathered dark frame that bleeds slightly into the image edge
    const blurSize = Math.max(5, Math.round(Math.min(leftOffset, topOffset) * 0.08));
    const frameSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">` +
      `<defs><filter id="b" x="-30%" y="-30%" width="160%" height="160%">` +
      `<feGaussianBlur stdDeviation="${blurSize}"/></filter>` +
      `<mask id="m"><rect width="${canvasW}" height="${canvasH}" fill="white"/>` +
      `<rect x="${leftOffset}" y="${topOffset}" width="${contentW}" height="${contentH}" fill="black" filter="url(#b)"/>` +
      `</mask></defs>` +
      `<rect width="${canvasW}" height="${canvasH}" fill="rgb(10,10,10)" mask="url(#m)"/>` +
      `</svg>`
    );

    await sharp(extendedBuf)
      .composite([{ input: frameSvg, top: 0, left: 0 }])
      .jpeg({ quality: 95 }).toFile(outPath);
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