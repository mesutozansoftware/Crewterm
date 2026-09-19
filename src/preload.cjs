const { contextBridge, ipcRenderer } = require('electron');

const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = channel => fn => ipcRenderer.on(channel, (_e, data) => fn(data));

contextBridge.exposeInMainWorld('crewterm', {
  chooseProject: invoke('choose-project'),
  startAgent: invoke('start-agent'),
  stopAgent: invoke('stop-agent'),
  mergeAgent: invoke('merge-agent'),
  userMessage: invoke('user-message'),
  addTask: invoke('add-task'),
  getState: invoke('get-state'),
  ptyWrite: (name, data) => ipcRenderer.send('pty-write', { name, data }),
  ptyResize: (name, cols, rows) => ipcRenderer.send('pty-resize', { name, cols, rows }),
  onPtyData: listen('pty-data'),
  onPtyExit: listen('pty-exit'),
  onState: listen('state'),
});
