import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'

const MAX_BYTES = 64 * 1024 * 1024
const MAX_PIXELS = 20_000_000
const MISSING = '当前DSH宿主未注册抠图/人脸分析服务'
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const fail = (code, message) => Object.assign(new Error(message), { code })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0)
  return n >>> 0
})
function crc32(bytes) {
  let n = 0xffffffff
  for (const byte of bytes) n = (n >>> 8) ^ crcTable[(n ^ byte) & 255]
  return (n ^ 0xffffffff) >>> 0
}
function bytesFromBase64(value, code) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_BYTES / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail(code, '图片必须是至多 64 MiB 的有效 base64。')
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== value) throw fail(code, '图片 base64 内容无效或超过 64 MiB。')
  return bytes
}
function png(bytes, code, requireAlpha = false) {
  const invalid = message => { throw fail(code, message) }
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(SIGNATURE)) invalid('宿主图像必须是有效的 PNG。')
  let offset = 8, width, height, channels, ended = false, idatEnded = false
  const compressed = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length
    if (end > bytes.length) invalid('PNG 数据不完整。')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, end - 4)
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid('PNG 校验失败。')
    if (offset === 8 && type !== 'IHDR') invalid('PNG 缺少图像头。')
    if (type === 'IHDR') {
      if (width !== undefined || length !== 13) invalid('PNG 图像头无效。')
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      if (!width || !height || width > 24000 || height > 24000 || width * height > MAX_PIXELS) invalid('宿主图像不能超过 2000 万像素或单边 24000 像素。')
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0
      if (data[8] !== 8 || !channels || data[10] || data[11] || data[12] || (requireAlpha && channels !== 4)) invalid('宿主图像需要非交错的 8 位 RGB/RGBA PNG，抠图结果必须含 alpha 通道。')
    } else if (type === 'IDAT') {
      if (idatEnded) invalid('PNG 像素块顺序无效。')
      compressed.push(data)
    } else if (type === 'IEND') {
      if (length || !compressed.length || end !== bytes.length) invalid('PNG 结束块无效。')
      ended = true; break
    } else {
      if (compressed.length) idatEnded = true
      if (!/^[a-zA-Z]{4}$/.test(type) || (type[0] === type[0].toUpperCase() && type !== 'PLTE') || type === 'acTL' || type === 'tRNS') invalid('PNG 包含不支持的图像编码。')
    }
    offset = end
  }
  if (!ended || !channels) invalid('PNG 数据不完整。')
  const stride = width * channels, expected = (stride + 1) * height
  let rows
  try { rows = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }) } catch { invalid('PNG 像素数据损坏。') }
  if (rows.length !== expected) invalid('PNG 像素长度与图像尺寸不符。')
  const data = Buffer.alloc(width * height * 4), previous = Buffer.alloc(stride), current = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = rows[start]
    if (filter > 4) invalid('PNG 像素过滤器无效。')
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >>> 1
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      current[x] = (rows[start + 1 + x] + predictor) & 255
    }
    for (let x = 0; x < width; x++) {
      const source = x * channels, target = (y * width + x) * 4
      data[target] = current[source]; data[target + 1] = current[source + 1]; data[target + 2] = current[source + 2]
      data[target + 3] = channels === 4 ? current[source + 3] : 255
    }
    current.copy(previous)
  }
  return { width, height, data }
}
function encodePng({ width, height, data }) {
  function chunk(type, value) {
    const out = Buffer.alloc(value.length + 12)
    out.writeUInt32BE(value.length); out.write(type, 4); value.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4)
    return out
  }
  const rows = Buffer.alloc((width * 4 + 1) * height), header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  for (let y = 0; y < height; y++) data.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  const bytes = Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
  if (bytes.length > MAX_BYTES) throw fail('HOST_IMAGE_INVALID_RESULT', '宿主抠图结果超过 64 MiB。')
  return bytes
}
function faceAnalysis(value, width, height) {
  if (!record(value) || !Array.isArray(value.faces) || value.faces.length > 20) throw fail('HOST_IMAGE_INVALID_RESULT', '宿主人脸分析必须返回 faces 数组，不能用文字或估计比例代替几何数据。')
  const point = p => record(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height
  const faces = value.faces.map(face => {
    if (!record(face) || !['x', 'y', 'w', 'h'].every(key => Number.isFinite(face[key])) || face.w <= 0 || face.h <= 0 || face.x < -width || face.y < -height || face.x + face.w > width * 2 || face.y + face.h > height * 2 || face.x + face.w <= 0 || face.y + face.h <= 0 || face.x >= width || face.y >= height || !Array.isArray(face.eyes) || face.eyes.length !== 2 || !face.eyes.every(point)) throw fail('HOST_IMAGE_INVALID_RESULT', '宿主人脸框或眼睛坐标无效。')
    return { x: face.x, y: face.y, w: face.w, h: face.h, eyes: face.eyes.map(({ x, y }) => ({ x, y })) }
  })
  if (value.faceCount !== undefined && value.faceCount !== faces.length) throw fail('HOST_IMAGE_INVALID_RESULT', '宿主人脸数量与几何数据不一致。')
  return { faces, faceCount: faces.length }
}

/**
 * Plugin-owned registry, exposed by the plugin as ctx.huashuImageProviders.
 * This is an extension point, not a claim that DSH ships an image service.
 *
 * register({ id, title, version?, capabilities:{cutout:boolean,faceAlign:boolean}, process })
 * returns an idempotent unregister function. Duplicate ids throw; registration
 * snapshots metadata. Unregister/dispose abort and reject that provider's work.
 * subscribe(listener) returns an unsubscribe function; it emits a fresh status
 * after registration, unregistration or disposal, without an initial callback.
 * status.providers carries all registered ids/capabilities/optional versions so
 * the worker can namespace derived caches by actual provider identity.
 * process(request, signal) on a provider must honor AbortSignal. The request has
 * operation:'cutout'|'analyze', buffer:Buffer, imageBase64:string, width, height,
 * sourceHash:SHA256, and optional model/recipe. Input is a valid non-interlaced
 * 8-bit RGB/RGBA PNG, at most 64 MiB / 20 MP. Fast/quality are compatibility hints.
 *
 * Cutout returns {imageBase64, sourceHash?}; PNG must be 8-bit RGBA, same size,
 * with visible and transparent pixels, and must never increase source alpha.
 * The registry keeps original RGB and adopts only the returned alpha. Providers
 * cannot repaint the source. Analyze returns {analysis:{faces:[{x,y,w,h,
 * eyes:[{x,y},{x,y}]}]},sourceHash?}, in source pixel coordinates; an empty array
 * means a real analysis found no faces. An optional echoed hash must match.
 *
 * Public process(request,{signal}?) returns a JSON-safe normalized result:
 * {imageBase64?,analysis?,width,height,sourceHash,provider,source:'dsh-host'}.
 * No provider means HOST_IMAGE_UNAVAILABLE. No network, model or text-mask
 * fallback is performed. A provider rejection is not retried on another route.
 */
export function createHostImages() {
  const providers = new Map(), running = new Set(), listeners = new Set()
  let disposed = false
  function status() {
    const entries = [...providers.values()]
    return { source: 'dsh-host', localModels: false, cutout: entries.some(p => p.capabilities.cutout), faceAlign: entries.some(p => p.capabilities.faceAlign), provider: entries[0]?.id || null, reason: entries.length ? '' : MISSING, ...(entries.length ? { providers: entries.map(p => ({ id: p.id, ...(p.version === undefined ? {} : { version: p.version }), ...p.capabilities })) } : {}) }
  }
  function notify() { for (const listener of listeners) { try { listener(status()) } catch { /* one subscriber cannot break registration or teardown */ } } }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw fail('HOST_IMAGE_BAD_LISTENER', '宿主图像订阅必须是函数。')
    if (disposed) return () => {}
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  function register(provider) {
    if (disposed) throw fail('HOST_IMAGE_DISPOSED', '宿主图像注册表已关闭。')
    if (!record(provider) || typeof provider.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(provider.id) || (provider.version !== undefined && (typeof provider.version !== 'string' || provider.version.length > 128)) || typeof provider.title !== 'string' || !provider.title.trim() || provider.title.length > 200 || !record(provider.capabilities) || typeof provider.capabilities.cutout !== 'boolean' || typeof provider.capabilities.faceAlign !== 'boolean' || (!provider.capabilities.cutout && !provider.capabilities.faceAlign) || typeof provider.process !== 'function') throw fail('HOST_IMAGE_BAD_PROVIDER', '图像提供方必须声明 id、title、布尔能力和 process 函数。')
    if (providers.has(provider.id)) throw fail('HOST_IMAGE_PROVIDER_DUPLICATE', `图像提供方已注册：${provider.id}`)
    const entry = { id: provider.id, title: provider.title, ...(provider.version === undefined ? {} : { version: provider.version }), capabilities: { cutout: provider.capabilities.cutout, faceAlign: provider.capabilities.faceAlign }, process: provider.process.bind(provider) }
    providers.set(entry.id, entry)
    notify()
    return () => {
      if (providers.get(entry.id) !== entry) return
      providers.delete(entry.id)
      for (const work of running) if (work.provider === entry) work.cancel(fail('HOST_IMAGE_UNAVAILABLE', '宿主图像提供方已注销，当前处理已停止。'))
      notify()
    }
  }
  async function process(request, { signal } = {}) {
    if (disposed) throw fail('HOST_IMAGE_DISPOSED', '宿主图像注册表已关闭。')
    if (!record(request) || !['cutout', 'analyze'].includes(request.operation)) throw fail('HOST_IMAGE_BAD_REQUEST', '宿主图像操作只能使用 cutout 或 analyze。')
    const provider = [...providers.values()].find(p => p.capabilities[request.operation === 'cutout' ? 'cutout' : 'faceAlign'])
    if (!provider) throw fail('HOST_IMAGE_UNAVAILABLE', MISSING)
    if (signal?.aborted) throw fail('HOST_IMAGE_ABORTED', '宿主图像处理已取消。')
    let bytes
    if (Buffer.isBuffer(request.buffer)) {
      bytes = Buffer.from(request.buffer)
      if (request.imageBase64 !== undefined && !bytesFromBase64(request.imageBase64, 'HOST_IMAGE_BAD_REQUEST').equals(bytes)) throw fail('HOST_IMAGE_BAD_REQUEST', '原图 buffer 与 base64 不一致。')
    } else bytes = bytesFromBase64(request.imageBase64, 'HOST_IMAGE_BAD_REQUEST')
    const image = png(bytes, 'HOST_IMAGE_BAD_REQUEST')
    if ((request.width !== undefined && request.width !== image.width) || (request.height !== undefined && request.height !== image.height)) throw fail('HOST_IMAGE_BAD_REQUEST', '原图声明尺寸与 PNG 内容不符。')
    const sourceHash = createHash('sha256').update(bytes).digest('hex')
    if (request.sourceHash !== undefined && request.sourceHash !== sourceHash) throw fail('HOST_IMAGE_BAD_REQUEST', '原图内容校验失败。')
    const controller = new AbortController()
    let cancel, abort
    const interrupted = new Promise((_, reject) => { cancel = error => { controller.abort(error); reject(error) } })
    const work = { provider, cancel }
    running.add(work)
    if (signal) { abort = () => cancel(fail('HOST_IMAGE_ABORTED', '宿主图像处理已取消。')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() }
    try {
      const normalized = { operation: request.operation, buffer: bytes, imageBase64: bytes.toString('base64'), width: image.width, height: image.height, sourceHash, ...(request.model === undefined ? {} : { model: request.model }), ...(request.recipe === undefined ? {} : { recipe: structuredClone(request.recipe) }) }
      const result = await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) throw controller.signal.reason; return provider.process(normalized, controller.signal) }), interrupted])
      if (!record(result) || (result.sourceHash !== undefined && result.sourceHash !== sourceHash)) throw fail('HOST_IMAGE_INVALID_RESULT', '宿主图像结果不属于本次原图。')
      if ((result.width !== undefined && result.width !== image.width) || (result.height !== undefined && result.height !== image.height)) throw fail('HOST_IMAGE_INVALID_RESULT', '宿主图像结果声明尺寸与原图不一致。')
      const metadata = { width: image.width, height: image.height, sourceHash, provider: provider.id, source: 'dsh-host' }
      if (request.operation === 'analyze') return { ...metadata, analysis: faceAnalysis(result.analysis, image.width, image.height) }
      const cutout = png(bytesFromBase64(result.imageBase64, 'HOST_IMAGE_INVALID_RESULT'), 'HOST_IMAGE_INVALID_RESULT', true)
      if (cutout.width !== image.width || cutout.height !== image.height) throw fail('HOST_IMAGE_INVALID_RESULT', '宿主抠图结果必须保持原图尺寸。')
      let visible = false, transparent = false
      for (let i = 3; i < image.data.length; i += 4) {
        const alpha = cutout.data[i]
        if (alpha > image.data[i]) throw fail('HOST_IMAGE_INVALID_RESULT', '宿主抠图结果增加了原图透明区域的 alpha。')
        visible ||= alpha > 0; transparent ||= alpha < 255
        image.data[i] = alpha
      }
      if (!visible || !transparent) throw fail('HOST_IMAGE_INVALID_RESULT', '宿主抠图结果必须同时包含可见主体和透明背景。')
      return { ...metadata, imageBase64: encodePng(image).toString('base64') }
    } finally {
      running.delete(work)
      if (abort) signal.removeEventListener('abort', abort)
    }
  }
  function dispose() {
    if (disposed) return
    disposed = true; providers.clear()
    for (const work of running) work.cancel(fail('HOST_IMAGE_DISPOSED', '宿主图像注册表已关闭。'))
    notify(); listeners.clear()
  }
  return { register, status, process, subscribe, dispose }
}
