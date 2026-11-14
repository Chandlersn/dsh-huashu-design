import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import test from 'node:test'
import { createHostImages } from '../lib/host-images.js'

const crc32 = bytes => {
  let value = 0xffffffff
  for (const byte of bytes) { value ^= byte; for (let n = 0; n < 8; n++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0) }
  return (value ^ 0xffffffff) >>> 0
}
function image(width = 2, height = 2, pixels = [240, 32, 16, 255, 11, 170, 43, 255, 20, 40, 210, 255, 190, 70, 130, 255], channels = 4) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12)
    out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8)
    out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4)
    return out
  }
  const header = Buffer.alloc(13), rows = Buffer.alloc((width * channels + 1) * height)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2
  for (let y = 0; y < height; y++) Buffer.from(pixels.slice(y * width * channels, (y + 1) * width * channels)).copy(rows, y * (width * channels + 1) + 1)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
function pixelsFromNormalizedPng(base64) {
  const bytes = Buffer.from(base64, 'base64'), width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), parts = []
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(at)
    if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + size))
    at += size + 12
  }
  const rows = inflateSync(Buffer.concat(parts)), result = []
  for (let y = 0; y < height; y++) { assert.equal(rows[y * (width * 4 + 1)], 0); result.push(...rows.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))) }
  return { width, height, pixels: result }
}
const source = image(), sourceBase64 = source.toString('base64')
const cutout = image(2, 2, [0, 255, 255, 0, 0, 255, 255, 128, 0, 255, 255, 255, 0, 255, 255, 64])
const request = { operation: 'cutout', imageBase64: sourceBase64, width: 2, height: 2 }
const provider = (process, extra = {}) => ({ id: 'test-provider', title: '测试服务', capabilities: { cutout: true, faceAlign: false }, process, ...extra })
const missing = { source: 'dsh-host', localModels: false, cutout: false, faceAlign: false, provider: null, reason: '当前DSH宿主未注册抠图/人脸分析服务' }

test('no image provider never invents readiness or falls back to local models', async () => {
  const registry = createHostImages()
  assert.deepEqual(registry.status(), missing)
  await assert.rejects(registry.process(request), { code: 'HOST_IMAGE_UNAVAILABLE', message: missing.reason })
  await assert.rejects(registry.process({ ...request, operation: 'analyze' }), { code: 'HOST_IMAGE_UNAVAILABLE' })
  registry.dispose(); registry.dispose()
  assert.deepEqual(registry.status(), missing)
  assert.throws(() => registry.register(provider(async () => ({}))), { code: 'HOST_IMAGE_DISPOSED' })
})

test('registration snapshots capabilities, rejects duplicates, and notifies changes', async () => {
  const registry = createHostImages(), changes = []
  const unsubscribe = registry.subscribe(value => changes.push(value))
  const first = provider(async () => ({ imageBase64: cutout.toString('base64') }))
  const remove = registry.register(first)
  first.capabilities.cutout = false
  assert.equal(registry.status().cutout, true)
  assert.equal(registry.status().faceAlign, false)
  assert.equal(registry.status().provider, 'test-provider')
  assert.throws(() => registry.register(provider(async () => ({}))), { code: 'HOST_IMAGE_PROVIDER_DUPLICATE' })
  await assert.rejects(registry.process({ ...request, operation: 'analyze' }), { code: 'HOST_IMAGE_UNAVAILABLE' })
  remove(); remove()
  assert.deepEqual(registry.status(), missing)
  assert.deepEqual(changes.map(value => value.cutout), [true, false])
  unsubscribe(); registry.dispose(); assert.equal(changes.length, 2)
})

