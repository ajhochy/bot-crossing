const { contextBridge } = require('electron')

// The Rhythm receiver must provide a document-bound private channel and adapt the renderer's
// data requests. This preload exposes identity only until that channel is wired.
contextBridge.exposeInMainWorld('colonyEmbedded', Object.freeze({
  product: 'colony',
  electronMajor: Number(process.versions.electron?.split('.')[0]) || null,
}))
