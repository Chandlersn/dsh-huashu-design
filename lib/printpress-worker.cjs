#!/usr/bin/env node
'use strict'

/**
 * PrintPress Electron business host, with no application/main window.
 *
 * Launch <printpress>/node_modules/electron/dist/electron.exe <this file>, with
 * HUASHU_PRINTPRESS_ROOT set to the absolute PrintPress checkout. PRINTPRESS_DATA_DIR
 * and HUASHU_PRINTPRESS_USER_DATA may override business data and runtime cache
 * independently. stdout is NDJSON; diagnostics go to stderr. Windows Electron
 * itself emits an initial CRLF before JavaScript loads; ignore empty input lines.
 *
 * call:     {id, method:'call', name, args:[...preload positional arguments]}
 * invoke:   {id, method:'invoke', name, params:{...}, allowWrite:true|false}
 * media:    {id, method:'media', url:'pp://media/...'} -> {file,mime}
 * importImage: {id, method:'importImage',base64,name?} -> {asset}; preserve
 *   PNG/JPEG bytes and EXIF orientation, convert WebP only to validated PNG.
 * hostCapabilities: {id,method:'hostCapabilities',capabilities:status} updates AI.
 * hostImageResult: {id,method:'hostImageResult',requestId,result|error} resolves
 *   the matching {event:'host:imageRequest',payload:{requestId,operation,
 *   imageBase64,width,height,model,recipe?}}. Cutout result contains imageBase64;
 *   analyze result contains analysis.faces with pixel-space face/eye geometry.
 * host:imageCancel cancels parent provider work on timeout/cancel/EOF/shutdown.
 * shutdown: {id, method:'shutdown'} -> {stopped:true}, then exit after draining.
 * AI prefers HUASHU_PRINTPRESS_IMAGE_CAPABILITIES / capabilities updates. If
 * host cutout is absent, only the existing MODNet fast model may be used, unless
 * HUASHU_PRINTPRESS_LOCAL_FAST_FALLBACK=0. Face analysis remains host-only.
 * imageCapabilities returns {effective,host,fallback}; local-fast status and
 * cache identity are explicit. A host processing error never silently falls back.
 *
 * Never load PrintPress main.cjs/ipc.cjs: those register updates and create a main
 * window. Reuse their api, data lock, media registration, and host adapters.
 */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const MAX_INPUT_BYTES = 96 * 1024 * 1024
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const HOST_IMAGE_MISSING = '当前DSH宿主未注册抠图/人脸分析服务'
const { AsyncLocalStorage } = require('node:async_hooks')
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')
const FORBIDDEN_OPERATIONS = new Map([
  ['app:changeDataDir', '工作台中不能迁移批印坊数据目录，请关闭业务服务后在独立批印坊中设置。'],
  ['app:resetDataDir', '工作台中不能重置批印坊数据目录，请关闭业务服务后在独立批印坊中设置。'],
  ['app:relaunch', '工作台中不能重启批印坊或宿主，请通过工作台管理业务服务。'],
  ['app:startUpdate', '工作台中不能下载批印坊更新，请在独立批印坊中更新。'],
  ['app:installUpdate', '工作台中不能安装批印坊更新或重启宿主，请在独立批印坊中更新。'],
])

