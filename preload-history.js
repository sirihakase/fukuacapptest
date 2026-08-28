const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('historyAPI', {
  getHistory: () => ipcRenderer.invoke('get-history'),
  openUrl: (url) => ipcRenderer.send('open-history-url', url),
  clearHistory: () => ipcRenderer.send('clear-history'),
  onUpdated: (callback) => {
    ipcRenderer.on('history-updated', (_event, list) => callback(list));
  },
});
