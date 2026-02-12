const { ipcRenderer } = require("electron");
const Konva = window.Konva;

const pickBtn = document.getElementById("pickBtn");
const outBtn = document.getElementById("outBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const saveBtn = document.getElementById("saveBtn");
const fitBtn = document.getElementById("fitBtn");
const batchBtn = document.getElementById("batchBtn");
const resetBtn = document.getElementById("resetBtn");
const toggleRatioBtn = document.getElementById("toggleRatioBtn");
const borderSlider = document.getElementById("borderSlider");
const borderValue = document.getElementById("borderValue");
const counter = document.getElementById("counter");
const stageHost = document.getElementById("stageHost");
const pathLabel = document.getElementById("pathLabel");

let files = [];
let idx = -1;
let outDir = null;
let aspectRatio = "Original"; // デフォルトを「元の比率」に変更
let borderPercent = 5;

let stage, layer, imgNode, bgRect;
let fit = { x: 0, y: 0, w: 0, h: 0, scale: 1 };

function initStage() {
  stage = new Konva.Stage({ container: "stageHost", width: 1100, height: 640 });
  layer = new Konva.Layer();
  stage.add(layer);
  
  // 白枠のプレビュー用背景
  bgRect = new Konva.Rect({ fill: "white", shadowBlur: 10, shadowOpacity: 0.3 });
  layer.add(bgRect);
  
  imgNode = new Konva.Image();
  layer.add(imgNode);
}
initStage();

borderSlider.oninput = () => {
  borderPercent = parseInt(borderSlider.value);
  borderValue.textContent = `${borderPercent}%`;
  updateUI();
  layer.draw();
};

// 画像読み込みをPromise化して確実に待機できるようにする
async function load(i) {
  if (i < 0 || i >= files.length) return;
  const dataURL = await ipcRenderer.invoke("read-image-dataurl", files[i]);
  
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // プレビュー領域に収まるようにリサイズ（白枠分を考慮して少し小さめに表示）
      const padding = 40;
      const availableW = stage.width() - padding * 2;
      const availableH = stage.height() - padding * 2;
      
      const scale = Math.min(availableW / img.naturalWidth, availableH / img.naturalHeight);
      fit = {
        w: img.naturalWidth * scale,
        h: img.naturalHeight * scale,
        x: (stage.width() - img.naturalWidth * scale) / 2,
        y: (stage.height() - img.naturalHeight * scale) / 2,
        scale,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight
      };
      
      imgNode.image(img);
      updateUI();
      layer.draw();
      resolve();
    };
    img.src = dataURL;
  });
}

function updateUI() {
  const hasFiles = files.length > 0;
  const hasOutDir = outDir !== null;
  
  outBtn.disabled = !hasFiles;
  toggleRatioBtn.disabled = !hasFiles;
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx >= files.length - 1;
  resetBtn.disabled = !hasFiles;
  saveBtn.disabled = !(hasFiles && hasOutDir);
  fitBtn.disabled = !(hasFiles && hasOutDir);
  batchBtn.disabled = !(hasFiles && hasOutDir);
  
  toggleRatioBtn.textContent = `比率: ${aspectRatio === "Original" ? "元のまま" : aspectRatio}`;
  counter.textContent = `(${idx + 1}/${files.length})`;
  pathLabel.textContent = files[idx] || "";
  
  if (!fit.w) return;

  const p = borderPercent / 100;
  let canvasW, canvasH;

  if (aspectRatio === "Original") {
    // 元の比率：画像サイズ + 指定%の余白
    const margin = Math.max(fit.w, fit.h) * p;
    canvasW = fit.w + margin * 2;
    canvasH = fit.h + margin * 2;
  } else {
    // 4:3 / 1:1：指定比率の枠の中に画像を収める
    const targetRatio = aspectRatio === "1:1" ? 1 : 4/3;
    if (fit.w / fit.h > targetRatio) {
      canvasW = fit.w / (1 - p * 2);
      canvasH = canvasW / targetRatio;
    } else {
      canvasH = fit.h / (1 - p * 2);
      canvasW = canvasH * targetRatio;
    }
  }

  // プレビューの白い四角（白枠）を更新
  bgRect.size({ width: canvasW, height: canvasH }).position({
    x: (stage.width() - canvasW) / 2,
    y: (stage.height() - canvasH) / 2
  });

  // 画像を中央に配置
  imgNode.size({ width: fit.w, height: fit.h }).position({
    x: (stage.width() - fit.w) / 2,
    y: (stage.height() - fit.h) / 2
  });
}

pickBtn.onclick = async () => {
  const res = await ipcRenderer.invoke("pick-images");
  if (!res.canceled) {
    files = res.files; idx = 0;
    await load(idx);
  }
};

outBtn.onclick = async () => {
  const res = await ipcRenderer.invoke("pick-output-dir");
  if (!res.canceled) {
    outDir = res.dir;
    updateUI();
  }
};

toggleRatioBtn.onclick = async () => {
  if (aspectRatio === "Original") aspectRatio = "4:3";
  else if (aspectRatio === "4:3") aspectRatio = "1:1";
  else aspectRatio = "Original";
  updateUI();
  layer.draw();
};

fitBtn.onclick = async () => {
  fitBtn.disabled = true;
  await ipcRenderer.invoke("fit-save", { inputPath: files[idx], outDir, aspectRatio, borderPercent });
  if (idx < files.length - 1) { idx++; await load(idx); }
  else { fitBtn.disabled = false; updateUI(); }
};

batchBtn.onclick = async () => {
  if (!confirm(`${files.length}枚すべての画像を現在の設定で保存しますか？`)) return;
  batchBtn.disabled = true;
  const originalText = batchBtn.textContent;
  
  for (let i = 0; i < files.length; i++) {
    batchBtn.textContent = `保存中 (${i + 1}/${files.length})...`;
    idx = i;
    await load(idx); // 読み込み完了を待機
    await ipcRenderer.invoke("fit-save", { inputPath: files[i], outDir, aspectRatio, borderPercent });
  }
  
  batchBtn.disabled = false;
  batchBtn.textContent = originalText;
  alert("一括保存が完了しました！");
  idx = 0;
  await load(idx);
};

prevBtn.onclick = async () => { if (idx > 0) { idx--; await load(idx); } };
nextBtn.onclick = async () => { if (idx < files.length - 1) { idx++; await load(idx); } };
resetBtn.onclick = () => { updateUI(); layer.draw(); };