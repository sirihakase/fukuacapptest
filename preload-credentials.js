const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('credentialAPI', {
  save: (loginId, password) => ipcRenderer.invoke('save-credentials', { loginId, password }),
});