function failure(code, message) { return Object.assign(new Error(message), { code }) }
function errorInfo(error) {
  return { code: String(error?.code || 'ERROR'), message: String(error?.message || error || '操作失败') }
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function validId(id) { return (typeof id === 'string' && id.length > 0 && id.length <= 256) || Number.isSafeInteger(id) }
function validateRequest(request) {
  if (!record(request)) throw failure('BAD_REQUEST', '请求必须是 JSON 对象。')
  if (!validId(request.id)) throw failure('BAD_REQUEST', '请求 id 必须是安全整数或 1 至 256 字符的字符串。')
  if (!['call', 'invoke', 'media', 'shutdown', 'hostImageResult', 'hostCapabilities', 'imageCapabilities', 'importImage'].includes(request.method)) throw failure('UNKNOWN_METHOD', '未知请求方法，请使用 call、invoke、media、importImage、hostImageResult、hostCapabilities、imageCapabilities 或 shutdown。')
  if (request.method === 'call' || request.method === 'invoke') {
    if (typeof request.name !== 'string' || !request.name || request.name.length > 160) throw failure('BAD_PARAMS', '操作 name 必须是非空字符串。')
    if (request.method === 'call' && request.args !== undefined && (!Array.isArray(request.args) || request.args.length > 64)) throw failure('BAD_PARAMS', 'call.args 必须是最多 64 个位置参数的数组。')
    if (request.method === 'invoke' && request.params !== undefined && !record(request.params)) throw failure('BAD_PARAMS', 'invoke.params 必须是 JSON 参数对象。')
    if (request.method === 'invoke' && request.allowWrite !== undefined && typeof request.allowWrite !== 'boolean') throw failure('BAD_PARAMS', 'invoke.allowWrite 只能使用布尔值 true 或 false。')
  }
  if (request.method === 'media' && (typeof request.url !== 'string' || !request.url || request.url.length > 16 * 1024)) throw failure('BAD_PARAMS', 'media.url 必须是有效的 pp://media/ 地址。')
  if (request.method === 'hostImageResult') {
    if (typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 256 || (record(request.result) === record(request.error)) || (request.error && (typeof request.error.code !== 'string' || typeof request.error.message !== 'string'))) throw failure('BAD_PARAMS', 'hostImageResult 需要 requestId 及 result 或 error。')
  }
  if (request.method === 'hostCapabilities' && !record(request.capabilities)) throw failure('BAD_PARAMS', 'hostCapabilities 需要 capabilities 状态对象。')
  if (request.method === 'importImage') {
    if (request.filePath !== undefined || request.path !== undefined || (request.name !== undefined && (typeof request.name !== 'string' || request.name.length > 200))) throw failure('BAD_PARAMS', 'importImage 只接受 base64 和可选图片名称，不接受文件路径。')
    decodeBase64Image(request.base64)
  }
  return request
}

/** Byte-bounded line reader: concatenate once per frame; a rejected frame is
 * discarded through its next newline without retaining the oversized payload.
 * Exported so byte boundaries and recovery can be tested without Electron. */
function createNdjsonReader(input, { onRequest, onError, onEnd, maxBytes = MAX_INPUT_BYTES }) {
  let chunks = [], length = 0, discarding = false, ended = false
  function append(chunk) {
    if (discarding || !chunk.length) return
    length += chunk.length
    if (length > maxBytes) {
      chunks = []; length = 0; discarding = true
      onError(failure('INPUT_TOO_LARGE', `单条请求不能超过 ${maxBytes} 字节（生产上限 96 MiB）。`))
    } else chunks.push(chunk)
  }
  function finishLine() {
    if (discarding) { discarding = false; return }
    const line = Buffer.concat(chunks, length).toString('utf8').replace(/\r$/, '')
    chunks = []; length = 0
    if (!line.trim()) return
    let request
    try { request = JSON.parse(line) } catch { onError(failure('BAD_JSON', '请求不是合法的单行 JSON。')); return }
    onRequest(request)
  }
  function data(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let from = 0, end
    while ((end = buffer.indexOf(10, from)) !== -1) {
      append(buffer.subarray(from, end)); finishLine(); from = end + 1
    }
    append(buffer.subarray(from))
  }
  function end() {
    if (ended) return
    ended = true
    if (length || discarding) finishLine()
    onEnd()
  }
  input.on('data', data)
  input.once('end', end)
  input.once('close', end)
  return { close() { input.off('data', data); input.off('end', end); input.off('close', end); chunks = []; length = 0 } }
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.pdf': 'application/pdf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ttc': 'font/collection',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

/** The routing rules in PrintPress media-protocol.cjs, using its actual path resolvers.
 * That module exports registration only, so do not invent a second asset store.
 * Guard the raw path before WHATWG URL removes dot segments, and realpath-check
 * the result so a symlink/junction cannot turn this into arbitrary file reads. */
function resolveMedia(url, { load, dataDir }) {
  if (typeof url !== 'string' || !/^pp:\/\/media\//i.test(url) || /[\u0000-\u0020\u007f]/.test(url)) throw failure('BAD_MEDIA_URL', '媒体地址只能使用 pp://media/，不能读取任意本地文件。')
  const rawPath = url.replace(/^pp:\/\/media\//i, '').split(/[?#]/, 1)[0]
  let rel
  try { rel = decodeURIComponent(rawPath).replace(/\\/g, '/').replace(/^\/+/, '') } catch { throw failure('BAD_MEDIA_URL', '媒体地址编码无效。') }
  if (!rel || rel.split('/').includes('..') || /[\u0000-\u001f\u007f:]/.test(rel)) throw failure('MEDIA_FORBIDDEN', '媒体路径无效，不能越出批印坊数据目录。')
  let parsed
  try { parsed = new URL(url) } catch { throw failure('BAD_MEDIA_URL', '媒体地址格式无效。') }
  if (parsed.protocol !== 'pp:' || parsed.hostname !== 'media' || parsed.port || parsed.username || parsed.password) throw failure('BAD_MEDIA_URL', '媒体地址的协议或主机无效。')
  let file, allowedRoot = dataDir
  const storage = load('asset-storage.cjs')
  const assetMatch = /^asset_([a-f0-9]{64})$/.exec(rel)
  const poolMatch = /^(design-assets|ephemeral-assets|photo-assets)\/([a-f0-9]{64})\.(png|jpe?g)$/i.exec(rel)
  const assetPath = id => {
    const asset = load('designs.cjs').assetInfo(id)
    const resolved = storage.resolveAssetPath(asset.path)
    const pool = asset.path.split('/')[0], poolDir = storage.poolDir(pool)
    const relative = path.relative(path.resolve(dataDir), path.resolve(poolDir))
    const externalManagedPool = pool === 'design-assets' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    // Only the explicitly configured managed pool may live outside dataDir.
    // A default photo/ephemeral pool replaced with a junction must not silently
    // become a new authorized root merely because realpath follows that link.
    return { file: resolved, allowedRoot: externalManagedPool ? poolDir : dataDir }
  }
  try {
    if (assetMatch) ({ file, allowedRoot } = assetPath(`asset_${assetMatch[1]}`))
    else if (poolMatch) {
      try { ({ file, allowedRoot } = assetPath(`asset_${poolMatch[2]}`)) } catch { /* original protocol falls back to the data-relative path */ }
    }
    if (!file) file = load('store.cjs').resolveInsideDataDir(rel)
    const base = fs.realpathSync(allowedRoot)
    const canonical = fs.realpathSync(file)
    const inside = path.relative(base, canonical)
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw failure('MEDIA_FORBIDDEN', '媒体路径指向数据目录以外，已拒绝读取。')
    if (!fs.statSync(canonical).isFile()) throw failure('MEDIA_NOT_FOUND', '媒体文件不存在或不是普通文件。')
    return { file: canonical, mime: MIME[path.extname(canonical).toLowerCase()] || 'application/octet-stream' }
  } catch (error) {
    if (error.code === 'MEDIA_FORBIDDEN' || error.code === 'MEDIA_NOT_FOUND') throw error
    throw failure('MEDIA_NOT_FOUND', '媒体文件不存在或无法读取。')
  }
}

/** Plugin-owned reverse RPC. Every terminal path removes timer/listener/payload. */
function createHostImageRpc({ emit, timeoutMs = 120000, context = () => undefined }) {
  const pending = new Map()
  let sequence = 0, stopped = false
  function finish(requestId, error, result, notify = false) {
    const item = pending.get(requestId)
    if (!item) return false
    pending.delete(requestId); clearTimeout(item.timer)
    item.signal?.removeEventListener('abort', item.abort)
    if (notify) emit('host:imageCancel', { requestId, reason: errorInfo(error).message })
    error ? item.reject(error) : item.resolve(result)
    return true
  }
  function request(payload, { signal } = {}) {
    if (stopped) return Promise.reject(failure('HOST_IMAGE_ABORTED', '宿主图像通道已关闭。'))
    if (signal?.aborted) return Promise.reject(failure('HOST_IMAGE_ABORTED', '宿主图像处理已取消。'))
    const requestId = `host-image-${process.pid}-${++sequence}`
    return new Promise((resolve, reject) => {
      const abort = () => finish(requestId, failure('HOST_IMAGE_ABORTED', '宿主图像处理已取消。'), null, true)
      const timer = setTimeout(() => finish(requestId, failure('HOST_IMAGE_TIMEOUT', '等待 DSH 宿主图像服务超时，请检查提供方后重试。'), null, true), timeoutMs)
      pending.set(requestId, { resolve, reject, timer, signal, abort, owner: context() })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      emit('host:imageRequest', { requestId, ...payload })
    })
  }
  return {
    request,
    accept({ requestId, result, error }) { return finish(requestId, error ? failure(error.code, error.message) : null, result) },
    cancelWhere(predicate, error = failure('HOST_IMAGE_ABORTED', '宿主图像处理已取消。')) { for (const [id, item] of pending) if (predicate(item.owner)) finish(id, error, null, true) },
    close(error = failure('HOST_IMAGE_ABORTED', '业务服务已关闭，宿主图像处理已停止。')) { stopped = true; for (const id of pending.keys()) finish(id, error, null, true) },
    get size() { return pending.size },
  }
}
function normalizeHostCapabilities(value = {}) {
  if (!record(value)) throw failure('BAD_HOST_CAPABILITIES', '宿主图像能力状态无效。')
  const provider = typeof value.provider === 'string' && value.provider.length <= 256 ? value.provider : null
  const cutout = value.cutout === true, faceAlign = value.faceAlign === true
  if ((cutout || faceAlign) && !provider) throw failure('BAD_HOST_CAPABILITIES', '图像能力必须属于已注册的宿主提供方。')
  const providers = Array.isArray(value.providers) ? value.providers.map(p => {
    if (!record(p) || typeof p.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(p.id) || (p.version !== undefined && (typeof p.version !== 'string' || p.version.length > 128))) throw failure('BAD_HOST_CAPABILITIES', '宿主图像提供方身份无效。')
    return { id: p.id, cutout: p.cutout === true, faceAlign: p.faceAlign === true, ...(p.version === undefined ? {} : { version: p.version }) }
  }) : undefined
  return { source: 'dsh-host', localModels: false, cutout, faceAlign, provider, reason: provider ? String(value.reason || '') : HOST_IMAGE_MISSING, ...(providers?.length ? { providers } : {}) }
}
function hostImageIdentity(capabilities, fallbackReady = false) {
  const digest = require('node:crypto').createHash('sha256').update(JSON.stringify({ providers: capabilities.providers || { provider: capabilities.provider, cutout: capabilities.cutout, faceAlign: capabilities.faceAlign }, fallback: fallbackReady && !capabilities.cutout ? 'local-fast-modnet-07c308cf' : null })).digest('hex').slice(0, 24)
  return fallbackReady && !capabilities.cutout ? `local-fast-${digest}` : digest
}
/** Isolate derived AI state without touching the independent app's original
 * files. Options/presets and all source assets remain in their existing store. */
function scopePhotoStorage(store, identity) {
  const names = new Set(['photo-processing', 'photo-processing-cache', 'photo-processing-singles', 'photo-processing-jobs'])
  const loadJson = store.loadJson, saveJson = store.saveJson
  const nameFor = name => {
    if (!names.has(name)) return name
    const key = identity(), local = key.startsWith('local-fast-')
    return `huashu-${local ? 'local-fast' : 'host'}-${name}-${local ? key.slice('local-fast-'.length) : key}`
  }
  store.loadJson = (name, ...args) => loadJson(nameFor(name), ...args)
  store.saveJson = (name, ...args) => saveJson(nameFor(name), ...args)
}
function decodeBase64Image(value) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw failure('BAD_IMAGE', '图片必须是至多 64 MiB 的有效 base64。')
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) throw failure('BAD_IMAGE', '图片内容无效或超过 64 MiB。')
  return bytes
}
/** Electron 28's nativeImage decoder supports PNG/JPEG but not WebP. Decode
 * WebP in the same bounded hidden Chromium runtime, then validate its PNG with
 * nativeImage. The source bytes never become a path or leave this process. */
async function decodeWebpInChromium(electron, buffer) {
  let width, height
  if (buffer.length < 20 || buffer.readUInt32LE(4) + 8 !== buffer.length) throw failure('BAD_IMAGE', 'WebP 图片内容不完整。')
  for (let at = 12; at + 8 <= buffer.length;) {
    const type = buffer.toString('ascii', at, at + 4), length = buffer.readUInt32LE(at + 4), end = at + 8 + length
    if (end > buffer.length) throw failure('BAD_IMAGE', 'WebP 图片内容不完整。')
    const data = buffer.subarray(at + 8, end)
    if (type === 'VP8X' && length >= 10) { width = data.readUIntLE(4, 3) + 1; height = data.readUIntLE(7, 3) + 1; break }
    if (type === 'VP8L' && length >= 5 && data[0] === 0x2f) { const bits = data.readUInt32LE(1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; break }
    if (type === 'VP8 ' && length >= 10 && data.subarray(3, 6).equals(Buffer.from([0x9d, 1, 0x2a]))) { width = data.readUInt16LE(6) & 0x3fff; height = data.readUInt16LE(8) & 0x3fff; break }
    at = end + (length & 1)
  }
  if (!width || !height || width > 24000 || height > 24000 || width * height > 20000000) throw failure('BAD_IMAGE', 'WebP 图片尺寸无效或超过 2000 万像素。')
  const win = new electron.BrowserWindow({ show: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: `temp:huashu-webp-${require('node:crypto').randomUUID()}` } })
  let timer
  try {
    const decoding = (async () => {
      await win.loadURL('data:text/html;charset=utf-8,<meta charset="utf-8"><title>图片解码</title>')
      const decode = async base64 => {
        const image = new Image()
        image.src = 'data:image/webp;base64,' + base64
        await image.decode()
        if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 20000000) throw new Error('图片尺寸无效')
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
        canvas.getContext('2d').drawImage(image, 0, 0)
        return canvas.toDataURL('image/png')
      }
      const result = await win.webContents.executeJavaScript(`(${decode.toString()})(${JSON.stringify(buffer.toString('base64'))})`)
      if (typeof result !== 'string' || !result.startsWith('data:image/png;base64,')) throw failure('BAD_IMAGE', 'WebP 无法转换为有效 PNG。')
      return decodeBase64Image(result.slice('data:image/png;base64,'.length))
    })()
    return await Promise.race([decoding, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('IMAGE_DECODE_TIMEOUT', 'WebP 图片解码超时。')), 20000) })])
  } catch (error) { throw failure(error.code || 'BAD_IMAGE', 'WebP 图片无法解码。') }
  finally { clearTimeout(timer); if (!win.isDestroyed()) win.destroy() }
}
/** Preserve validated PNG/JPEG bytes, including EXIF orientation and color
 * metadata. Only WebP needs conversion because the asset store accepts PNG/JPEG. */
