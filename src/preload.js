const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  addGame: (game) => ipcRenderer.invoke('library:add', game),
  updateGame: (id, patch) => ipcRenderer.invoke('library:update', id, patch),
  removeGame: (id) => ipcRenderer.invoke('library:remove', id),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  launch: (id) => ipcRenderer.invoke('game:launch', id),
  openFolder: (id) => ipcRenderer.invoke('game:openFolder', id),
  pickGame: () => ipcRenderer.invoke('dialog:pickGame'),
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  fileIcon: (target) => ipcRenderer.invoke('game:icon', target),
  scan: () => ipcRenderer.invoke('scan:run'),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onChanged: (cb) => ipcRenderer.on('library:changed', cb),
});
