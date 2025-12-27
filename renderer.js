// =====================================================
// duplicate-load safe guard（return / throw しない）
// =====================================================
window.__CROP_APP_INITED__ = window.__CROP_APP_INITED__ || false; // stage初期化済み
window.__CROP_APP_BOUND__ = window.__CROP_APP_BOUND__ || false; // イベント登録済み

console.log(
  "renderer.js loaded",
  "inited=",
  window.__CROP_APP_INITED__,
  "bound=",
  window.__CROP_APP_BOUND__
);

const Konva = window.Konva;
const { ipcRenderer } = require("electron");

/* ---------------- DOM ---------------- */
const pickBtn = document.getElementById("pickBtn");
const outBtn = document.getElementById("outBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const saveBtn = document.getElementById("saveBtn");
const resetBtn = document.getElementById("resetBtn");
const counter = document.getElementById("counter");
const stageHost = document.getElementById("stageHost");
const pathLabel = document.getElementById("pathLabel");

/* ---------------- 状態 ---------------- */
let files = [];
let idx = -1;
let outDir = null;

let stage, layer;
let imgNode, cropRect;
let maskTop, maskBottom, maskLeft, maskRight;
let gridLines = [];

let fit = { x: 0, y: 0, w: 0, h: 0, scale: 1 };

let isPickingImages = false;
let isPickingOutDir = false;
let isSaving = false;

/* ---------------- Stage初期化（1回だけ） ---------------- */
function initStage() {
  stageHost.innerHTML = "";

  stage = new Konva.Stage({
    container: "stageHost",
    width: stageHost.clientWidth,
    height: stageHost.clientHeight,
  });

  layer = new Konva.Layer();
  stage.add(layer);

  // 背景
  layer.add(
    new Konva.Rect({
      x: 0,
      y: 0,
      width: stage.width(),
      height: stage.height(),
      fill: "#111",
    })
  );

  imgNode = new Konva.Image();
  layer.add(imgNode);

  // マスク（イベント無視）
  maskTop = new Konva.Rect({ fill: "rgba(0,0,0,0.5)", listening: false });
  maskBottom = new Konva.Rect({ fill: "rgba(0,0,0,0.5)", listening: false });
  maskLeft = new Konva.Rect({ fill: "rgba(0,0,0,0.5)", listening: false });
  maskRight = new Konva.Rect({ fill: "rgba(0,0,0,0.5)", listening: false });
  layer.add(maskTop, maskBottom, maskLeft, maskRight);

  // 3x3 グリッド
  gridLines = [];
  for (let i = 0; i < 4; i++) {
    const line = new Konva.Line({
      stroke: "rgba(255,255,255,0.6)",
      strokeWidth: 1,
      listening: false,
    });
    gridLines.push(line);
    layer.add(line);
  }

  // クロップ枠（4:3 固定・移動のみ）
  cropRect = new Konva.Rect({
    stroke: "#4da3ff",
    strokeWidth: 2,
    draggable: true,
  });
  layer.add(cropRect);

  cropRect.on("dragmove", () => {
    clampCropRect();
    updateMask();
    updateGrid();
    layer.batchDraw();
  });

  layer.draw();
}

if (!window.__CROP_APP_INITED__) {
  window.__CROP_APP_INITED__ = true;
  initStage();
}

/* ---------------- UI ---------------- */
function setUIEnabled(enabled) {
  prevBtn.disabled = !enabled || idx <= 0;
  nextBtn.disabled = !enabled || idx >= files.length - 1;
  saveBtn.disabled = !enabled || !outDir;
  resetBtn.disabled = !enabled;
  outBtn.disabled = !enabled;
}

function updateCounter() {
  counter.textContent = files.length ? `(${idx + 1}/${files.length})` : "(0/0)";
  pathLabel.textContent = files[idx] || "";
}

/* ---------------- イベント登録（1回だけ） ---------------- */
if (!window.__CROP_APP_BOUND__) {
  window.__CROP_APP_BOUND__ = true;

  // ---- 画像選択 ----
  pickBtn.addEventListener("click", async () => {
    if (isPickingImages) return;
    isPickingImages = true;
    pickBtn.disabled = true;

    try {
      const res = await ipcRenderer.invoke("pick-images");
      if (res.canceled) return;

      files = res.files;
      idx = 0;

      // 自動的に保存先ダイアログを開かないようコメントアウト
      // if (!outDir) {
      //   if (!isPickingOutDir) {
      //     isPickingOutDir = true;
      //     try {
      //       const out = await ipcRenderer.invoke("pick-output-dir");
      //       if (!out.canceled) outDir = out.dir;
      //     } finally {
      //       isPickingOutDir = false;
      //     }
      //   }
      // }

      updateCounter();
      await load(idx);
    } finally {
      isPickingImages = false;
      pickBtn.disabled = false;
    }
  });

  // ---- 保存先 ----
  outBtn.addEventListener("click", async () => {
    if (isPickingOutDir) return;
    isPickingOutDir = true;
    outBtn.disabled = true;
    try {
      const out = await ipcRenderer.invoke("pick-output-dir");
      if (!out.canceled) outDir = out.dir;
      setUIEnabled(true);
    } finally {
      isPickingOutDir = false;
      outBtn.disabled = false;
    }
  });

  // ---- ナビ ----
  prevBtn.addEventListener("click", async () => {
    if (idx <= 0) return;
    idx--;
    updateCounter();
    await load(idx);
  });

  nextBtn.addEventListener("click", async () => {
    if (idx >= files.length - 1) return;
    idx++;
    updateCounter();
    await load(idx);
  });

  // ---- リセット ----
  resetBtn.addEventListener("click", () => {
    setInitialCropBox();
    updateMask();
    updateGrid();
    layer.draw();
  });

  // ---- 保存 ----
  saveBtn.addEventListener("click", saveCurrent);

  // ---- ショートカット ----
  window.addEventListener("keydown", async (e) => {
    if (!files.length) return;
    if (e.key === "ArrowLeft") prevBtn.click();
    if (e.key === "ArrowRight") nextBtn.click();
    if (e.key === "Enter") await saveCurrent();
  });

  // ---- リサイズ ----
  window.addEventListener("resize", () => {
    if (files.length && idx >= 0) load(idx);
  });
}

/* ---------------- 画像ロード ---------------- */
async function load(i) {
  setUIEnabled(false);

  const inputPath = files[i];
  const dataURL = await ipcRenderer.invoke("read-image-dataurl", inputPath);

  const img = new Image();
  img.onload = () => {
    const W = stage.width();
    const H = stage.height();

    const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const x = (W - w) / 2;
    const y = (H - h) / 2;

    fit = { x, y, w, h, scale };

    imgNode.image(img);
    imgNode.position({ x, y });
    imgNode.size({ width: w, height: h });

    setInitialCropBox();
    clampCropRect();
    updateMask();
    updateGrid();

    updateCounter();
    setUIEnabled(true);
    layer.draw();
  };
  img.src = dataURL;
}

/* ---------------- 初期クロップ（上下ピッタリ4:3） ---------------- */
function setInitialCropBox() {
  let cropH = fit.h;
  let cropW = (cropH * 4) / 3;

  if (cropW > fit.w) {
    cropW = fit.w;
    cropH = (cropW * 3) / 4;
  }

  cropRect.position({
    x: fit.x + (fit.w - cropW) / 2,
    y: fit.y + (fit.h - cropH) / 2,
  });
  cropRect.size({ width: cropW, height: cropH });
}

/* ---------------- 制限 ---------------- */
function clampCropRect() {
  let x = cropRect.x();
  let y = cropRect.y();
  const w = cropRect.width();
  const h = cropRect.height();

  const minX = fit.x;
  const minY = fit.y;
  const maxX = fit.x + fit.w - w;
  const maxY = fit.y + fit.h - h;

  x = Math.max(minX, Math.min(x, maxX));
  y = Math.max(minY, Math.min(y, maxY));

  cropRect.position({ x, y });
}

/* ---------------- マスク ---------------- */
function updateMask() {
  const x = cropRect.x();
  const y = cropRect.y();
  const w = cropRect.width();
  const h = cropRect.height();

  maskTop.setAttrs({ x: 0, y: 0, width: stage.width(), height: y });
  maskBottom.setAttrs({
    x: 0,
    y: y + h,
    width: stage.width(),
    height: stage.height() - (y + h),
  });
  maskLeft.setAttrs({ x: 0, y, width: x, height: h });
  maskRight.setAttrs({
    x: x + w,
    y,
    width: stage.width() - (x + w),
    height: h,
  });
}

/* ---------------- 3x3 グリッド ---------------- */
function updateGrid() {
  const x = cropRect.x();
  const y = cropRect.y();
  const w = cropRect.width();
  const h = cropRect.height();

  gridLines[0].points([x + w / 3, y, x + w / 3, y + h]);
  gridLines[1].points([x + (w * 2) / 3, y, x + (w * 2) / 3, y + h]);
  gridLines[2].points([x, y + h / 3, x + w, y + h / 3]);
  gridLines[3].points([x, y + (h * 2) / 3, x + w, y + (h * 2) / 3]);
}

/* ---------------- 保存 ---------------- */
async function saveCurrent() {
  if (isSaving || !outDir) return;
  isSaving = true;
  saveBtn.disabled = true;

  try {
    const rx = cropRect.x() - fit.x;
    const ry = cropRect.y() - fit.y;

    const rect = {
      x: rx / fit.scale,
      y: ry / fit.scale,
      width: cropRect.width() / fit.scale,
      height: cropRect.height() / fit.scale,
    };

    const res = await ipcRenderer.invoke("crop-save", {
      inputPath: files[idx],
      outDir,
      rect,
    });

    if (res.ok && idx < files.length - 1) {
      idx++;
      updateCounter();
      await load(idx);
    }
  } finally {
    isSaving = false;
    saveBtn.disabled = false;
  }
}
