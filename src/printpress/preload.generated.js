// Generated from the actual PrintPress preload whitelist.
export function bindPreload(invoke, ipcRenderer) { return {
  // 连通性
  ping: () => invoke('app:ping'),

  // 数据目录信息
  getEnv: () => invoke('app:env'),

  // 数据目录自定义
  changeDataDir: () => invoke('app:changeDataDir'),
  resetDataDir: () => invoke('app:resetDataDir'),
  openDataDir: () => invoke('app:openDataDir'),
  relaunchApp: () => invoke('app:relaunch'),

  // 系统缓存：大小查询与一键释放
  getCacheInfo: () => invoke('app:cacheInfo'),
  clearCache: () => invoke('app:clearCache'),

  // 版本与更新：meta 为版本号 + 出口链接；checkUpdate 手动触发检测；
  // onUpdateAvailable 订阅启动自动检测结果（返回退订函数）
  getAppMeta: () => invoke('app:meta'),
  checkUpdate: () => invoke('app:checkUpdate'),
  onUpdateAvailable: (cb) => {
    const handler = (_e, info) => cb(info)
    ipcRenderer.on('update:available', handler)
    return () => ipcRenderer.removeListener('update:available', handler)
  },
  // 应用内更新：startUpdate 真正开始后台下载（以前只有徽标提示、没有下载入口），
  // installUpdate 在下载完成后重启安装，onUpdateState 订阅阶段与失败原因
  startUpdate: () => invoke('app:startUpdate'),
  installUpdate: () => invoke('app:installUpdate'),
  onUpdateState: (cb) => {
    const handler = (_e, state) => cb(state)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  },

  // 通用 JSON 存储（后续被领域通道取代，M1 起逐步收敛）
  loadData: (name) => invoke('store:load', name),
  saveData: (name, value) => invoke('store:save', name, value),

  // 数据集
  importDatasetDialog: () => invoke('dataset:importDialog'),
  inspectFile: (filePath) => invoke('dataset:inspect', filePath),
  importSheets: (payload) => invoke('dataset:importSheets', payload),
  /** 订阅导入进度；返回取消订阅函数 */
  onImportProgress: (cb) => {
    const handler = (_e, p) => cb(p)
    ipcRenderer.on('import:progress', handler)
    return () => ipcRenderer.removeListener('import:progress', handler)
  },
  listDatasets: () => invoke('dataset:list'),
  getDataset: (id) => invoke('dataset:get', id),
  deleteDataset: (id) => invoke('dataset:delete', id),
  deleteBatch: (ids) => invoke('dataset:deleteBatch', { ids }),
  renameColumn: (id, key, alias) => invoke('dataset:renameColumn', id, key, alias),
  updateCell: (datasetId, rowIndex, key, value) =>
    invoke('dataset:updateCell', { datasetId, rowIndex, key, value }),
  addRow: (id) => invoke('dataset:addRow', id),
  deleteRow: (datasetId, rowIndex) => invoke('dataset:deleteRow', { datasetId, rowIndex }),
  setColumnPrint: (datasetId, key, printOn) =>
    invoke('dataset:setColumnPrint', { datasetId, key, printOn }),
  fieldCatalog: (id) => invoke('catalog:fields', id),

  importPhotoFolder: (payload) => invoke('photo:importDialog', payload),
  commitPhotoFolder: (token, taskId) => invoke('photo:commitSelection', { token, taskId }),
  cancelPhotoSelection: (token) => invoke('photo:cancelSelection', { token }),
  cancelPhotoImport: (taskId) => invoke('photo:cancelImport', { taskId }),
  photoImportTasks: (datasetId) => invoke('photo:tasks', datasetId ? { datasetId } : {}),
  photoReport: (payload) => invoke('photo:report', payload),
  deletePhotos: (payload) => invoke('photo:delete', payload),
  getPhotoProcessing: (query) => invoke('photo:processingGet', typeof query === 'string' ? { datasetId: query } : query),
  previewPhotoProcessing: (payload) => invoke('photo:processingPreview', payload),
  applyPhotoProcessing: (payload) => invoke('photo:processingApply', payload),
  cancelPhotoProcessing: (payload) => invoke('photo:processingCancel', payload),
  clearPhotoProcessing: (datasetId) => invoke('photo:processingClear', { datasetId }),
  savePhotoProcessingPreset: (payload) => invoke('photo:processingPresetSave', payload),
  deletePhotoProcessingPreset: (id) => invoke('photo:processingPresetDelete', { id }),
  setPhotoProcessingOptions: (payload) => invoke('photo:processingOptions', payload),
  setSinglePhotoProcessing: (payload) => invoke('photo:processingSingleSet', payload),
  clearSinglePhotoProcessing: (payload) => invoke('photo:processingSingleClear', payload),
  reviewPhotoProcessing: (payload) => invoke('photo:processingReview', payload),
  onPhotoProcessingProgress: (callback) => { const listener = (_event, payload) => callback(payload); ipcRenderer.on('photo:processingProgress', listener); return () => ipcRenderer.removeListener('photo:processingProgress', listener) },
  exportPhotoIssues: (payload) => invoke('photo:exportIssues', payload),
  getPhotoOverride: (payload) => invoke('photo:overrideGet', payload),
  setPhotoOverride: (payload) => invoke('photo:overrideSet', payload),
  clearPhotoOverride: (payload) => invoke('photo:overrideClear', payload),
  getRecordDesign: (payload) => invoke('print:recordDesignGet', payload),
  setRecordDesign: (payload) => invoke('print:recordDesignSet', payload),
  clearRecordDesign: (payload) => invoke('print:recordDesignClear', payload),
  setPhotoMatchColumn: (datasetId, key) => invoke('dataset:setPhotoMatchColumn', { datasetId, key }),
  onPhotoProgress: (cb) => {
    const handler = (_e, progress) => cb(progress)
    ipcRenderer.on('photo:progress', handler)
    return () => ipcRenderer.removeListener('photo:progress', handler)
  },

  // 模板
  listTemplates: () => invoke('template:list'),
  getTemplate: (id) => invoke('template:get', id),
  saveTemplate: (tpl) => invoke('template:save', tpl),
  matchDataset: (templateId, datasetId) => invoke('template:matchDataset', templateId, datasetId),
  rebindDataset: (templateId, datasetId) => invoke('template:rebindDataset', templateId, datasetId),
  deleteTemplate: (id) => invoke('template:delete', id),
  uploadBackgroundDialog: () => invoke('template:uploadBackgroundDialog'),
  uploadBackgroundBytes: (payload) => invoke('template:uploadBackgroundBytes', payload),
  discardBackground: (payload) => invoke('template:discardBackground', payload),

  // 可编辑底图工程（素材只走受控导入，不暴露文件系统）
  listDesigns: () => invoke('design:list'),
  listDesignPresets: () => invoke('design:listPresets'),
  createDesignFromPreset: (presetId, name) => invoke('design:createFromPreset', presetId, name),
  touchDesign: (id) => invoke('design:touch', id),
  getDesign: (id, revision) => invoke('design:get', id, revision),
  saveDesign: (design, recordOwner) => invoke('design:save', design, recordOwner),
  deleteDesign: (id) => invoke('design:delete', id),
  purgeOrphanDesigns: () => invoke('design:purgeOrphanDirs'),
  uploadDesignImageDialog: () => invoke('design:importDialog'),
  uploadDesignImageBytes: (payload) => invoke('design:importBytes', payload),
  importDesignBackground: (payload) => invoke('design:importBackground', payload),
  exportDesignPng: (payload) => invoke('design:exportPng', payload),
  samplePixel: (x, y) => invoke('design:samplePixel', { x, y }),
  // 无参：路径由主进程记着（最近一次成功导出的 PNG），渲染层传不了路径进来
  revealDesignExport: () => invoke('design:revealExport'),
  openDesignExport: () => invoke('design:openExport'),

  // 工程包 .ppdesign（v0.5.0 M2）：导出固定版本 / 检查 → 提交导入副本
  exportDesignPackage: (payload) => invoke('design:packageExport', payload),
  cancelExportDesignPackage: (taskId) => invoke('design:packageCancelExport', { taskId }),
  onDesignPackageProgress: (cb) => {
    const handler = (_e, progress) => cb(progress)
    ipcRenderer.on('design:packageProgress', handler)
    return () => ipcRenderer.removeListener('design:packageProgress', handler)
  },
  inspectDesignPackage: (payload) => invoke('design:packageInspect', payload || {}),
  commitDesignPackage: (payload) => invoke('design:packageCommit', payload),
  cancelDesignPackage: (token) => invoke('design:packageCancel', { token }),
  pickPackageFont: () => invoke('design:packagePickFont'),

  // 字体
  listFonts: () => invoke('font:list'),
  uploadFontDialog: () => invoke('font:uploadDialog'),
  deleteFont: (file) => invoke('font:delete', file),

  // 本地素材库（v0.5.0 M1）
  listAssets: (opts) => invoke('asset:list', opts || {}),
  listAssetTags: () => invoke('asset:listTags'),
  getAsset: (id) => invoke('asset:get', id),
  importAssetBytes: (payload) => invoke('asset:importBytes', payload),
  importAssetDialog: () => invoke('asset:importDialog'),
  updateAsset: (id, patch) => invoke('asset:update', id, patch),
  archiveAsset: (id) => invoke('asset:archive', id),
  restoreAsset: (id) => invoke('asset:restore', id),
  adoptAsset: (id, meta) => invoke('asset:adopt', id, meta),
  discardEphemeralAsset: (assetId, exceptDesignId) => invoke('asset:discardEphemeral', { assetId, exceptDesignId }),
  rebuildAssetThumb: (id) => invoke('asset:rebuildThumb', id),
  listAssetOrphans: (protectedIds) => invoke('asset:listOrphans', { protectedIds }),
  purgeAssetOrphans: (hashes, protectedIds) => invoke('asset:purgeOrphans', { hashes, protectedIds }),
  assetUsage: () => invoke('asset:usage'),
  openAssetFolder: () => invoke('asset:openFolder'),

  // 打印
  printValidate: (payload) => invoke('print:validate', payload),
    printPhotoPreflight: (payload) => invoke('print:photoPreflight', payload),
  printGenerate: (payload) => invoke('print:generate', payload),
  printExportPdf: (payload) => invoke('print:exportPdf', payload),
  printExportImages: (payload) => invoke('print:exportImages', payload),
  printSend: (payload) => invoke('print:send', payload),
  /** 取消进行中的打印/导出（S1.3-c）：批次边界生效，见 print:cancel */
  printCancel: (jobKey) => invoke('print:cancel', { jobKey }),
  /** 订阅分批出片进度（jobKey / phase / index / batches / rows / pages…）；返回退订函数 */
  onPrintProgress: (cb) => {
    const handler = (_e, p) => cb(p)
    ipcRenderer.on('print:progress', handler)
    return () => ipcRenderer.removeListener('print:progress', handler)
  },

  // 打印历史
  listJobs: () => invoke('job:list'),
  openSnapshot: (jobId) => invoke('job:openSnapshot', jobId),
  deleteJob: (jobId) => invoke('job:delete', jobId),
}; }