test('cutout validates original bytes and preserves source RGB, dimensions and returned alpha', async () => {
  const registry = createHostImages()
  registry.register(provider(async (input, signal) => {
    assert.ok(Buffer.isBuffer(input.buffer)); assert.ok(input.buffer.equals(source)); assert.equal(signal.aborted, false)
    assert.equal(input.sourceHash, createHash('sha256').update(source).digest('hex'))
    return { imageBase64: cutout.toString('base64'), sourceHash: input.sourceHash }
  }))
  const result = await registry.process(request)
  assert.equal(result.provider, 'test-provider'); assert.equal(result.source, 'dsh-host')
  assert.deepEqual(pixelsFromNormalizedPng(result.imageBase64), { width: 2, height: 2, pixels: [240, 32, 16, 0, 11, 170, 43, 128, 20, 40, 210, 255, 190, 70, 130, 64] })
  for (const fields of [{ width: 3 }, { sourceHash: 'wrong' }, { buffer: image(1, 1, [1, 2, 3, 255]) }, { imageBase64: 'AAAA' }]) await assert.rejects(registry.process({ ...request, ...fields }), { code: 'HOST_IMAGE_BAD_REQUEST' })
  registry.dispose()
})

test('bad provider PNG, checksum, dimensions, opaque/empty masks and mismatched source reject', async () => {
  const corrupt = Buffer.from(cutout); corrupt[corrupt.length - 1] ^= 1
  const results = [
    { imageBase64: Buffer.from('not an image').toString('base64') },
    { imageBase64: corrupt.toString('base64') },
    { imageBase64: image(1, 1, [1, 2, 3, 128]).toString('base64') },
    { imageBase64: sourceBase64 },
    { imageBase64: image(2, 2, new Array(16).fill(0)).toString('base64') },
    { imageBase64: image(2, 2, new Array(12).fill(12), 3).toString('base64') },
    { imageBase64: cutout.toString('base64'), sourceHash: 'another source' },
    { imageBase64: cutout.toString('base64'), width: 9 },
    { mask: 'LLM generated text' },
  ]
  for (const result of results) {
    const registry = createHostImages(); registry.register(provider(async () => result))
    await assert.rejects(registry.process(request), { code: 'HOST_IMAGE_INVALID_RESULT' }); registry.dispose()
  }
  const registry = createHostImages()
  registry.register(provider(async () => ({ imageBase64: cutout.toString('base64') })))
  await assert.rejects(registry.process({ ...request, imageBase64: image(2, 2, new Array(16).fill(16)).toString('base64') }), { code: 'HOST_IMAGE_INVALID_RESULT' })
  registry.dispose()
})

test('face analysis requires actual pixel geometry and validates its count', async () => {
  const registry = createHostImages(), face = { x: 0, y: 0, w: 2, h: 2, eyes: [{ x: 0.5, y: 0.75 }, { x: 1.5, y: 0.75 }] }
  let analysis = { faces: [face] }
  registry.register(provider(async () => ({ analysis }), { capabilities: { cutout: false, faceAlign: true } }))
  assert.deepEqual((await registry.process({ ...request, operation: 'analyze' })).analysis, { faces: [face], faceCount: 1 })
  for (const value of [{ faceCount: 1, faceHeight: 0.4, eyeY: 0.3 }, { faces: [face], faceCount: 2 }, { faces: [{ ...face, eyes: [{ x: 9, y: 0 }, { x: 1, y: 1 }] }] }]) {
    analysis = value
    await assert.rejects(registry.process({ ...request, operation: 'analyze' }), { code: 'HOST_IMAGE_INVALID_RESULT' })
  }
  analysis = { faces: [] }
  assert.deepEqual((await registry.process({ ...request, operation: 'analyze' })).analysis, { faces: [], faceCount: 0 })
  registry.dispose()
})

test('abort, unregister and registry disposal release pending work even when provider ignores cancellation', async () => {
  for (const method of ['signal', 'unregister', 'dispose']) {
    const registry = createHostImages(), controller = new AbortController()
    let started, providerSignal, complete
    const begun = new Promise(resolve => { started = resolve })
    const unregister = registry.register(provider((_input, signal) => {
      providerSignal = signal; started()
      return new Promise(resolve => { complete = resolve })
    }))
    const operation = registry.process(request, { signal: controller.signal })
    await begun
    const rejected = assert.rejects(operation, { code: method === 'signal' ? 'HOST_IMAGE_ABORTED' : method === 'unregister' ? 'HOST_IMAGE_UNAVAILABLE' : 'HOST_IMAGE_DISPOSED' })
    method === 'signal' ? controller.abort() : method === 'unregister' ? unregister() : registry.dispose()
    await rejected
    assert.equal(providerSignal.aborted, true)
    complete({ imageBase64: cutout.toString('base64') })
    registry.dispose()
  }
})
