/* VidGrab Desktop — renderer bridge.
   Context-isolated and sandboxed. The page gets exactly the downloader API it
   needs and no general Electron or Node surface. */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* Only these channels may be subscribed to, so the page cannot listen to
   arbitrary IPC. Each returns its own unsubscribe function. */
const EVENTS = ['vg:progress', 'vg:done', 'vg:error', 'vg:cancelled', 'vg:engine', 'vg:shortcut', 'vg:fatal'];

contextBridge.exposeInMainWorld('vidgrab', {
  isDesktop: true,
  info: (url) => ipcRenderer.invoke('vg:info', String(url || '')),
  start: (url, formatId) => ipcRenderer.invoke('vg:start', String(url || ''), String(formatId || 'best')),
  cancel: () => ipcRenderer.invoke('vg:cancel'),
  paste: () => ipcRenderer.invoke('vg:paste'),
  reveal: (file) => ipcRenderer.invoke('vg:reveal', String(file || '')),
  getDir: () => ipcRenderer.invoke('vg:getDir'),
  chooseDir: () => ipcRenderer.invoke('vg:chooseDir'),
  version: () => ipcRenderer.invoke('vg:version'),
  on: (channel, fn) => {
    if (EVENTS.indexOf(channel) === -1 || typeof fn !== 'function') return function () {};
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return function () { ipcRenderer.removeListener(channel, handler); };
  },
});
