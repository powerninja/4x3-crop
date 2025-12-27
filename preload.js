const { contextBridge, ipcRenderer } = require("electron");
// const Konva = require("konva");

contextBridge.exposeInMainWorld("api", {
  pickImages: () => ipcRenderer.invoke("pick-images"),
  pickOutputDir: () => ipcRenderer.invoke("pick-output-dir"),
  cropSave: (payload) => ipcRenderer.invoke("crop-save", payload),
  getImageMetadata: (path) => ipcRenderer.invoke("get-image-metadata", path),
  readImageDataURL: (path) => ipcRenderer.invoke("read-image-dataurl", path),
});

// Konvaをrendererで使えるようにする
contextBridge.exposeInMainWorld("Konva", Konva);