async function prepareImportImage(nativeImage, base64, { decodeWebp } = {}) {
  const buffer = decodeBase64Image(base64)
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
  const webp = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
  if (!png && !jpeg && !webp) throw failure('BAD_IMAGE', '导入图片仅支持 PNG、JPEG 或 WebP。')
  let image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty() && webp && decodeWebp) image = nativeImage.createFromBuffer(await decodeWebp(buffer))
  const size = image.getSize()
  if (image.isEmpty() || !size.width || !size.height || size.width > 24000 || size.height > 24000 || size.width * size.height > 20000000) throw failure('BAD_IMAGE', '图片无法解码或超过 2000 万像素。')
  if (png || jpeg) return { buffer, extension: jpeg ? '.jpg' : '.png' }
  const result = image.toPNG()
  if (!result.length || result.length > MAX_IMAGE_BYTES) throw failure('BAD_IMAGE', '规范化的 PNG 图片超过 64 MiB。')
  return { buffer: result, extension: '.png' }
}
/** Run only PrintPress's pure pixel functions here. This thread never imports the
 * original inference worker, ONNX or face detector. */
function runHostPixels(message, load) {
  const pixels = load('photo-processing-pixels.cjs'), { pngFromPixels } = load('psd-import.cjs')
  const original = { width: message.width, height: message.height, data: new Uint8ClampedArray(message.original) }
  const image = { ...original, data: new Uint8ClampedArray(original.data) }
  const recipe = pixels.normalizeRecipe(message.recipe), faces = message.faces || []
  if (recipe.cutout) {
    const alpha = new Uint8Array(message.alpha)
    if (alpha.length !== image.width * image.height) throw failure('HOST_IMAGE_INVALID_RESULT', '宿主抠图透明度长度无效。')
    const mask = new Float32Array(alpha.length)
    for (let n = 0; n < alpha.length; n++) mask[n] = original.data[n * 4 + 3] ? alpha[n] / original.data[n * 4 + 3] : 0
    if (message.subjectPolygon) {
      const region = pixels.subjectRegion(image, message.subjectPolygon), cropped = new Float32Array(region.width * region.height)
      for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) cropped[y * region.width + x] = mask[(region.y + y) * image.width + region.x + x]
      pixels.applySubjectMatte(image, cropped, region.width, region.height, message.subjectPolygon, region)
    } else if (message.protectPolygon) pixels.applyMatte(image, mask, image.width, image.height, message.protectPolygon)
    else for (let n = 0; n < alpha.length; n++) image.data[n * 4 + 3] = alpha[n]
  }
  const transform = pixels.photoTransform(image, recipe, faces)
  const plain = { ...recipe, cutout: false, faceAlign: false }
  const output = pixels.processPixels(image, plain, transform)
  const png = pngFromPixels(output)
  const restorePng = recipe.cutout || recipe.edge || recipe.bottom ? pngFromPixels(pixels.processPixels(original, { ...plain, edge: false, bottom: false }, transform)) : png
  return { png, restorePng, analysis: { issues: transform.issues, faceCount: faces.length, factor: transform.factor, source: message.source || 'dsh-host' } }
}
function createHostPhotoProcessor({ original, nativeImage, load, root, rpc, capabilities, owner, localFastFallback = true }) {
  const threads = new Set()
  let closing = false
  function imageCapabilities() {
    const host = capabilities(), fallback = { enabled: localFastFallback, ready: localFastFallback && original.status().ready === true, source: 'local-fast', name: 'MODNet快速抠图' }
    const local = !host.cutout && fallback.ready
    const effective = { ready: host.cutout || fallback.ready, cutout: host.cutout || fallback.ready, qualityReady: host.cutout, faceReady: host.faceAlign, faceAlign: host.faceAlign, name: local ? fallback.name : 'DSH宿主图像服务', local, source: local ? 'local-fast' : 'dsh-host', reason: local ? '宿主未配置，使用快速抠图模型' : host.reason }
    return { effective, host, fallback }
  }
  function status() { const { effective: cap } = imageCapabilities(); return { ready: cap.ready, qualityReady: cap.qualityReady, faceReady: cap.faceReady, name: cap.name, local: cap.local, source: cap.source, reason: cap.reason } }
  const identity = () => hostImageIdentity(capabilities(), imageCapabilities().fallback.ready)
  function assertAvailable(recipe = {}, analyzeReference = false, model = 'fast') {
    if (closing) throw failure('SHUTTING_DOWN', '业务服务正在关闭，照片处理已停止。')
    const { effective, host } = imageCapabilities()
    if ((recipe.faceAlign || analyzeReference) && !host.faceAlign) throw failure('HOST_IMAGE_UNAVAILABLE', host.reason || '当前DSH宿主未注册人脸分析服务；快速抠图模型不提供人脸分析。')
    if (recipe.cutout && !effective.cutout) throw failure('HOST_IMAGE_UNAVAILABLE', `${host.reason || HOST_IMAGE_MISSING}，且快速抠图模型不可用。`)
    if (recipe.cutout && model === 'quality' && !host.cutout) throw failure('HOST_IMAGE_QUALITY_UNAVAILABLE', '当前仅有本地快速抠图模型，请选择快速模式；质量模式需要宿主图像服务。')
  }
  function pixelsInThread(message) {
    const instance = new Worker(__filename, { workerData: { huashuHostPixels: true, root } })
    threads.add(instance)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void instance.terminate(); reject(failure('PHOTO_PIXEL_TIMEOUT', '照片像素处理超时。')) }, 120000)
      instance.once('message', result => { clearTimeout(timer); result.error ? reject(failure(result.error.code, result.error.message)) : resolve({ ...result, png: Buffer.from(result.png), restorePng: Buffer.from(result.restorePng) }) })
      instance.once('error', error => { clearTimeout(timer); reject(error) })
      instance.once('exit', code => { threads.delete(instance); clearTimeout(timer); if (code) reject(failure('PHOTO_PIXEL_INTERRUPTED', '照片像素处理已中断。')) })
      instance.postMessage(message)
    })
  }
  async function processPhoto({ asset, buffer, recipe, protectPolygon, subjectPolygon, model = 'fast', analyzeReference = false }) {
    assertAvailable(recipe, analyzeReference, model)
    if (!['fast', 'quality'].includes(model)) throw failure('BAD_PARAMS', '抠图兼容模式无效。')
    if (!analyzeReference && !recipe?.cutout && !recipe?.faceAlign) return original.processPhoto({ asset, buffer, recipe, protectPolygon, subjectPolygon, model })
    if (owner()?.imageIdentity && owner().imageIdentity !== identity()) throw failure('HOST_IMAGE_UNAVAILABLE', '照片处理来源已变化，请重新应用照片规则。')
    const { orientedRgba } = load('photo-processing-pixels.cjs'), { pngFromPixels } = load('psd-import.cjs')
    const image = nativeImage.createFromBuffer(buffer), size = image.getSize()
    if (image.isEmpty() || !size.width || !size.height || size.width * size.height > 20000000) throw failure('BAD_IMAGE', '照片无法解码或超过 2000 万像素。')
    const rgba = orientedRgba(image.toBitmap(), size.width, size.height, asset.orientation || 1)
    const canonical = pngFromPixels(rgba)
    const payload = { imageBase64: canonical.toString('base64'), width: rgba.width, height: rgba.height, model, ...(recipe ? { recipe: { ...recipe, ...(protectPolygon ? { protectPolygon } : {}), ...(subjectPolygon ? { subjectPolygon } : {}) } } : {}) }
    let faces = []
    if (analyzeReference || recipe.faceAlign) {
      const result = await rpc.request({ operation: 'analyze', ...payload })
      // Revalidate geometry at the transport boundary using the same registry
      // contract, even if a caller bypassed the parent registry by mistake.
      const { createHostImages } = await import(pathToFileURL(path.join(__dirname, 'host-images.js')).href)
      const validator = createHostImages()
      validator.register({ id: 'host-rpc-validation', title: '宿主结果校验', capabilities: { cutout: false, faceAlign: true }, process: async () => result })
      try { faces = (await validator.process({ operation: 'analyze', ...payload })).analysis.faces } finally { validator.dispose() }
      if (analyzeReference) {
        if (faces.length !== 1) return { faceCount: faces.length }
        const face = faces[0]
        return { faceCount: 1, faceHeight: face.h / rgba.height, eyeX: (face.eyes[0].x + face.eyes[1].x) / (2 * rgba.width), eyeY: (face.eyes[0].y + face.eyes[1].y) / (2 * rgba.height) }
      }
    }
    let alpha
    if (recipe.cutout) {
      let decoded
      if (capabilities().cutout) {
        const result = await rpc.request({ operation: 'cutout', ...payload })
        const { createHostImages } = await import(pathToFileURL(path.join(__dirname, 'host-images.js')).href)
        const validator = createHostImages()
        validator.register({ id: 'host-rpc-validation', title: '宿主结果校验', capabilities: { cutout: true, faceAlign: false }, process: async () => result })
        let checked
        try { checked = await validator.process({ operation: 'cutout', ...payload }) } finally { validator.dispose() }
        decoded = nativeImage.createFromBuffer(Buffer.from(checked.imageBase64, 'base64'))
      } else {
        // Only the explicitly authorized fast model is called here. Its native
        // worker still verifies MODNet's content hash; no quality/face model is
        // selected, and a failed host request never silently reaches this path.
        // Pass original encoded bytes + original EXIF to this adapter. The
        // canonical RGBA above is already oriented and stays in the pure pixel
        // pipeline; sending it with the old EXIF would rotate the photo twice.
        const factor = Math.min(1, 3200 / Math.max(rgba.width, rgba.height))
        const width = Math.max(64, Math.round(rgba.width * factor)), height = Math.max(64, Math.round(rgba.height * factor))
        const local = await original.processPhoto({ asset, buffer, model: 'fast', recipe: { width, height, cutout: true, faceAlign: false, fit: 'contain', subjectFit: false, scale: 1, offsetX: 0, offsetY: 0, edge: false, bottom: false } })
        decoded = nativeImage.createFromBuffer(Buffer.from(local.png))
        const fit = Math.min(width / rgba.width, height / rgba.height)
        const cropWidth = Math.min(width, Math.max(1, Math.round(rgba.width * fit))), cropHeight = Math.min(height, Math.max(1, Math.round(rgba.height * fit)))
        decoded = decoded.crop({ x: Math.floor((width - cropWidth) / 2), y: Math.floor((height - cropHeight) / 2), width: cropWidth, height: cropHeight }).resize({ width: rgba.width, height: rgba.height, quality: 'best' })
      }
      if (decoded.isEmpty() || decoded.getSize().width !== rgba.width || decoded.getSize().height !== rgba.height) throw failure('HOST_IMAGE_INVALID_RESULT', '抠图结果尺寸无效。')
      const bitmap = decoded.toBitmap()
      alpha = new Uint8Array(rgba.width * rgba.height)
      for (let n = 0; n < alpha.length; n++) alpha[n] = Math.min(bitmap[n * 4 + 3], rgba.data[n * 4 + 3])
    }
    assertAvailable(recipe, false, model)
    if (owner()?.imageIdentity && owner().imageIdentity !== identity()) throw failure('HOST_IMAGE_UNAVAILABLE', '照片处理来源已变化，请重新应用照片规则。')
    return pixelsInThread({ original: rgba.data, width: rgba.width, height: rgba.height, alpha, faces, recipe, protectPolygon, subjectPolygon, source: imageCapabilities().effective.source })
  }
  return { status, imageCapabilities, identity, assertAvailable, processPhoto,
    analyzePhoto: ({ asset, buffer }) => processPhoto({ asset, buffer, analyzeReference: true }),
    cropPhoto: (...args) => original.cropPhoto(...args),
    async shutdown() { closing = true; rpc.close(); await Promise.allSettled([...threads].map(instance => instance.terminate())); await original.shutdown() },
  }
}

