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

// フィルムゲートの不規則なエッジをRGBAバッファで直接生成
function createFilmFrameRaw(canvasW, canvasH, leftOffset, topOffset, contentW, contentH, amp) {
  // 辺ごとに波形境界を事前計算（sin波を4辺で独立させて有機的に見せる）
  const topB    = new Float32Array(canvasW);
  const bottomB = new Float32Array(canvasW);
  for (let x = 0; x < canvasW; x++) {
    const t = Math.max(0, Math.min(1, (x - leftOffset) / contentW));
    topB[x]    = topOffset            + amp * Math.sin(t * 5 * Math.PI);
    bottomB[x] = topOffset + contentH + amp * Math.sin(t * 6 * Math.PI + 2.0);
  }
  const leftB  = new Float32Array(canvasH);
  const rightB = new Float32Array(canvasH);
  for (let y = 0; y < canvasH; y++) {
    const t = Math.max(0, Math.min(1, (y - topOffset) / contentH));
    leftB[y]  = leftOffset            + amp * Math.sin(t * 4 * Math.PI + 0.5);
    rightB[y] = leftOffset + contentW + amp * Math.sin(t * 7 * Math.PI + 1.0);
  }

  const buf = Buffer.alloc(canvasW * canvasH * 4, 0); // 初期値: 透明
  for (let y = 0; y < canvasH; y++) {
    const lb = leftB[y], rb = rightB[y];
    for (let x = 0; x < canvasW; x++) {
      // 4辺の波形境界すべての内側のみ写真エリア、それ以外は暗枠
      if (!(x > lb && x < rb && y > topB[x] && y < bottomB[x])) {
        const i = (y * canvasW + x) * 4;
        buf[i] = 10; buf[i + 1] = 10; buf[i + 2] = 10; buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

ipcMain.handle("fit-save", async (_, { inputPath, outDir, aspectRatio, borderPercent, borderType = "white" }) => {
  const name = path.basename(inputPath, path.extname(inputPath));
  const suffix = borderType === "film" ? "film" : borderType === "polaroid" ? "polaroid" : "white";
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
  } else if (borderType === "film") {
    // Film border: photo → dark extend with irregular inner edge → visible white outer border
    const darkBg  = { r: 10, g: 10, b: 10 };
    const whiteBg = { r: 255, g: 255, b: 255 };
    // 白枠: 長辺の1%（最小20px）でしっかり見える厚さに
    const whitePx = Math.max(20, Math.round(Math.max(meta.width, meta.height) * 0.01));

    // EXIFローテーション後の実寸を取得
    const rotBuf  = await sharp(inputPath).rotate().png().toBuffer();
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
      topOffset  = Math.floor((canvasH - contentH) / 2);
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

    // ピクセルバッファで不規則な内側エッジのフィルムゲートフレームを生成
    const amp      = Math.max(3, Math.round(Math.min(contentW, contentH) * 0.002));
    const frameBuf = createFilmFrameRaw(canvasW, canvasH, leftOffset, topOffset, contentW, contentH, amp);
    const frameImg = await sharp(frameBuf, { raw: { width: canvasW, height: canvasH, channels: 4 } })
      .png().toBuffer();

    // Step1: 暗枠にフィルムエッジを合成
    const withFrame = await sharp(darkBuf)
      .composite([{ input: frameImg, top: 0, left: 0 }])
      .png().toBuffer();
    // Step2: 確実に全辺に白枠を追加（チェーンすると適用されない場合があるため分離）
    await sharp(withFrame)
      .extend({ top: whitePx, bottom: whitePx, left: whitePx, right: whitePx, background: whiteBg })
      .jpeg({ quality: 95 }).toFile(outPath);

  } else if (borderType === "polaroid") {
    // ポラロイド: 上左右=均等白枠、下=2.5倍の白枠
    const whiteBg = { r: 255, g: 255, b: 255 };
    const rotBuf  = await sharp(inputPath).rotate().png().toBuffer();
    const rotMeta = await sharp(rotBuf).metadata();
    const imgW = rotMeta.width, imgH = rotMeta.height;

    // アスペクト比指定がある場合はまずコンテンツを合わせる
    let baseBuf, baseW, baseH;
    if (aspectRatio === "Original") {
      baseBuf = rotBuf; baseW = imgW; baseH = imgH;
    } else {
      const ratio = aspectRatio === "1:1" ? 1 : 4 / 3;
      if (imgW / imgH > ratio) { baseW = imgW; baseH = Math.round(imgW / ratio); }
      else { baseH = imgH; baseW = Math.round(imgH * ratio); }
      baseBuf = await sharp(rotBuf)
        .resize({ width: baseW, height: baseH, fit: "contain", background: whiteBg })
        .png().toBuffer();
    }

    const sidePx   = Math.max(10, Math.round(Math.min(baseW, baseH) * p));
    const bottomPx = Math.round(sidePx * 1.5);
    // Step1: 細い黒枠を内側に追加
    const darkPx = Math.max(4, Math.round(Math.min(baseW, baseH) * 0.004));
    const withDark = await sharp(baseBuf)
      .extend({ top: darkPx, left: darkPx, right: darkPx, bottom: darkPx, background: { r: 10, g: 10, b: 10 } })
      .png().toBuffer();
    // Step2: 白枠を外側に追加
    await sharp(withDark)
      .extend({ top: sidePx, left: sidePx, right: sidePx, bottom: bottomPx, background: whiteBg })
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