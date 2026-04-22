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

// フィルムゲートの不規則なエッジを表現する波形SVGパスを生成
function buildWavyPath(left, top, right, bottom, amp, step) {
  const pts = [];
  const w = right - left, h = bottom - top;
  for (let x = left; x <= right; x += step)
    pts.push(`${x.toFixed(1)},${(top  + amp * Math.sin((x - left) / w * 5 * Math.PI         )).toFixed(1)}`);
  for (let y = top + step; y <= bottom; y += step)
    pts.push(`${(right + amp * Math.sin((y - top)    / h * 7 * Math.PI + 1.0)).toFixed(1)},${y.toFixed(1)}`);
  for (let x = right; x >= left; x -= step)
    pts.push(`${x.toFixed(1)},${(bottom + amp * Math.sin((right - x)  / w * 6 * Math.PI + 2.0)).toFixed(1)}`);
  for (let y = bottom - step; y >= top; y -= step)
    pts.push(`${(left  + amp * Math.sin((bottom - y) / h * 4 * Math.PI + 0.5)).toFixed(1)},${y.toFixed(1)}`);
  return 'M ' + pts.join(' L ') + ' Z';
}

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
    // Film border: photo → dark extend with irregular inner edge → thin white outer border
    const darkBg = { r: 10, g: 10, b: 10 };
    const whiteBg = { r: 255, g: 255, b: 255 };
    const whitePx = Math.max(10, Math.round(Math.max(meta.width, meta.height) * 0.007));

    // EXIFローテーション後の実寸を取得
    const rotBuf = await sharp(inputPath).rotate().png().toBuffer();
    const rotMeta = await sharp(rotBuf).metadata();
    const imgW = rotMeta.width, imgH = rotMeta.height;

    let canvasW, canvasH, leftOffset, topOffset, contentW, contentH;
    if (aspectRatio === "Original") {
      const margin = Math.round(Math.max(imgW, imgH) * p);
      canvasW = imgW + margin * 2; canvasH = imgH + margin * 2;
      contentW = imgW; contentH = imgH;
      leftOffset = margin; topOffset = margin;
    } else {
      const ratio = aspectRatio === "1:1" ? 1 : 4 / 3;
      if (imgW / imgH > ratio) { canvasW = imgW; canvasH = Math.round(imgW / ratio); }
      else { canvasH = imgH; canvasW = Math.round(imgH * ratio); }
      contentW = Math.max(1, Math.round(canvasW * scale));
      contentH = Math.max(1, Math.round(canvasH * scale));
      leftOffset = Math.floor((canvasW - contentW) / 2);
      topOffset = Math.floor((canvasH - contentH) / 2);
    }

    // 暗背景に画像を配置
    let darkBuf;
    if (aspectRatio === "Original") {
      darkBuf = await sharp(rotBuf)
        .extend({ top: topOffset, bottom: topOffset, left: leftOffset, right: leftOffset, background: darkBg })
        .png().toBuffer();
    } else {
      darkBuf = await sharp(rotBuf)
        .resize({ width: contentW, height: contentH, fit: "contain", background: darkBg })
        .extend({
          top: topOffset, bottom: canvasH - contentH - topOffset,
          left: leftOffset, right: canvasW - contentW - leftOffset,
          background: darkBg
        }).png().toBuffer();
    }

    // 波形パスで不規則な内側エッジのSVGフレームを生成（フィルムゲート効果）
    const amp  = Math.max(5, Math.round(Math.min(contentW, contentH) * 0.004));
    const step = Math.max(3, Math.round(Math.min(contentW, contentH) * 0.004));
    const innerPath = buildWavyPath(leftOffset, topOffset, leftOffset + contentW, topOffset + contentH, amp, step);
    const frameSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">` +
      `<path fill-rule="evenodd" fill="rgb(10,10,10)"` +
      ` d="M 0,0 L ${canvasW},0 L ${canvasW},${canvasH} L 0,${canvasH} Z ${innerPath}"/>` +
      `</svg>`
    );

    await sharp(darkBuf)
      .composite([{ input: frameSvg, top: 0, left: 0 }])
      .extend({ top: whitePx, bottom: whitePx, left: whitePx, right: whitePx, background: whiteBg })
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