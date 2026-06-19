import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('smartgridAPI', {
  connectWebSocket: (url: string): void => {
    ipcRenderer.send('connect-ws', url);
  },
  onGooseMessage: (callback: (msg: unknown) => void): void => {
    ipcRenderer.on('goose-message', (_event, data) => callback(data));
  },
  onSvMessage: (callback: (msg: unknown) => void): void => {
    ipcRenderer.on('sv-message', (_event, data) => callback(data));
  },
  getConnectionStatus: (): Promise<unknown> => {
    return ipcRenderer.invoke('get-connection-status');
  },
});
