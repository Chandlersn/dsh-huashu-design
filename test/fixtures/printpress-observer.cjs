'use strict'
// Test-only observer. It does not change PrintPress or register business methods.
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
if (process.env.HUASHU_PRINTPRESS_TEST_APP_DATA) app.setPath('appData', process.env.HUASHU_PRINTPRESS_TEST_APP_DATA)
app.on('browser-window-created', (_event, window) => {
  console.error('PRINTPRESS_TEST_WINDOW_CREATED', JSON.stringify({ id: window.id, visible: window.isVisible() }))
  window.on('show', () => console.error('PRINTPRESS_TEST_WINDOW_SHOWN', window.id))
})
require(path.resolve(__dirname, '../../lib/printpress-worker.cjs')).startWorker().then(() => {
  console.log('PRINTPRESS_TEST_DIAGNOSTIC')
  console.error('PRINTPRESS_TEST_STATE', JSON.stringify({ windows: BrowserWindow.getAllWindows().length, userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }))
})
