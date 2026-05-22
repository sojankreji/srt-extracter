const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('subtitleAPI', {
  pickVideoFile: () => ipcRenderer.invoke('pick-video-file'),
  listEmbeddedSubtitleTracks: (videoPath) => ipcRenderer.invoke('list-embedded-subtitle-tracks', videoPath),
  extractSubtitles: (payload) => ipcRenderer.invoke('extract-subtitles', payload),
  saveSrt: (defaultFileName, content) => ipcRenderer.invoke('save-srt', defaultFileName, content),
  onStatus: (handler) => {
    ipcRenderer.removeAllListeners('transcription-status');
    ipcRenderer.on('transcription-status', (_event, message) => handler(message));
  }
});