async function startWorker() {
  // Install before loading any PrintPress module: some migrations log to console.log.
  console.log = (...args) => console.error(...args)
  let app, dataLock, photoProcessor, api, input, inputReader, stdinPump, ready = false, closing = false, outputClosed = false
  let shutdownPromise = null
  const active = new Map()
  // PSD/package inspections live in long-lived module state (15 min TTL, max 3).
  // A page refresh loses the browser's token but NOT the worker's session, so
  // retries accumulate until every new import fails with "待导入文件过多".
  // Track tokens this worker opened and evict the oldest before a new inspect.
  const pendingInspections = []
  const MAX_PENDING_INSPECTIONS = 2
  const operationContext = new AsyncLocalStorage()
  let imageCapabilities = normalizeHostCapabilities()
  const pendingOutput = new Set()
  function send(frame) {
    const written = new Promise(resolve => {
      if (outputClosed || process.stdout.destroyed) return resolve()
      let line
      try { line = JSON.stringify(frame) + '\n' } catch { line = JSON.stringify({ id: frame.id ?? null, ok: false, error: { code: 'SERIALIZATION_ERROR', message: '业务结果无法转换为 JSON。' } }) + '\n' }
      process.stdout.write(line, error => { if (error) outputClosed = true; resolve() })
    })
    pendingOutput.add(written)
    void written.finally(() => pendingOutput.delete(written))
    return written
  }
  const emit = (event, payload) => { void send({ event, payload }) }
  const hostImages = createHostImageRpc({ emit, context: () => operationContext.getStore(), timeoutMs: 120000 })
  function releaseLock() { try { dataLock?.release() } catch { /* never replace the original result during exit */ } }
  function cancelActive() {
    if (!api) return
    // Domain cancellation is cooperative; PDF batches already rendering finish.
    for (const { name, params, context } of active.values()) {
      try {
        if (['print:exportPdf', 'print:send'].includes(name) && params.jobKey) api.call('print:cancel', { jobKey: params.jobKey }, context)
        if (name === 'photo:processingApply') api.call('photo:processingCancel', { datasetId: params.datasetId, taskId: params.taskId }, context)
        if (['photo:importFolder', 'photo:commitSelection'].includes(name) && params.taskId) api.call('photo:cancelImport', { taskId: params.taskId }, context)
        if (name === 'design:packageExport' && params.taskId) api.call('design:packageCancelExport', { taskId: params.taskId }, context)
      } catch (error) { console.warn('[printpress] 关闭时取消任务:', error.message) }
    }
  }
  function shutdown(code = 0) {
    if (shutdownPromise) return shutdownPromise
    closing = true
    hostImages.close()
    cancelActive()
    shutdownPromise = (async () => {
      // Keep the lifetime lock until async operations and their finalizers end.
      await Promise.allSettled([...active.values()].map(item => item.promise))
      if (photoProcessor) await photoProcessor.shutdown()
      inputReader?.close()
      input?.destroy()
      if (stdinPump && stdinPump.exitCode === null && stdinPump.signalCode === null) {
        await new Promise(resolve => { stdinPump.once('exit', resolve); stdinPump.kill() })
      }
      for (const win of require('electron').BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy()
      // Flush all replies, including the shutdown acknowledgement.
      await Promise.allSettled([...pendingOutput])
      if (app) { app.exit(code) } else { releaseLock(); process.exit(code) }
    })().catch(error => { console.error('[printpress] 关闭失败:', error); releaseLock(); app ? app.exit(1) : process.exit(1) })
    return shutdownPromise
  }
  async function fatal(error) {
    console.error('[printpress] 启动或运行失败:', errorInfo(error))
    // Early Electron failures still need the app message loop to flush stdio.
    if (app && !app.isReady()) await app.whenReady()
    await send({ event: 'fatal', error: errorInfo(error) })
    await shutdown(1)
  }
  process.once('exit', () => { releaseLock(); try { stdinPump?.kill() } catch { /* exiting */ } })
  process.once('SIGTERM', () => { void shutdown() })
  process.once('SIGINT', () => { void shutdown() })
  process.on('uncaughtException', error => { void fatal(error) })
  process.on('unhandledRejection', error => { void fatal(error) })
  process.stdout.on('error', () => { outputClosed = true; void shutdown() })

  try {
    const electron = require('electron')
    if (!electron.app) throw failure('ELECTRON_REQUIRED', '业务服务需要使用批印坊的 electron.exe 启动。')
    app = electron.app
    const configuredRoot = process.env.HUASHU_PRINTPRESS_ROOT
    if (typeof configuredRoot !== 'string' || !path.isAbsolute(configuredRoot)) throw failure('BAD_ROOT', '请将 HUASHU_PRINTPRESS_ROOT 设置为批印坊根目录的绝对路径。')
    const root = fs.realpathSync(configuredRoot)
    const load = filename => require(path.join(root, 'electron', filename))
    if (process.env.HUASHU_PRINTPRESS_IMAGE_CAPABILITIES) {
      let supplied
      try { supplied = JSON.parse(process.env.HUASHU_PRINTPRESS_IMAGE_CAPABILITIES) } catch { throw failure('BAD_HOST_CAPABILITIES', '宿主图像能力环境变量不是有效 JSON。') }
      imageCapabilities = normalizeHostCapabilities(supplied)
    }
    const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    if (!fs.statSync(path.join(root, 'electron', 'api.cjs')).isFile()) throw failure('BAD_ROOT', '批印坊根目录缺少 electron/api.cjs。')
    const appData = app.getPath('appData')
    const runtimeDir = process.env.HUASHU_PRINTPRESS_USER_DATA || path.join(appData, 'huashu-printpress-runtime')
    if (!path.isAbsolute(runtimeDir)) throw failure('BAD_PARAMS', 'HUASHU_PRINTPRESS_USER_DATA 必须是绝对路径。')
    fs.mkdirSync(runtimeDir, { recursive: true })
    app.setPath('userData', runtimeDir)
    app.setPath('sessionData', runtimeDir)
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('in-process-gpu')
    // PrintPress bootstrap settings belong to the original app, not this runtime.
    const resolved = process.env.PRINTPRESS_DATA_DIR
      ? { dataDir: process.env.PRINTPRESS_DATA_DIR, custom: false }
      : load('data-dir.cjs').resolveDataDir({ isPackaged: false, appPath: root, userDataDir: path.join(appData, 'printpress') })
    if (!path.isAbsolute(resolved.dataDir)) throw failure('BAD_PARAMS', 'PRINTPRESS_DATA_DIR 必须是绝对路径。')
    const dataDir = path.resolve(resolved.dataDir)
    // store.cjs and asset modules capture this env at require time.
    process.env.PRINTPRESS_DATA_DIR = dataDir
    process.env.PRINTPRESS_DATA_DIR_CUSTOM = resolved.custom ? '1' : ''
    fs.mkdirSync(dataDir, { recursive: true })
    dataLock = load('data-lock.cjs')
    const locked = dataLock.acquireForHost() // Default 'gui' is required by acquireForClient in api.call.
    if (!locked?.ok) throw failure('DATA_DIR_BUSY', '无法独占批印坊数据目录，业务服务已停止。')
    scopePhotoStorage(load('store.cjs'), () => operationContext.getStore()?.imageIdentity || photoProcessor?.identity() || hostImageIdentity(imageCapabilities))
    app.on('will-quit', releaseLock)
    // No automatic quit when a hidden PDF render window is destroyed.
    app.on('window-all-closed', () => {})
    electron.protocol.registerSchemesAsPrivileged([{ scheme: 'pp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])
    try { load('cache.cjs').runPendingCleanup(runtimeDir) } catch (error) { console.warn('[printpress] 缓存清理:', error.message) }
    // Idempotent existing-data recovery only. Never require seed-demo/main/update.
    for (const [module, methods] of [
      ['designs.cjs', ['migrateEphemeralOriginals', 'migrateManagedOriginals']],
      ['templates.cjs', ['migrateBackgrounds']],
      ['design-package.cjs', ['recoverPendingTransactions', 'purgeStaging']],
      ['photo-library.cjs', ['recoverPendingImports']],
    ]) for (const method of methods) {
      try { await load(module)[method]() } catch (error) { console.warn(`[printpress] ${method}:`, error.message) }
    }
    await app.whenReady()
    load('media-protocol.cjs').registerMediaProtocol(electron.session.defaultSession)
    api = load('api.cjs')
    photoProcessor = createHostPhotoProcessor({ original: load('photo-processing-host.cjs'), nativeImage: electron.nativeImage, load, root, rpc: hostImages, capabilities: () => imageCapabilities, owner: () => operationContext.getStore(), localFastFallback: process.env.HUASHU_PRINTPRESS_LOCAL_FAST_FALLBACK !== '0' })
    const printer = load('printer.cjs')
    const thumbs = load('asset-thumbnails.cjs')
    const context = {
      allowWrite: true,
      app: { version: String(packageInfo.version), isPackaged: app.isPackaged, platform: process.platform, userDataDir: runtimeDir,
        relaunch: () => { throw failure('HOST_LIFECYCLE_FORBIDDEN', FORBIDDEN_OPERATIONS.get('app:relaunch')) } },
      dialog: {
        openDirectory: opts => electron.dialog.showOpenDialog(opts),
        openFile: opts => electron.dialog.showOpenDialog(opts),
        saveFile: opts => electron.dialog.showSaveDialog(opts),
        openPath: file => electron.shell.openPath(file),
        openSnapshotWindow: async (file, title) => {
          const win = new electron.BrowserWindow({ width: 1000, height: 780, autoHideMenuBar: true, title, webPreferences: { contextIsolation: true, nodeIntegration: false } })
          try { await win.loadURL(pathToFileURL(file).toString()); return { ok: true } } catch (error) { win.destroy(); throw error }
        },
      },
      printer, thumbs,
      // Prevent queued automatic work from starting inference after shutdown.
      photoProcessor: { ...photoProcessor,
        processPhoto: (...args) => closing ? Promise.reject(failure('SHUTTING_DOWN', '业务服务正在关闭，照片处理已停止。')) : photoProcessor.processPhoto(...args),
        analyzePhoto: (...args) => closing ? Promise.reject(failure('SHUTTING_DOWN', '业务服务正在关闭，照片处理已停止。')) : photoProcessor.analyzePhoto(...args),
      },
      capturePixel: async () => { throw failure('UNSUPPORTED', '工作台取色请使用浏览器 EyeDropper，业务进程没有可采样的主窗口。') },
      autoUpdate: { start: () => { throw failure('HOST_LIFECYCLE_FORBIDDEN', FORBIDDEN_OPERATIONS.get('app:startUpdate')) }, install: () => { throw failure('HOST_LIFECYCLE_FORBIDDEN', FORBIDDEN_OPERATIONS.get('app:installUpdate')) } },
      emit,
    }
    const operations = new Map(api.ipcTable().map(operation => [operation.name, operation]))
    const descriptions = new Map(api.describe().map(operation => [operation.name, operation]))
    function dispatch(request) {
      let id = validId(request?.id) ? request.id : null
      try {
        validateRequest(request)
        id = request.id
        if (closing) throw failure('SHUTTING_DOWN', '批印坊业务服务正在关闭，请稍后重新连接。')
        if (active.has(id)) throw failure('DUPLICATE_ID', '请求 id 正在使用，请为并发请求使用不同 id。')
        if (request.method === 'hostImageResult') {
          const accepted = hostImages.accept(request)
          void send({ id, ok: true, data: { accepted } })
          return
        }
        if (request.method === 'imageCapabilities') {
          void send({ id, ok: true, data: photoProcessor.imageCapabilities() })
          return
        }
        if (request.method === 'hostCapabilities') {
          const previous = photoProcessor.identity()
          imageCapabilities = normalizeHostCapabilities(request.capabilities)
          if (photoProcessor.identity() !== previous) hostImages.cancelWhere(() => true, failure('HOST_IMAGE_UNAVAILABLE', '宿主图像提供方已变化，请重新应用照片规则。'))
          void send({ id, ok: true, data: { accepted: true, capabilities: imageCapabilities } })
          emit('host:imageCapabilities', photoProcessor.imageCapabilities())
          return
        }
        if (request.method === 'shutdown') {
          // Acknowledge acceptance before waiting; no work starts after this point.
          void send({ id, ok: true, data: { stopped: true } })
          void shutdown()
          return
        }
        let name = '', params = {}, callContext = context
        if (request.method === 'call' || request.method === 'invoke') {
          name = request.name
          const operation = operations.get(name)
          if (!operation) throw failure('UNKNOWN_OP', `未知操作：${name}。该名称不在批印坊 ipcTable 中。`)
          if (FORBIDDEN_OPERATIONS.has(name) || (name.startsWith('app:') && /update|relaunch|restart|quit|exit|data.?dir.*(?:change|reset|migrat)|(?:change|reset|migrat).*data.?dir/i.test(name))) throw failure('HOST_LIFECYCLE_FORBIDDEN', FORBIDDEN_OPERATIONS.get(name) || '工作台不支持会改变批印坊或宿主生命周期的操作。')
          params = request.method === 'call' ? operation.fromIpc(...(request.args || [])) : (request.params || {})
          if (params === undefined && !Object.keys(descriptions.get(name)?.params || {}).length) params = {}
          if (!record(params)) throw failure('BAD_PARAMS', `[${name}] 参数必须是 JSON 对象，请按 preload 的位置参数契约调用。`)
          // call keeps GUI write semantics; invoke only grants literal true.
          callContext = request.method === 'call' ? context : { ...context, allowWrite: request.allowWrite === true }
          if (request.method === 'call') for (const [key, rule] of Object.entries(descriptions.get(name)?.params || {})) {
            if (rule.required && (params[key] === undefined || params[key] === null || params[key] === '')) throw failure('BAD_PARAMS', `[${name}] 缺少必填参数 ${key}。`)
          }
          // Guard before the domain can reuse either an old cache or an applied
          // state. A missing provider must never look like a successful cutout.
          if (['photo:processingPreview', 'photo:processingApply', 'photo:processingSingleSet'].includes(name)) {
            photoProcessor.assertAvailable(params.recipe, false, params.model)
            if (name === 'photo:processingApply' && (params.recipe?.cutout || params.recipe?.faceAlign)) params = { ...params, incremental: false }
          }
          if (name === 'photo:processingCancel') hostImages.cancelWhere(owner => owner?.name === 'photo:processingApply' && String(owner.params.datasetId) === String(params.datasetId) && String(owner.params.taskId) === String(params.taskId))
          // A fresh inspection must never fail because an abandoned dialog or a
          // page refresh left stale module-level sessions behind. Cancel tokens
          // this worker owns (oldest first) before handing the call to the domain.
          if (name === 'design:packageInspect' && api) {
            while (pendingInspections.length > MAX_PENDING_INSPECTIONS) {
              const stale = pendingInspections.shift()
              try { api.call('design:packageCancel', { token: stale }, context) } catch { /* session may already be gone */ }
            }
          }
          if (['design:packageCommit', 'design:packageCancel'].includes(name) && params?.token) {
            const index = pendingInspections.indexOf(params.token)
            if (index >= 0) pendingInspections.splice(index, 1)
          }
        }
        const imageIdentity = photoProcessor.identity()
        const item = { name, params, context: callContext, promise: null }
        active.set(id, item)
        // Start each operation independently. A cancellation can overtake a pending
        // render/import; there is deliberately no global promise/request queue.
        item.promise = operationContext.run({ id, name, params, imageIdentity }, async () => {
          if (request.method === 'media') return { ok: true, data: resolveMedia(request.url, { load, dataDir }) }
          if (request.method === 'importImage') {
            const imported = await prepareImportImage(electron.nativeImage, request.base64, { decodeWebp: buffer => decodeWebpInChromium(electron, buffer) })
            const imageName = path.basename(request.name || '作品图片').replace(/\.[^.]*$/, '') + imported.extension
            const created = await api.call('design:importBytes', { base64: imported.buffer.toString('base64'), name: imageName }, context)
            // The import result's metadata omits EXIF orientation on first write.
            // Read the canonical asset so the editor receives the verified
            // display dimensions and actual orientation together.
            const asset = load('designs.cjs').assetInfo(created.id)
            return { ok: true, data: { asset } }
          }
          if (request.method === 'invoke') return api.invoke(name, params, callContext)
          return { ok: true, data: await api.call(name, params, callContext) }
        }).then(result => {
          if (name === 'design:packageInspect' && result?.ok && typeof result.data?.token === 'string') {
            pendingInspections.push(result.data.token)
          }
          return send({ id, ...result, ...(result.ok && result.data === undefined ? { data: null } : {}) })
        }, error => send({ id, ok: false, error: errorInfo(error) }))
          .finally(() => active.delete(id))
      } catch (error) { void send({ id, ok: false, error: errorInfo(error) }) }
    }
    // Match main.cjs recovery without opening a window or adding demo datasets.
    try { await load('photo-library.cjs').migrateLegacyPhotoAssets() } catch (error) { console.warn('[printpress] 照片目录整理:', error.message) }
    load('photo-processing.cjs').scheduleAutomatic(context.photoProcessor, emit)
    // Electron 28 on Windows has an already-ended process.stdin wrapper. Raw
    // fs.read(0) works, but a pending read deadlocks app.exit even after close(0).
    // A tiny Node-mode instance of this same Electron executable owns only that
    // read. The parent still writes directly to this worker's stdin; no caller
    // relay, extra dependency, named pipe server, or visible window is required.
    if (process.platform === 'win32') {
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      delete env.NODE_OPTIONS
      stdinPump = require('node:child_process').spawn(process.execPath, [__filename, '--huashu-printpress-stdin'], { env, windowsHide: true, stdio: [0, 'pipe', 'pipe'] })
      stdinPump.once('error', error => { if (!closing) void fatal(failure('TRANSPORT_ERROR', `业务服务输入读取进程启动失败：${error.message}`)) })
      stdinPump.stderr.on('data', chunk => process.stderr.write(chunk))
      stdinPump.once('exit', code => { if (!closing && code) void fatal(failure('TRANSPORT_ERROR', '业务服务输入读取进程意外退出。')) })
      input = stdinPump.stdout
    } else input = process.stdin
    input.on('error', error => { if (!closing) void fatal(failure('TRANSPORT_ERROR', `业务服务输入管道失败：${error.message}`)) })
    ready = true
    await send({ event: 'ready', payload: { version: context.app.version, dataDir, root, imageCapabilities, operations: [...operations.keys()].filter(name => !FORBIDDEN_OPERATIONS.has(name)) } })
    inputReader = createNdjsonReader(input, { onRequest: dispatch, onError: error => { void send({ id: null, ok: false, error: errorInfo(error) }) }, onEnd: () => { void shutdown() } })
    // A pipe can close during startup, before the reader has been attached.
    if (input.readableEnded || input.destroyed) void shutdown()
  } catch (error) {
    if (!ready && error.code === 'DATA_DIR_BUSY') error = failure('DATA_DIR_BUSY', '批印坊数据目录正在被另一个进程使用，请先关闭该实例后重试。')
    await fatal(error)
  }
}

module.exports = { startWorker, MAX_INPUT_BYTES, MAX_IMAGE_BYTES, FORBIDDEN_OPERATIONS, validateRequest, createNdjsonReader, resolveMedia, createHostImageRpc, normalizeHostCapabilities, hostImageIdentity, scopePhotoStorage, runHostPixels, prepareImportImage }
if (!isMainThread && workerData?.huashuHostPixels) {
  parentPort.once('message', message => {
    try { parentPort.postMessage(runHostPixels(message, filename => require(path.join(workerData.root, 'electron', filename)))) }
    catch (error) { parentPort.postMessage({ error: errorInfo(error) }) }
    parentPort.close()
  })
} else if (process.env.ELECTRON_RUN_AS_NODE === '1' && process.argv[2] === '--huashu-printpress-stdin') {
  const stdin = fs.createReadStream(null, { fd: 0, autoClose: false, highWaterMark: 64 * 1024 })
  stdin.on('error', error => { console.error('[printpress stdin]', error.message); process.exit(1) })
  process.stdout.on('error', () => process.exit(0))
  stdin.pipe(process.stdout)
  // Parent death must not leave a reader process behind if its caller retained
  // a write handle to stdin. This helper never opens data, API, or Electron UI.
  const parent = process.ppid
  setInterval(() => { try { process.kill(parent, 0) } catch { process.exit(0) } }, 1000).unref()
} else {
  // Electron's default_app loads an explicit .cjs through Module._load without
  // making it require.main. Match its entry argv as well as ordinary Node.
  if (require.main === module || (process.type === 'browser' && process.argv[1] && path.resolve(process.argv[1]) === __filename)) void startWorker()
}
