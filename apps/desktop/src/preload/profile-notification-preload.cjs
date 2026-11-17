const { contextBridge, ipcRenderer } = require("electron");

// Dedicated to hidden notification windows; it exposes no app, setup, or system capabilities.
contextBridge.exposeInMainWorld("rakazoProfileNotification", {
  activateProfile: () => ipcRenderer.invoke("desktop.notifications.activateProfile"),
});
