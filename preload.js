const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lcuAPI', {
  openFile: () => ipcRenderer.invoke('open-file-dialog'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  saveFile: (opts) => ipcRenderer.invoke('save-file-dialog', opts),
  saveAup: (opts) => ipcRenderer.invoke('save-aup-dialog', opts),
  linkAudioFolder: () => ipcRenderer.invoke('link-audio-folder'),
  getAudioState: () => ipcRenderer.invoke('get-audio-state')
});