const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = [
  'drag-start', 'drag-move', 'drag-end',
  'resize-start', 'resize-move', 'resize-end',
  'toggle-mini', 'hide', 'ready', 'focus-session',
];

contextBridge.exposeInMainWorld('claudeFace', {
  send: (action) => {
    if (ACTIONS.includes(action)) ipcRenderer.send(action);
  },
  onUpdate: (callback) => ipcRenderer.on('update', (_event, data) => callback(data)),
});
