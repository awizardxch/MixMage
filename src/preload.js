const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('state:load'),
  save: (state) => ipcRenderer.invoke('state:save', state),
  addSource: (url) => ipcRenderer.invoke('source:add', url),
  removeSource: (id) => ipcRenderer.invoke('source:remove', id),
  cut: (opts) => ipcRenderer.invoke('clip:cut', opts),
  findHits: (opts) => ipcRenderer.invoke('source:hits', opts),
  search: (q) => ipcRenderer.invoke('yt:search', q),
  findSounds: (opts) => ipcRenderer.invoke('source:sounds', opts),
  level: (opts) => ipcRenderer.invoke('media:level', opts),
  bpm: (opts) => ipcRenderer.invoke('media:bpm', opts),
  saveRecording: (bytes, title) => ipcRenderer.invoke('rec:save', bytes, title),
  removeRecording: (id) => ipcRenderer.invoke('rec:remove', id),
  audio: (clipId) => ipcRenderer.invoke('clip:audio', clipId),
  removeClip: (clipId) => ipcRenderer.invoke('clip:remove', clipId),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, d) => cb(d)),
});
