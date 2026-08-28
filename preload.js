const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toolbarAPI', {
  goBack: () => ipcRenderer.send('nav-back'),
  goForward: () => ipcRenderer.send('nav-forward'),
  reload: () => ipcRenderer.send('nav-reload'),
  goHome: () => ipcRenderer.send('nav-home'),
  switchTab: (id) => ipcRenderer.send('switch-tab', id),
  closeTab: (id) => ipcRenderer.send('close-tab', id),
  openSettings: () => ipcRenderer.send('open-settings'),
  openHistory: () => ipcRenderer.send('open-history-window'),
  onNavState: (callback) => {
    ipcRenderer.on('nav-state', (_event, state) => callback(state));
  },
  onTabsState: (callback) => {
    ipcRenderer.on('tabs-state', (_event, tabsList) => callback(tabsList));
  },
});
