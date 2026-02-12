const { ipcRenderer } = require("electron");
const Konva = window.Konva;

const pickBtn = document.getElementById("pickBtn");
const outBtn = document.getElementById("outBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const saveBtn = document.getElementById("saveBtn");
const fitBtn = document.getElementById("fitBtn");
const resetBtn = document.getElementById("resetBtn");
const toggleRatioBtn = document.getElementById("toggleRatioBtn");
const counter = document.getElementById("counter");
const stageHost = document.getElementById("stageHost");
const pathLabel = document.getElementById("pathLabel");

let files = [];
let idx = -1;
let outDir = null;
let aspectRatio = "4:3";

let stage, layer, imgNode, cropRect;
let fit = { x: 0, y: 0, w: 0, h: 0, scale: 1 };

function initStage() {
  stage = new Konva.Stage({ container: "stageHost", width: 1100, height: 640 });
  layer = new Konva.Layer();
  stage.add(layer);
  
  imgNode = new Konva.Image();
  layer.add(imgNode);
  
  cropRect = new Konva.Rect({ stroke: "#4da3ff", strokeWidth: 2, draggable: true });
  layer.add(cropRect);
}
initStage();

async function load(i) {
  if (i < 0 || i >= files.length) return;
  const dataURL = await ipcRenderer.invoke("read-image-dataurl", files[i]);
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(stage.width() / img.naturalWidth, stage.height() / img.naturalHeight);
    fit = {
      w: img.naturalWidth * scale,
      h: img.naturalHeight * scale,
      x: (stage.width() - img.naturalWidth * scale) / 2,
      y: (stage.height() - img.naturalHeight * scale) / 2,
      scale
    };
    imgNode.image(img).position({ x: fit.x, y: fit.y }).size({ width: fit.w, height: fit.h });
    updateUI();
    layer.draw();
  };
  img.src = dataURL;
}

function updateUI() {
  const hasFiles = files.length > 0;
  const hasOutDir = outDir !== null;
  
  // 画像があれば有効化
  outBtn.disabled = !hasFiles;
  toggleRatioBtn.disabled = !hasFiles;
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx >= files.length - 1;
  resetBtn.disabled = !hasFiles;

  // 画像と保存先があれば有効化
  saveBtn.disabled = !(hasFiles && hasOutDir);
  fitBtn.disabled = !(hasFiles && hasOutDir);
  
  counter.textContent = `(${idx + 1}/${files.length})`;
  pathLabel.textContent = files[idx] || "";
  
  if (aspectRatio === "Original") {
    cropRect.hide();
    fitBtn.textContent = "均一な白枠を追加";
  } else {
    cropRect.show();
    fitBtn.textContent = `${aspectRatio}白枠の中に縮小配置`;
    
    let cw, ch;
    const ratio = aspectRatio === "1:1" ? 1 : 4/3;
    if (fit.w / fit.h > ratio) {
      ch = fit.h; cw = ch * ratio;
    } else {
      cw = fit.w; ch = cw / ratio;
    }
    cropRect.size({ width: cw, height: ch }).position({
      x: fit.x + (fit.w - cw) / 2,
      y: fit.y + (fit.h - ch) / 2
    });
  }
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

toggleRatioBtn.onclick = () => {
  if (aspectRatio === "4:3") aspectRatio = "1:1";
  else if (aspectRatio === "1:1") aspectRatio = "Original";
  else aspectRatio = "4:3";
  toggleRatioBtn.textContent = `比率: ${aspectRatio}`;
  updateUI();
  layer.draw();
};

saveBtn.onclick = async () => {
  const rect = {
    x: (cropRect.x() - fit.x) / fit.scale,
    y: (cropRect.y() - fit.y) / fit.scale,
    width: cropRect.width() / fit.scale,
    height: cropRect.height() / fit.scale
  };
  await ipcRenderer.invoke("crop-save", { inputPath: files[idx], outDir, rect, aspectRatio });
  if (idx < files.length - 1) { idx++; await load(idx); }
};

fitBtn.onclick = async () => {
  fitBtn.disabled = true;
  await ipcRenderer.invoke("fit-save", { inputPath: files[idx], outDir, aspectRatio });
  if (idx < files.length - 1) { idx++; await load(idx); }
  else { fitBtn.disabled = false; updateUI(); }
};

prevBtn.onclick = async () => { if (idx > 0) { idx--; await load(idx); } };
nextBtn.onclick = async () => { if (idx < files.length - 1) { idx++; await load(idx); } };

resetBtn.onclick = () => { updateUI(); layer.draw(); };
