import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import readline from 'node:readline'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createHostImages } from '../lib/host-images.js'

const require = createRequire(import.meta.url)
const { MAX_INPUT_BYTES, validateRequest, createNdjsonReader, resolveMedia, FORBIDDEN_OPERATIONS, createHostImageRpc, normalizeHostCapabilities, hostImageIdentity, scopePhotoStorage } = require('../lib/printpress-worker.cjs')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRESSPRESS_CHECKOUT = process.env.HUASHU_PRINTPRESS_TEST_ROOT || process.env.HUASHU_PRINTPRESS_ROOT || ''
const ELECTRON = process.env.HUASHU_PRINTPRESS_TEST_ELECTRON || path.join(PRESSPRESS_CHECKOUT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const TEMP_PREFIX = 'huashu-printpress-worker-'
const tempDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX))
function removeTemporary(directory) {
  // Verify the exact absolute target before every recursive test cleanup.
  const absolute = path.resolve(directory)
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
  assert.ok(path.basename(absolute).startsWith(TEMP_PREFIX))
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  assert.ok(!fs.existsSync(absolute), 'test directory was removed')
}

test('NDJSON bounds count bytes, survive malformed/oversized lines and split UTF-8', async () => {
  assert.equal(MAX_INPUT_BYTES, 96 * 1024 * 1024)
  const stream = new PassThrough(), requests = [], errors = []
  const ended = new Promise(resolve => createNdjsonReader(stream, { maxBytes: 64, onRequest: request => requests.push(request), onError: error => errors.push(error), onEnd: resolve }))
  const unicode = Buffer.from('{"id":1,"text":"张三"}\r\n')
  const split = unicode.indexOf(Buffer.from('张')) + 1
  stream.write(unicode.subarray(0, split)); stream.write(unicode.subarray(split))
  stream.write('not-json\n' + 'x'.repeat(65))
  stream.write('still-discarded\n{"id":2}\n')
  stream.end('{"id":3}')
  await ended
  assert.deepEqual(requests, [{ id: 1, text: '张三' }, { id: 2 }, { id: 3 }])
  assert.deepEqual(errors.map(error => error.code), ['BAD_JSON', 'INPUT_TOO_LARGE'])
})

test('request shape and literal write permission reject bad parameters', () => {
  for (const request of [null, [], { method: 'call' }, { id: {}, method: 'call' }, { id: 1, method: 'call', name: '' }, { id: 1, method: 'call', name: 'app:ping', args: {} }, { id: 1, method: 'invoke', name: 'app:ping', params: [] }, { id: 1, method: 'invoke', name: 'app:ping', allowWrite: 'true' }]) assert.throws(() => validateRequest(request), error => ['BAD_REQUEST', 'BAD_PARAMS'].includes(error.code))
  assert.throws(() => validateRequest({ id: 1, method: 'eval' }), { code: 'UNKNOWN_METHOD' })
  assert.equal(validateRequest({ id: 'request-1', method: 'call', name: 'app:ping', args: [] }).id, 'request-1')
  assert.equal(FORBIDDEN_OPERATIONS.size, 5)
})

test('reverse image RPC validates frames and cleans response, error, abort, timeout and EOF paths', async () => {
  for (const fields of [
    { method: 'hostImageResult', requestId: 'r' },
    { method: 'hostImageResult', requestId: 'r', result: {}, error: {} },
    { method: 'hostCapabilities', capabilities: null },
    { method: 'importImage', filePath: 'C:/private.png', base64: 'AAAA' },
    { method: 'importImage', base64: '*not-base64*' },
  ]) assert.throws(() => validateRequest({ id: 1, ...fields }), error => ['BAD_PARAMS', 'BAD_IMAGE'].includes(error.code))
  assert.equal(validateRequest({ id: 1, method: 'hostImageResult', requestId: 'r', result: {} }).requestId, 'r')
  assert.throws(() => normalizeHostCapabilities({ cutout: true }), { code: 'BAD_HOST_CAPABILITIES' })
  const missing = normalizeHostCapabilities()
  assert.deepEqual(missing, { source: 'dsh-host', localModels: false, cutout: false, faceAlign: false, provider: null, reason: '当前DSH宿主未注册抠图/人脸分析服务' })
  assert.notEqual(hostImageIdentity(missing), hostImageIdentity(normalizeHostCapabilities({ provider: 'real', cutout: true })))
  const events = [], controller = new AbortController(), owner = { datasetId: 'ds', taskId: 't' }
  const rpc = createHostImageRpc({ emit: (event, payload) => events.push({ event, payload }), context: () => owner, timeoutMs: 25 })
  const payload = { operation: 'cutout', imageBase64: 'AAAA', width: 1, height: 1 }
  const success = rpc.request(payload), first = events.at(-1).payload.requestId
  assert.equal(rpc.accept({ requestId: first, result: { imageBase64: 'real-png' } }), true)
  assert.deepEqual(await success, { imageBase64: 'real-png' }); assert.equal(rpc.size, 0)
  assert.equal(rpc.accept({ requestId: first, result: {} }), false, 'duplicate or late reply cannot resurrect pending work')
  const failed = rpc.request(payload)
  rpc.accept({ requestId: events.at(-1).payload.requestId, error: { code: 'HOST_IMAGE_UNAVAILABLE', message: 'missing' } })
  await assert.rejects(failed, { code: 'HOST_IMAGE_UNAVAILABLE' }); assert.equal(rpc.size, 0)
  const aborted = rpc.request(payload, { signal: controller.signal }); controller.abort()
  await assert.rejects(aborted, { code: 'HOST_IMAGE_ABORTED' }); assert.equal(rpc.size, 0)
  const canceled = rpc.request(payload); rpc.cancelWhere(value => value === owner)
  await assert.rejects(canceled, { code: 'HOST_IMAGE_ABORTED' }); assert.equal(rpc.size, 0)
  await assert.rejects(rpc.request(payload), { code: 'HOST_IMAGE_TIMEOUT' }); assert.equal(rpc.size, 0)
  const eof = rpc.request(payload); rpc.close()
  await assert.rejects(eof, { code: 'HOST_IMAGE_ABORTED' }); assert.equal(rpc.size, 0)
  await assert.rejects(rpc.request(payload), { code: 'HOST_IMAGE_ABORTED' })
  assert.equal(events.filter(value => value.event === 'host:imageCancel').length, 4)
})

test('host provider identity isolates all derived photo state and leaves source/options/presets untouched', () => {
  const data = new Map([['photo-processing-cache', ['legacy-local-cache']]]), calls = []
  const store = { loadJson: name => { calls.push(['load', name]); return data.get(name) || null }, saveJson: (name, value) => { calls.push(['save', name]); data.set(name, value) } }
  let identity = 'provider-one'
  scopePhotoStorage(store, () => identity)
  for (const name of ['photo-processing', 'photo-processing-cache', 'photo-processing-singles', 'photo-processing-jobs']) {
    assert.equal(store.loadJson(name), null)
    store.saveJson(name, [name])
    assert.deepEqual(data.get(`huashu-host-${name}-provider-one`), [name])
  }
  identity = 'provider-two'
  assert.equal(store.loadJson('photo-processing-cache'), null)
  assert.deepEqual(data.get('photo-processing-cache'), ['legacy-local-cache'])
  for (const name of ['datasets', 'photo-processing-options', 'photo-processing-presets', 'photo-bindings']) { store.loadJson(name); assert.deepEqual(calls.at(-1), ['load', name]) }
})

test('media resolution keeps original asset routes and rejects traversal/junction escape', () => {
  const directory = tempDirectory(), dataDir = path.join(directory, 'data'), outside = path.join(directory, 'outside')
  fs.mkdirSync(dataDir); fs.mkdirSync(outside)
  fs.writeFileSync(path.join(dataDir, 'inside.png'), 'image')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  const modules = {
    'store.cjs': { resolveInsideDataDir: relative => path.join(dataDir, relative) },
    'asset-storage.cjs': { resolveAssetPath: relative => path.join(dataDir, relative), poolDir: pool => path.join(dataDir, pool) },
    'designs.cjs': { assetInfo: () => { throw new Error('missing') } },
  }
  const options = { dataDir, load: name => modules[name] }
  try {
    assert.deepEqual(resolveMedia('pp://media/inside.png?v=1', options), { file: fs.realpathSync(path.join(dataDir, 'inside.png')), mime: 'image/png' })
    for (const url of ['file:///etc/passwd', 'https://media/inside.png', 'pp://other/inside.png', 'pp://media/../outside/secret.txt', 'pp://media/%2e%2e/outside/secret.txt', 'pp://media/%2e%2e%5coutside/secret.txt', 'pp://media/C%3a/secret.txt', 'pp://media/inside.png%3asecret', 'pp://media/%00', 'pp://media/%zz']) assert.throws(() => resolveMedia(url, options), error => ['BAD_MEDIA_URL', 'MEDIA_FORBIDDEN'].includes(error.code), url)
    fs.symlinkSync(outside, path.join(dataDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => resolveMedia('pp://media/escape/secret.txt', options), { code: 'MEDIA_FORBIDDEN' })
    const hash = 'a'.repeat(64), relative = `ephemeral-assets/${hash}.png`
    fs.mkdirSync(path.join(dataDir, 'ephemeral-assets')); fs.writeFileSync(path.join(dataDir, relative), 'asset')
    modules['designs.cjs'].assetInfo = id => { assert.equal(id, `asset_${hash}`); return { path: relative } }
    for (const url of [`pp://media/asset_${hash}`, `pp://media/design-assets/${hash}.png`]) assert.equal(resolveMedia(url, options).file, fs.realpathSync(path.join(dataDir, relative)))
    fs.writeFileSync(path.join(outside, `${hash}.png`), 'outside')
    fs.symlinkSync(outside, path.join(dataDir, 'photo-assets'), process.platform === 'win32' ? 'junction' : 'dir')
    modules['designs.cjs'].assetInfo = () => ({ path: `photo-assets/${hash}.png` })
    assert.throws(() => resolveMedia(`pp://media/asset_${hash}`, options), { code: 'MEDIA_FORBIDDEN' }, 'an asset alias cannot authorize a junction at the pool root')
    // A separately configured managed pool is an original supported capability.
    modules['designs.cjs'].assetInfo = () => ({ path: `design-assets/${hash}.png` })
    modules['asset-storage.cjs'] = { poolDir: () => outside, resolveAssetPath: () => path.join(outside, `${hash}.png`) }
    assert.equal(resolveMedia(`pp://media/asset_${hash}`, options).file, fs.realpathSync(path.join(outside, `${hash}.png`)))
  } finally { removeTemporary(directory) }
})

function client({ directory, dataDir = path.join(directory, 'data'), observe = false, entry, env: extraEnv = {}, root = PRESSPRESS_CHECKOUT } = {}) {
  const env = { ...process.env, HUASHU_PRINTPRESS_ROOT: root, PRINTPRESS_DATA_DIR: dataDir, HUASHU_PRINTPRESS_USER_DATA: path.join(directory, 'runtime'), ...extraEnv }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'PRINTPRESS_ASSET_DIR']) delete env[key]
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  const child = spawn(ELECTRON, [entry || path.join(ROOT, observe ? 'test/fixtures/printpress-observer.cjs' : 'lib/printpress-worker.cjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = new EventEmitter(), frames = [], invalid = [], pending = new Map()
  let sequence = 0, stderr = '', closed = false
  child.stderr.on('data', chunk => { stderr += chunk.toString(); events.emit('stderr') })
  const done = new Promise(resolve => {
    child.once('close', (code, signal) => {
      closed = true
      for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error(`Electron closed ${code}/${signal}: ${stderr.slice(-4000)}`)) }
      pending.clear(); events.emit('closed'); resolve({ code, signal })
    })
  })
  child.on('error', error => events.emit('spawn-error', error))
  child.stdin.on('error', () => {})
  readline.createInterface({ input: child.stdout }).on('line', line => {
    // Windows Electron emits one native CRLF before this script is loaded.
    // NDJSON permits receivers to ignore empty lines; all nonempty lines must
    // still parse, so console/log pollution remains a failing assertion.
    if (!line.trim()) return
    let frame
    try { frame = JSON.parse(line) } catch { invalid.push(line); return }
    frames.push(frame)
    const value = pending.get(frame.id)
    if (value) { clearTimeout(value.timer); pending.delete(frame.id); value.resolve(frame) }
    events.emit('frame', frame)
  })
  function waitFrame(predicate, timeout = 20000) {
    const found = frames.find(predicate)
    if (found) return Promise.resolve(found)
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); events.off('frame', frame); events.off('closed', close); events.off('spawn-error', spawnError) }
      const frame = value => { if (predicate(value)) { cleanup(); resolve(value) } }
      const close = () => { cleanup(); reject(new Error(`Electron closed before event: ${stderr.slice(-4000)}`)) }
      const spawnError = error => { cleanup(); reject(error) }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Electron frame timeout: ${stderr.slice(-4000)}`)) }, timeout)
      events.on('frame', frame); events.once('closed', close); events.once('spawn-error', spawnError)
      if (closed) close()
    })
  }
  function request(method, fields = {}) {
    assert.ok(!closed, `Electron already closed: ${stderr}`)
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`request ${method}/${fields.name || ''} timed out: ${stderr.slice(-4000)}`)) }, 60000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, ...fields }) + '\n')
    })
  }
  return {
    child, done, frames, invalid, request, waitFrame, get stderr() { return stderr }, get closed() { return closed },
    async start() {
      const frame = await waitFrame(frame => ['ready', 'fatal'].includes(frame.event))
      assert.equal(frame.event, 'ready', JSON.stringify(frame))
      return frame.payload
    },
    async call(name, args = []) {
      const result = await request('call', { name, args })
      assert.equal(result.ok, true, JSON.stringify(result)); return result.data
    },
    async invoke(name, params = {}, allowWrite) { return request('invoke', { name, params, ...(allowWrite === undefined ? {} : { allowWrite }) }) },
    async stop(eof = false) {
      if (closed) return done
      if (eof) child.stdin.end()
      else assert.equal((await request('shutdown')).ok, true)
      const timer = setTimeout(() => child.kill(), 10000)
      const result = await done
      clearTimeout(timer)
      assert.equal(result.code, 0, stderr.slice(-4000))
      assert.deepEqual(invalid, [], 'stdout is exclusively NDJSON')
      return result
    },
    async dispose() {
      if (!closed) { child.kill(); await done }
    },
  }
}

const realElectron = { skip: PRESSPRESS_CHECKOUT && fs.existsSync(ELECTRON) && fs.existsSync(path.join(PRESSPRESS_CHECKOUT, 'electron', 'api.cjs')) ? false : 'set HUASHU_PRINTPRESS_TEST_ROOT to a PrintPress checkout with Electron installed', timeout: 120000 }

test('real Electron serves existing operations, isolates caches, locks data, prints and cancels concurrently', realElectron, async t => {
  const directory = tempDirectory(), service = client({ directory, observe: true }), others = []
  try {
    const ready = await service.start()
    assert.equal(ready.root, fs.realpathSync(PRESSPRESS_CHECKOUT)); assert.equal(ready.dataDir, path.join(directory, 'data'))
    assert.equal(ready.version, JSON.parse(fs.readFileSync(path.join(PRESSPRESS_CHECKOUT, 'package.json'), 'utf8')).version)
    assert.ok(ready.operations.includes('dataset:inspect')); assert.ok(ready.operations.includes('photo:processingCancel'))
    assert.ok(!ready.operations.includes('app:installUpdate'))
    assert.equal((await service.call('app:ping')).version, ready.version)
    assert.deepEqual(await service.call('dataset:list'), [], 'startup must not seed sample datasets')
    assert.deepEqual(await service.call('template:list'), [], 'startup must not seed sample templates')
    const lockPath = path.join(ready.dataDir, 'data-dir.lock.json')
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, service.child.pid)

    await t.test('native Electron cache and app metadata use the independent runtime', async () => {
      // A ping round trip also lets the fixture emit its post-startup observation.
      await service.call('app:ping')
      const stateLine = service.stderr.split(/\r?\n/).find(line => line.startsWith('PRINTPRESS_TEST_STATE '))
      assert.ok(stateLine, service.stderr)
      const state = JSON.parse(stateLine.slice('PRINTPRESS_TEST_STATE '.length))
      assert.equal(state.windows, 0)
      assert.equal(state.userData, path.join(directory, 'runtime')); assert.equal(state.sessionData, state.userData)
      assert.ok(service.stderr.includes('PRINTPRESS_TEST_DIAGNOSTIC'), 'console.log diagnostics are redirected to stderr')
      assert.equal((await service.call('app:env')).dataDir, ready.dataDir)
    })

    await t.test('second writer emits a fatal busy frame and cannot replace the lock', async () => {
      const contender = client({ directory: path.join(directory, 'contender'), dataDir: ready.dataDir })
      others.push(contender)
      const fatal = await contender.waitFrame(frame => frame.event === 'fatal')
      assert.equal(fatal.error.code, 'DATA_DIR_BUSY')
      assert.equal((await contender.done).code, 1)
      assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, service.child.pid)
    })

    const csv = path.join(directory, '测试名单.csv')
    fs.writeFileSync(csv, '\ufeff编号,姓名\n001,张三\n002,李四\n003,王五\n', 'utf8')
    let dataset, template
    await t.test('call keeps preload positional arguments and invoke requires literal write permission', async () => {
      assert.equal((await service.invoke('dataset:inspect', { filePath: csv })).error.code, 'WRITE_FORBIDDEN')
      assert.equal((await service.invoke('dataset:inspect', { filePath: csv }, false)).error.code, 'WRITE_FORBIDDEN')
      assert.equal((await service.request('invoke', { name: 'dataset:inspect', params: { filePath: csv }, allowWrite: 'true' })).error.code, 'BAD_PARAMS')
      assert.deepEqual(await service.call('dataset:list'), [])
      const imported = await service.call('dataset:inspect', [csv])
      assert.ok(imported.datasets?.[0]?.id, JSON.stringify(imported))
      const datasets = await service.call('dataset:list')
      assert.equal(datasets.length, 1)
      dataset = await service.call('dataset:get', [datasets[0].id])
      assert.equal(dataset.rows[1]['姓名'], '李四'); assert.equal(dataset.rows.length, 3)
      for (const key of ['编号', '姓名']) await service.call('dataset:setColumnPrint', [{ datasetId: dataset.id, key, printOn: true }])
      const saved = await service.invoke('store:save', { name: 'settings', value: { theme: 'ink' } }, true)
      assert.equal(saved.ok, true, JSON.stringify(saved))
      assert.deepEqual(await service.call('store:load', ['settings']), { theme: 'ink' })
      // Lifetime lock must survive every API write's acquireForClient/release pair.
      assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, service.child.pid)
    })

    await t.test('dangerous/unknown operations and malformed frames fail without stopping the service', async () => {
      for (const name of FORBIDDEN_OPERATIONS.keys()) {
        const result = await service.request('call', { name, args: [] })
        assert.equal(result.error.code, 'HOST_LIFECYCLE_FORBIDDEN', name)
        assert.match(result.error.message, /工作台/)
      }
      for (const name of ['app:meta', 'app:checkUpdate', 'constructor', '__proto__', 'no:suchOperation']) assert.equal((await service.request('call', { name, args: [] })).error.code, 'UNKNOWN_OP')
      assert.equal((await service.request('eval', { source: 'process.exit()' })).error.code, 'UNKNOWN_METHOD')
      assert.equal((await service.request('call', { name: 'dataset:get', args: [] })).error.code, 'BAD_PARAMS')
      assert.equal((await service.invoke('dataset:get', {})).error.code, 'BAD_PARAMS')
      assert.equal((await service.request('call', { name: 'dataset:get', args: {} })).error.code, 'BAD_PARAMS')
      const denied = await service.request('call', { name: 'store:save', args: ['datasets', []] })
      assert.equal(denied.ok, false); assert.match(denied.error.message, /领域/)
      const pixel = await service.request('call', { name: 'design:samplePixel', args: [{ x: 1, y: 1 }] })
      assert.equal(pixel.error.code, 'UNSUPPORTED')
      service.child.stdin.write('not json\n')
      assert.equal((await service.waitFrame(frame => frame.id === null && frame.error?.code === 'BAD_JSON')).ok, false)
      assert.equal((await service.call('app:ping')).pong, true)
    })

    await t.test('media handles real original assets and rejects file URLs/traversal/junctions', async () => {
      const image = fs.readFileSync(path.join(PRESSPRESS_CHECKOUT, 'test', 'fixtures', 'tiny.png')).toString('base64')
      const imported = await service.call('design:importBytes', [{ base64: image, name: '测试底图.png' }])
      const result = await service.request('media', { url: `pp://media/${imported.id}` })
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.mime, 'image/png')
      assert.ok(fs.readFileSync(result.data.file).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      const second = await service.request('media', { url: `pp://media/${imported.path}` })
      assert.equal(second.data.file, result.data.file)
      const outside = path.join(directory, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
      fs.symlinkSync(outside, path.join(ready.dataDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      for (const url of ['file:///' + csv.replaceAll('\\', '/'), 'pp://media/../outside/secret.txt', 'pp://media/%2e%2e%5coutside/secret.txt', 'pp://media/escape/secret.txt']) {
        const denied = await service.request('media', { url }); assert.equal(denied.ok, false, url)
        assert.ok(['BAD_MEDIA_URL', 'MEDIA_FORBIDDEN'].includes(denied.error.code), JSON.stringify(denied))
      }
      // Backgrounds contain pp:// URLs, exercising registration in print sessions.
      const background = await service.call('template:uploadBackgroundBytes', [{ dataBase64: image, fileName: '测试底图.png' }])
      template = await service.call('template:save', [{ name: '测试证书', datasetId: dataset.id,
        pageSize: { id: 'a6-landscape', w: 148, h: 105 }, background: background.background,
        fields: [{ column: '姓名', label: '姓名', x: 40, y: 40, fontSize: 24, align: 'center', color: '#000000' }],
      }])
      assert.ok(template.id)
    })

    await t.test('real PDF export creates content through hidden windows', async () => {
      const pdfPath = path.join(directory, '证书.pdf')
      const result = await service.call('print:exportPdf', [{ datasetId: dataset.id, templateId: template.id, savePath: pdfPath, rows: [0] }])
      assert.equal(result.canceled, false)
      assert.equal(fs.readFileSync(pdfPath).subarray(0, 5).toString(), '%PDF-')
      const { countPdfPagesFromFile } = require(path.join(PRESSPRESS_CHECKOUT, 'electron', 'pdf-merge.cjs'))
      assert.equal(countPdfPagesFromFile(pdfPath), 1)
      assert.ok(result.jobId)
      assert.ok(service.stderr.includes('PRINTPRESS_TEST_WINDOW_CREATED'))
      assert.ok(!service.stderr.includes('PRINTPRESS_TEST_WINDOW_SHOWN'), service.stderr)
      assert.equal((await service.call('app:ping')).pong, true, 'closing last hidden render window leaves service alive')
    })

    await t.test('cancel reaches the domain while a real PDF batch is rendering', async () => {
      const jobKey = 'worker_concurrent_cancel', savePath = path.join(directory, '已取消.pdf')
      let completed = false
      const exporting = service.request('call', { name: 'print:exportPdf', args: [{ datasetId: dataset.id, templateId: template.id, savePath, batchRows: 1, jobKey }] }).then(result => { completed = true; return result })
      await service.waitFrame(frame => frame.event === 'print:progress' && frame.payload.jobKey === jobKey && frame.payload.phase === 'batch-start')
      const canceled = await service.call('print:cancel', [{ jobKey }])
      assert.equal(canceled.ok, true, 'cancel observes the in-flight domain task')
      assert.equal(completed, false, 'cancel reply arrives before the long request completes')
      const result = await exporting
      assert.equal(result.ok, false); assert.match(result.error.message, /取消/)
      assert.equal(fs.existsSync(savePath), false, 'canceled export publishes no final PDF')
      assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('.printpress-tmp-')))
      const jobs = await service.call('job:list')
      assert.ok(jobs.some(job => job.status === 'canceled'))
    })

    await t.test('photo processing uses the real host adapter and accepts cancellation during native work', async () => {
      await service.call('dataset:setPhotoMatchColumn', [{ datasetId: dataset.id, key: '编号' }])
      // Disable import bootstrapping so this test does not load face/AI models.
      await service.call('photo:processingOptions', [{ datasetId: dataset.id, autoProcess: false }])
      const folder = path.join(directory, '照片'); fs.mkdirSync(folder)
      fs.copyFileSync(path.join(PRESSPRESS_CHECKOUT, 'test', 'fixtures', 'tiny.png'), path.join(folder, '001.png'))
      const taskId = 'worker-photo-processing'
      await service.call('photo:importFolder', [{ datasetId: dataset.id, column: '编号', folder }])
      const report = await service.call('photo:report', [{ datasetId: dataset.id, column: '编号' }])
      const matched = report.results.find(row => row.status === 'matched')
      assert.ok(matched?.assetId, JSON.stringify(report))
      let completed = false
      const processing = service.request('call', { name: 'photo:processingApply', args: [{ datasetId: dataset.id, taskId, sampleAssetId: matched.assetId, recipe: { width: 1024, height: 1024, cutout: false, faceAlign: false } }] }).then(result => { completed = true; return result })
      await service.waitFrame(frame => frame.event === 'photo:processingProgress' && frame.payload.taskId === taskId && frame.payload.phase === 'processing')
      const canceled = await service.call('photo:processingCancel', [{ datasetId: dataset.id, taskId }])
      assert.equal(canceled.canceled, true)
      assert.equal(completed, false, 'photo cancellation reply overtakes the pending native processor')
      const result = await processing
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.data.canceled, true)
      assert.equal(result.data.completed, 1, 'the current photo completes before cooperative cancellation')
      assert.ok(!service.stderr.includes('PRINTPRESS_TEST_WINDOW_SHOWN'))
    })

    await service.stop()
    assert.equal(fs.existsSync(lockPath), false, 'graceful shutdown releases the lifetime lock')
    assert.ok(!service.stderr.includes('PRINTPRESS_TEST_WINDOW_SHOWN'))
    const reopened = client({ directory: path.join(directory, 'reopened'), dataDir: ready.dataDir }); others.push(reopened)
    await reopened.start()
    assert.equal((await reopened.call('dataset:list')).length, 1, 'data survives service restart')
    const ping = reopened.request('call', { name: 'app:ping', args: [] })
    const stopping = reopened.stop(true)
    assert.equal((await ping).data.pong, true, 'a request before stdin EOF drains normally')
    await stopping
    assert.equal(fs.existsSync(lockPath), false, 'stdin EOF releases the lock')
  } finally {
    await Promise.all([service, ...others].map(child => child.dispose()))
    removeTemporary(directory)
  }
})

test('real Electron reads original bootstrap settings while keeping independent default userData', realElectron, async () => {
  const directory = tempDirectory(), appData = path.join(directory, 'appdata'), customData = path.join(directory, 'custom-data')
  fs.mkdirSync(path.join(appData, 'printpress'), { recursive: true })
  const bootstrap = path.join(appData, 'printpress', 'data-dir.json'), original = JSON.stringify({ dataDir: customData, pendingDataDir: path.join(directory, 'must-not-migrate') })
  fs.writeFileSync(bootstrap, original)
  const service = client({ directory, observe: true, env: { HUASHU_PRINTPRESS_TEST_APP_DATA: appData, PRINTPRESS_DATA_DIR: undefined, HUASHU_PRINTPRESS_USER_DATA: undefined } })
  try {
    const ready = await service.start()
    assert.equal(ready.dataDir, customData)
    assert.equal((await service.call('app:env')).dataDirCustom, true)
    await service.call('app:ping')
    const stateLine = service.stderr.split(/\r?\n/).find(line => line.startsWith('PRINTPRESS_TEST_STATE '))
    assert.equal(JSON.parse(stateLine.slice('PRINTPRESS_TEST_STATE '.length)).userData, path.join(appData, 'huashu-printpress-runtime'))
    assert.equal(fs.readFileSync(bootstrap, 'utf8'), original)
    assert.equal(fs.existsSync(path.join(directory, 'must-not-migrate')), false)
    await service.stop()
    assert.equal(fs.existsSync(path.join(customData, 'data-dir.lock.json')), false)
  } finally { await service.dispose(); removeTemporary(directory) }
})

test('packaged mode resolves desktop data and refuses a second writer', realElectron, async () => {
  const directory = tempDirectory(), appData = path.join(directory, 'appdata')
  const desktop = path.join(appData, 'printpress'), data = path.join(desktop, 'data')
  const opts = { directory, observe: true, env: { HUASHU_PRINTPRESS_TEST_APP_DATA: appData, HUASHU_PRINTPRESS_PACKAGED: '1', PRINTPRESS_DATA_DIR: undefined } }
  const first = client(opts)
  let second
  try {
    assert.equal((await first.start()).dataDir, data)
    second = client(opts)
    const failure = await second.waitFrame(frame => frame.event === 'fatal')
    assert.equal(failure.error.code, 'DATA_DIR_BUSY')
    await first.stop()
    assert.equal(fs.existsSync(path.join(data, 'data-dir.lock.json')), false)
  } finally { await first.dispose(); await second?.dispose(); removeTemporary(directory) }
})

test('packaged mode refuses to fall back when the configured desktop data directory is unavailable', realElectron, async () => {
  const directory = tempDirectory(), appData = path.join(directory, 'appdata'), desktop = path.join(appData, 'printpress')
  const unavailable = path.join(directory, 'not-a-directory')
  fs.mkdirSync(desktop, { recursive: true })
  fs.writeFileSync(unavailable, 'existing file')
  fs.writeFileSync(path.join(desktop, 'data-dir.json'), JSON.stringify({ dataDir: unavailable }))
  const service = client({ directory, observe: true, env: { HUASHU_PRINTPRESS_TEST_APP_DATA: appData, HUASHU_PRINTPRESS_PACKAGED: '1', PRINTPRESS_DATA_DIR: undefined } })
  try {
    const frame = await service.waitFrame(value => value.event === 'fatal')
    assert.equal(frame.error.code, 'DATA_DIR_UNAVAILABLE')
    assert.equal(fs.existsSync(path.join(desktop, 'data')), false)
    assert.equal(fs.readFileSync(unavailable, 'utf8'), 'existing file')
  } finally { await service.dispose(); removeTemporary(directory) }
})

test('packaged mode rejects a changed desktop bootstrap after acquiring its lock', realElectron, async () => {
  const directory = tempDirectory(), desktop = path.join(directory, 'desktop'), bootstrap = path.join(desktop, 'data-dir.json')
  fs.mkdirSync(desktop, { recursive: true })
  fs.writeFileSync(bootstrap, JSON.stringify({ dataDir: path.join(directory, 'old-data') }))
  const entry = path.join(directory, 'change-bootstrap.cjs')
  fs.writeFileSync(entry, `const fs = require('node:fs'); const read = fs.readFileSync; let changed = false; fs.readFileSync = function(file, ...args) { const result = read.call(this, file, ...args); if (!changed && String(file) === ${JSON.stringify(bootstrap)}) { changed = true; fs.writeFileSync(file, JSON.stringify({dataDir:${JSON.stringify(path.join(directory, 'new-data'))}})); } return result; }; require(${JSON.stringify(path.join(ROOT, 'lib', 'printpress-worker.cjs'))}).startWorker();`)
  const service = client({ directory, entry, env: { HUASHU_PRINTPRESS_DESKTOP_USER_DATA: desktop, HUASHU_PRINTPRESS_PACKAGED: '1', PRINTPRESS_DATA_DIR: undefined } })
  try {
    const frame = await service.waitFrame(value => ['ready', 'fatal'].includes(value.event))
    assert.equal(frame.event, 'fatal', JSON.stringify(frame))
    assert.equal(frame.error.code, 'DATA_DIR_CHANGED')
    await service.done
    assert.equal(fs.existsSync(path.join(directory, 'old-data', 'data-dir.lock.json')), false)
  } finally { await service.dispose(); removeTemporary(directory) }
})

function withExifOrientation(jpeg, orientation) {
  // Valid little-endian TIFF IFD0 tag, matching the existing PrintPress JPEG fixtures.
  const exif = Buffer.from('45786966000049492a0008000000010012010300010000000100000000000000', 'hex')
  exif.writeUInt16LE(orientation, 24)
  const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 225; marker.writeUInt16BE(exif.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)])
}

function normalizedPixels(bytes) {
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), compressed = []
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(at)
    if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') compressed.push(bytes.subarray(at + 8, at + 8 + size))
    at += size + 12
  }
  const rows = inflateSync(Buffer.concat(compressed)), data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    assert.equal(rows[y * (width * 4 + 1)], 0, 'test output uses the shared PNG writer')
    rows.copy(data, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1))
  }
  return { width, height, data, at: (x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)] }
}

test('real Electron host images are honest in strict mode, use reverse RPC, preserve restore colors, and clean pending EOF', realElectron, async () => {
  const directory = tempDirectory(), guard = path.join(directory, 'no-local-models.cjs')
  fs.writeFileSync(guard, `const original = require(${JSON.stringify(path.join(PRESSPRESS_CHECKOUT, 'electron', 'photo-processing-host.cjs'))})\nconst native = original.processPhoto\noriginal.status = () => { throw new Error('TEST_FORBIDDEN_LOCAL_STATUS') }\noriginal.processPhoto = args => { if (args.recipe?.cutout || args.recipe?.faceAlign || args.analyzeReference) throw new Error('TEST_FORBIDDEN_LOCAL_AI'); return native(args) }\noriginal.analyzePhoto = () => { throw new Error('TEST_FORBIDDEN_LOCAL_FACE') }\nrequire(${JSON.stringify(path.join(ROOT, 'lib', 'printpress-worker.cjs'))}).startWorker()\n`)
  const service = client({ directory, entry: guard, env: { HUASHU_PRINTPRESS_LOCAL_FAST_FALLBACK: '0' } }), registry = createHostImages(), seen = new Set()
  const { pngFromPixels } = require(path.join(PRESSPRESS_CHECKOUT, 'electron', 'psd-import.cjs'))
  const { normalizeRecipe, VERSION } = require(path.join(PRESSPRESS_CHECKOUT, 'electron', 'photo-processing-pixels.cjs'))
  const color = [201, 41, 17, 255], original = Buffer.alloc(64 * 64 * 4)
  for (let n = 0; n < 64 * 64; n++) original.set(color, n * 4)
  const originalPng = pngFromPixels({ width: 64, height: 64, data: original })
  const nextRequest = async operation => {
    const frame = await service.waitFrame(frame => frame.event === 'host:imageRequest' && frame.payload.operation === operation && !seen.has(frame.payload.requestId))
    seen.add(frame.payload.requestId); return frame.payload
  }
  async function reply(payload, result, error) {
    return service.request('hostImageResult', { requestId: payload.requestId, ...(error ? { error } : { result }) })
  }
  async function readAsset(asset) {
    const resolved = await service.request('media', { url: `pp://media/${asset.id}` })
    assert.equal(resolved.ok, true, JSON.stringify(resolved))
    return normalizedPixels(fs.readFileSync(resolved.data.file))
  }
  try {
    const ready = await service.start()
    assert.equal(ready.imageCapabilities.cutout, false); assert.equal(ready.imageCapabilities.localModels, false)
    const csv = path.join(directory, '名单.csv'); fs.writeFileSync(csv, '\ufeff编号,姓名\n001,张三\n', 'utf8')
    const inspect = await service.call('dataset:inspect', [csv]), datasetId = inspect.datasets[0].id
    await service.call('dataset:setPhotoMatchColumn', [{ datasetId, key: '编号' }])
    await service.call('photo:processingOptions', [{ datasetId, autoProcess: false }])
    const folder = path.join(directory, '照片'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, '001.png'), originalPng)
    await service.call('photo:importFolder', [{ datasetId, column: '编号', folder }])
    const report = await service.call('photo:report', [{ datasetId, column: '编号' }]), assetId = report.results[0].assetId
    assert.ok(assetId)
    const recipe = { width: 64, height: 64, cutout: true, faceAlign: false }
    const key = createHash('sha256').update(JSON.stringify({ source: assetId, recipe: normalizeRecipe(recipe), algorithm: VERSION, model: 'modnet-07c308cf' })).digest('hex')
    const legacyCache = JSON.stringify([{ key, sourceAssetId: assetId, assetId, restoreAssetId: assetId }])
    const legacyState = JSON.stringify([{ datasetId, column: '编号', recipe, model: 'fast', enabled: true, items: { [assetId]: assetId } }])
    const legacyPath = path.join(ready.dataDir, 'photo-processing-cache.json'), legacyStatePath = path.join(ready.dataDir, 'photo-processing.json')
    fs.writeFileSync(legacyPath, legacyCache); fs.writeFileSync(legacyStatePath, legacyState)
    const missing = await service.call('photo:processingGet', [{ datasetId }])
    assert.equal(missing.state, null, 'local-model applied state is not imported into host state')
    assert.deepEqual(missing.model, { ready: false, qualityReady: false, faceReady: false, name: 'DSH宿主图像服务', local: false, source: 'dsh-host', reason: '当前DSH宿主未注册抠图/人脸分析服务' })
    for (const unavailable of [{ ...recipe }, { ...recipe, cutout: false, faceAlign: true }]) {
      const result = await service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe: unavailable }] })
      assert.equal(result.error.code, 'HOST_IMAGE_UNAVAILABLE'); assert.match(result.error.message, /未注册/)
    }
    assert.equal(service.frames.some(frame => frame.event === 'host:imageRequest'), false)
    const plain = await service.call('photo:processingPreview', [{ datasetId, assetId, recipe: { ...recipe, cutout: false, edge: true } }])
    const plainImage = await readAsset(plain.asset)
    assert.deepEqual(plainImage.at(32, 32), color, 'native pixel work runs without any AI provider or local model')
    assert.ok(plainImage.at(0, 0)[3] < 255)

    // Test-only deterministic provider. This is not a current host capability.
    const unregister = registry.register({ id: 'test-mask-provider', version: '1', title: '测试透明 PNG', capabilities: { cutout: true, faceAlign: true }, async process(input) {
      if (input.operation === 'analyze') return { analysis: { faces: [{ x: 16, y: 8, w: 32, h: 32, eyes: [{ x: 24, y: 20 }, { x: 40, y: 20 }] }] } }
      const data = Buffer.alloc(input.width * input.height * 4)
      for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) data.set([0, 255, 255, x < 16 ? 0 : x < 32 ? 128 : 255], (y * input.width + x) * 4)
      return { imageBase64: pngFromPixels({ width: input.width, height: input.height, data }).toString('base64'), sourceHash: input.sourceHash }
    } })
    assert.equal((await service.request('hostCapabilities', { capabilities: registry.status() })).ok, true)
    assert.equal((await service.call('photo:processingGet', [{ datasetId }])).model.ready, true)
    const preview = service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe }] })
    const payload = await nextRequest('cutout')
    assert.equal(payload.width, 64); assert.equal(payload.height, 64)
    assert.equal((await reply(payload, await registry.process(payload))).data.accepted, true)
    const result = await preview
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.cached, false, 'matching legacy local cache is ignored')
    assert.equal(result.data.asset.width, 64); assert.equal(result.data.asset.height, 64)
    const cut = await readAsset(result.data.asset), restore = await readAsset(result.data.restoreAsset)
    assert.equal(cut.at(8, 32)[3], 0)
    assert.deepEqual(cut.at(24, 32), [201, 41, 17, 128])
    assert.deepEqual(cut.at(48, 32), color)
    for (const x of [8, 24, 48]) assert.deepEqual(restore.at(x, 32), color, 'restore PNG is made from original RGB and alpha')
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacyCache)
    assert.equal(fs.readFileSync(legacyStatePath, 'utf8'), legacyState)
    assert.ok(fs.readdirSync(ready.dataDir).some(name => name.startsWith('huashu-host-photo-processing-cache-')))

    const aligned = service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe: { ...recipe, cutout: false, faceAlign: true } }] })
    const analysisRequest = await nextRequest('analyze')
    await reply(analysisRequest, await registry.process(analysisRequest))
    const faceResult = await aligned
    assert.equal(faceResult.ok, true, JSON.stringify(faceResult)); assert.equal(faceResult.data.analysis.faceCount, 1)
    assert.ok(Math.abs(faceResult.data.analysis.factor - 0.6) < 1e-9, 'face transform uses the real test provider geometry')

    const invalid = service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe: { ...recipe, offsetX: 0.02 } }] })
    await reply(await nextRequest('cutout'), { imageBase64: originalPng.toString('base64') })
    assert.equal((await invalid).error.code, 'HOST_IMAGE_INVALID_RESULT', 'worker rejects a parent reply with no effective transparency')
    const unavailable = service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe: { ...recipe, offsetX: 0.04 } }] })
    await reply(await nextRequest('cutout'), null, { code: 'HOST_IMAGE_UNAVAILABLE', message: '测试提供方暂不可用' })
    assert.equal((await unavailable).error.code, 'HOST_IMAGE_UNAVAILABLE')

    const taskId = 'cancel-host-image'
    const applying = service.request('call', { name: 'photo:processingApply', args: [{ datasetId, sampleAssetId: assetId, taskId, incremental: true, recipe: { ...recipe, offsetX: 0.06 } }] })
    const canceledRequest = await nextRequest('cutout')
    assert.equal((await service.call('photo:processingCancel', [{ datasetId, taskId }])).canceled, true)
    assert.equal((await applying).data.canceled, true)
    await service.waitFrame(frame => frame.event === 'host:imageCancel' && frame.payload.requestId === canceledRequest.requestId)
    assert.equal((await reply(canceledRequest, { imageBase64: originalPng.toString('base64') })).data.accepted, false, 'cancel removes the pending reverse request')

    unregister()
    await service.request('hostCapabilities', { capabilities: registry.status() })
    assert.equal((await service.call('photo:processingGet', [{ datasetId }])).model.ready, false)
    assert.equal((await service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe }] })).error.code, 'HOST_IMAGE_UNAVAILABLE', 'cached host result cannot fake readiness after unregistration')
    const restoreRegistration = registry.register({ id: 'test-mask-provider', title: '仅用于 EOF 测试', capabilities: { cutout: true, faceAlign: false }, process: async () => { throw new Error('not called') } })
    await service.request('hostCapabilities', { capabilities: registry.status() })
    const waiting = service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe: { ...recipe, offsetX: 0.08 } }] })
    const eofRequest = await nextRequest('cutout')
    await service.stop(true)
    assert.equal((await waiting).error.code, 'HOST_IMAGE_ABORTED')
    assert.ok(service.frames.some(frame => frame.event === 'host:imageCancel' && frame.payload.requestId === eofRequest.requestId))
    assert.equal(fs.existsSync(path.join(ready.dataDir, 'data-dir.lock.json')), false)
    restoreRegistration()
  } finally { registry.dispose(); await service.dispose(); removeTemporary(directory) }
})

const PORTRAIT = process.env.HUASHU_PRINTPRESS_TEST_PORTRAIT || path.join(PRESSPRESS_CHECKOUT, '.workbuddy-ai', 'tmp', 'portrait-sample.jpg')
const realFastModel = { ...realElectron, skip: realElectron.skip || (!fs.existsSync(path.join(PRESSPRESS_CHECKOUT, 'build', 'models', 'modnet.onnx')) || !fs.existsSync(PORTRAIT) ? 'set an existing portrait fixture and install the original MODNet model to verify fast fallback' : false) }

test('real Electron uses only the existing MODNet fast fallback, reports its actual source, and prefers a host provider', realFastModel, async () => {
  const directory = tempDirectory(), guard = path.join(directory, 'fast-only.cjs')
  fs.writeFileSync(guard, `const original = require(${JSON.stringify(path.join(PRESSPRESS_CHECKOUT, 'electron', 'photo-processing-host.cjs'))})\nconst native = original.processPhoto, status = original.status\noriginal.status = () => ({...status(), qualityReady:true,faceReady:true})\noriginal.processPhoto = args => { if (args.recipe?.cutout && args.model !== 'fast') throw new Error('TEST_FORBIDDEN_QUALITY'); if (args.recipe?.faceAlign || args.analyzeReference) throw new Error('TEST_FORBIDDEN_LOCAL_FACE'); return native(args) }\noriginal.analyzePhoto = () => { throw new Error('TEST_FORBIDDEN_LOCAL_FACE') }\nrequire(${JSON.stringify(path.join(ROOT, 'lib', 'printpress-worker.cjs'))}).startWorker()\n`)
  const service = client({ directory, entry: guard, env: { HUASHU_PRINTPRESS_LOCAL_FAST_FALLBACK: '1' } })
  try {
    const ready = await service.start(), capability = (await service.request('imageCapabilities')).data
    assert.equal(capability.host.cutout, false); assert.equal(capability.fallback.ready, true)
    assert.equal(capability.effective.source, 'local-fast'); assert.equal(capability.effective.cutout, true)
    assert.equal(capability.effective.qualityReady, false); assert.equal(capability.effective.faceReady, false, 'YuNet presence is never claimed as host face analysis')
    assert.match(capability.effective.name, /MODNet/); assert.match(capability.effective.reason, /快速/)
    const csv = path.join(directory, '名单.csv'); fs.writeFileSync(csv, '\ufeff编号,姓名\n001,张三\n', 'utf8')
    const datasetId = (await service.call('dataset:inspect', [csv])).datasets[0].id
    await service.call('dataset:setPhotoMatchColumn', [{ datasetId, key: '编号' }])
    await service.call('photo:processingOptions', [{ datasetId, autoProcess: false }])
    const folder = path.join(directory, '照片'); fs.mkdirSync(folder); fs.copyFileSync(PORTRAIT, path.join(folder, '001.jpg'))
    await service.call('photo:importFolder', [{ datasetId, column: '编号', folder }])
    const assetId = (await service.call('photo:report', [{ datasetId, column: '编号' }])).results[0].assetId
    const recipe = { width: 384, height: 256, cutout: true, faceAlign: false }
    assert.equal((await service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe, model: 'quality' }] })).error.code, 'HOST_IMAGE_QUALITY_UNAVAILABLE')
    assert.equal((await service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe: { ...recipe, faceAlign: true }, model: 'fast' }] })).error.code, 'HOST_IMAGE_UNAVAILABLE')
    const result = await service.call('photo:processingPreview', [{ datasetId, assetId, recipe, model: 'fast' }])
    assert.equal(result.cached, false); assert.equal(result.analysis.source, 'local-fast')
    const media = await service.request('media', { url: `pp://media/${result.asset.id}` }), decoded = normalizedPixels(fs.readFileSync(media.data.file))
    assert.equal(decoded.width, 384); assert.equal(decoded.height, 256)
    let transparent = 0, opaque = 0, soft = 0
    for (let n = 3; n < decoded.data.length; n += 4) { const a = decoded.data[n]; if (a <= 5) transparent++; else if (a >= 250) opaque++; else soft++ }
    assert.ok(transparent > 20000 && opaque > 5000 && soft > 100, JSON.stringify({ transparent, opaque, soft }))
    const restoredMedia = await service.request('media', { url: `pp://media/${result.restoreAsset.id}` }), restore = normalizedPixels(fs.readFileSync(restoredMedia.data.file))
    for (let n = 3; n < restore.data.length; n += 4) assert.equal(restore.data[n], 255, 'fast fallback keeps an opaque restore from the original portrait')
    assert.equal(service.frames.some(frame => frame.event === 'host:imageRequest'), false)
    assert.ok(fs.readdirSync(ready.dataDir).some(name => name.startsWith('huashu-local-fast-photo-processing-cache-')))
    const applied = await service.call('photo:processingApply', [{ datasetId, sampleAssetId: assetId, recipe, model: 'fast', taskId: 'apply-fast' }])
    assert.equal(applied.applied, true)
    assert.ok(fs.readdirSync(ready.dataDir).some(name => name.startsWith('huashu-local-fast-photo-processing-') && !name.includes('cache')))
    assert.equal((await service.call('photo:processingGet', [{ datasetId }])).model.source, 'local-fast')

    await service.request('hostCapabilities', { capabilities: { provider: 'preferred-host', cutout: true, faceAlign: false } })
    const preferred = (await service.request('imageCapabilities')).data
    assert.equal(preferred.effective.source, 'dsh-host'); assert.equal(preferred.effective.qualityReady, true)
    const waiting = service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe, model: 'fast' }] })
    const hostRequest = await service.waitFrame(frame => frame.event === 'host:imageRequest' && frame.payload.operation === 'cutout')
    await service.request('hostImageResult', { requestId: hostRequest.payload.requestId, error: { code: 'TEST_HOST_FAILED', message: '宿主测试失败' } })
    assert.equal((await waiting).error.code, 'TEST_HOST_FAILED', 'a host error is explicit and never silently runs or caches local-fast under a host identity')
    assert.equal((await service.call('photo:processingGet', [{ datasetId }])).state, null, 'local-fast applied state cannot masquerade as host state')
    await service.stop()
  } finally { await service.dispose(); removeTemporary(directory) }
})

test('real Electron importImage preserves PNG/JPEG and EXIF bytes, converts WebP, and rejects paths or corrupt data', realElectron, async () => {
  const directory = tempDirectory(), service = client({ directory })
  try {
    await service.start()
    const jpeg = fs.readFileSync(path.join(PRESSPRESS_CHECKOUT, 'test', 'fixtures', 'design-portrait.jpg'))
    const inputs = [
      ['tiny.png', fs.readFileSync(path.join(PRESSPRESS_CHECKOUT, 'test', 'fixtures', 'tiny.png')), 'image/png'],
      ['portrait.jpg', jpeg, 'image/jpeg'],
      ['pixel.webp', Buffer.from('UklGRhwAAABXRUJQVlA4TA8AAAAvAUAAAAcQ9Y/+ByKi/wEA', 'base64'), 'image/png'],
    ]
    for (const [name, bytes, mime] of inputs) {
      const result = await service.request('importImage', { base64: bytes.toString('base64'), name })
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`)
      const asset = result.data.asset
      assert.ok(asset.id); assert.equal(asset.mime, mime); assert.equal(asset.source, 'ephemeral'); assert.ok(asset.name.endsWith(mime === 'image/jpeg' ? '.jpg' : '.png'))
      const media = await service.request('media', { url: `pp://media/${asset.id}` }), stored = fs.readFileSync(media.data.file)
      if (name.endsWith('.webp')) assert.equal(stored.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      else assert.deepEqual(stored, bytes, 'PNG/JPEG retain source bytes and metadata')
    }
    for (const orientation of [3, 5, 6, 7, 8]) {
      const bytes = withExifOrientation(jpeg, orientation)
      const result = await service.request('importImage', { base64: bytes.toString('base64'), name: `exif-${orientation}.jpg` })
      assert.equal(result.ok, true, JSON.stringify(result))
      const asset = result.data.asset
      assert.equal(asset.mime, 'image/jpeg'); assert.equal(asset.orientation, orientation)
      assert.equal(asset.width, orientation >= 5 ? 3 : 2); assert.equal(asset.height, orientation >= 5 ? 2 : 3)
      const media = await service.request('media', { url: `pp://media/${asset.id}` })
      assert.deepEqual(fs.readFileSync(media.data.file), bytes, `EXIF O=${orientation} survives import unchanged`)
    }
    for (const fields of [{ base64: Buffer.from('bad').toString('base64') }, { base64: 'not-base64' }, { base64: inputs[0][1].toString('base64'), filePath: path.join(directory, 'source.png') }]) assert.equal((await service.request('importImage', fields)).ok, false)
    assert.equal((await service.call('app:ping')).pong, true)
    await service.stop()
  } finally { await service.dispose(); removeTemporary(directory) }
})

test('real Electron EXIF JPEG is oriented once in host canonical pixels and local-fast transport', realElectron, async () => {
  const directory = tempDirectory(), guard = path.join(directory, 'orientation-guard.cjs')
  const jpeg = withExifOrientation(fs.readFileSync(path.join(PRESSPRESS_CHECKOUT, 'test', 'fixtures', 'design-portrait.jpg')), 6)
  // Transport-only stub: require original JPEG + O=6 at the local adapter, then
  // use real native non-AI pixels. The separate real MODNet test covers inference.
  fs.writeFileSync(guard, `const original = require(${JSON.stringify(path.join(PRESSPRESS_CHECKOUT, 'electron', 'photo-processing-host.cjs'))})\nconst native = original.processPhoto, expected = Buffer.from(${JSON.stringify(jpeg.toString('base64'))}, 'base64')\noriginal.status = () => ({ready:true,qualityReady:false,faceReady:false})\noriginal.processPhoto = args => { if (args.recipe?.cutout) { if (!Buffer.from(args.buffer).equals(expected) || args.asset.orientation !== 6 || args.model !== 'fast') throw new Error('TEST_DOUBLE_ORIENTED_LOCAL_INPUT'); return native({...args, recipe:{...args.recipe,cutout:false}}) } return native(args) }\nrequire(${JSON.stringify(path.join(ROOT, 'lib', 'printpress-worker.cjs'))}).startWorker()\n`)
  const service = client({ directory, entry: guard, env: { HUASHU_PRINTPRESS_LOCAL_FAST_FALLBACK: '1' } }), registry = createHostImages()
  const readAsset = async asset => {
    const media = await service.request('media', { url: `pp://media/${asset.id}` })
    assert.equal(media.ok, true, JSON.stringify(media)); return normalizedPixels(fs.readFileSync(media.data.file))
  }
  try {
    await service.start()
    const imported = await service.request('importImage', { base64: jpeg.toString('base64'), name: 'camera.jpg' })
    assert.equal(imported.ok, true, JSON.stringify(imported))
    assert.deepEqual([imported.data.asset.width, imported.data.asset.height, imported.data.asset.orientation], [3, 2, 6])
    const csv = path.join(directory, '名单.csv'); fs.writeFileSync(csv, '\ufeff编号,姓名\n001,张三\n', 'utf8')
    const datasetId = (await service.call('dataset:inspect', [csv])).datasets[0].id
    await service.call('dataset:setPhotoMatchColumn', [{ datasetId, key: '编号' }])
    await service.call('photo:processingOptions', [{ datasetId, autoProcess: false }])
    const folder = path.join(directory, '照片'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, '001.jpg'), jpeg)
    await service.call('photo:importFolder', [{ datasetId, column: '编号', folder }])
    const assetId = (await service.call('photo:report', [{ datasetId, column: '编号' }])).results[0].assetId
    const recipe = { width: 96, height: 64, cutout: true, faceAlign: false }
    const plain = await service.call('photo:processingPreview', [{ datasetId, assetId, recipe: { ...recipe, cutout: false } }])
    const baseline = await readAsset(plain.asset)
    const local = await service.call('photo:processingPreview', [{ datasetId, assetId, recipe, model: 'fast' }])
    assert.equal(local.analysis.source, 'local-fast')
    assert.deepEqual((await readAsset(local.restoreAsset)).data, baseline.data, 'local fallback receives original bytes/O=6 and its final restore is rotated once')

    const { pngFromPixels } = require(path.join(PRESSPRESS_CHECKOUT, 'electron', 'psd-import.cjs'))
    registry.register({ id: 'exif-test-provider', title: '方向测试服务', capabilities: { cutout: true, faceAlign: false }, async process(input) {
      assert.deepEqual([input.width, input.height], [3, 2], 'host input is canonical display coordinates, without another EXIF rotation')
      const rgba = normalizedPixels(Buffer.from(input.imageBase64, 'base64'))
      for (let y = 0; y < rgba.height; y++) for (let x = 0; x < rgba.width; x++) rgba.data[(y * rgba.width + x) * 4 + 3] = x === 0 ? 0 : 255
      return { imageBase64: pngFromPixels(rgba).toString('base64'), sourceHash: input.sourceHash }
    } })
    await service.request('hostCapabilities', { capabilities: registry.status() })
    const preview = service.request('call', { name: 'photo:processingPreview', args: [{ datasetId, assetId, recipe, model: 'fast' }] })
    const request = (await service.waitFrame(frame => frame.event === 'host:imageRequest')).payload
    assert.deepEqual([request.width, request.height], [3, 2]); assert.equal(request.orientation, undefined)
    await service.request('hostImageResult', { requestId: request.requestId, result: await registry.process(request) })
    const result = await preview
    assert.equal(result.ok, true, JSON.stringify(result))
    const rendered = await readAsset(result.data.asset), restored = await readAsset(result.data.restoreAsset)
    assert.deepEqual([rendered.width, rendered.height], [96, 64])
    assert.equal(rendered.at(8, 32)[3], 0); assert.equal(rendered.at(88, 32)[3], 255, 'left/right matte is not rotated into top/bottom')
    assert.deepEqual(restored.data, baseline.data, 'host restore pixels match the single-rotation native baseline')
    await service.stop()
  } finally { registry.dispose(); await service.dispose(); removeTemporary(directory) }
})

test('missing root emits a structured fatal frame without a window or data', realElectron, async () => {
  const directory = tempDirectory(), service = client({ directory, root: '' })
  try {
    const fatal = await service.waitFrame(frame => frame.event === 'fatal')
    assert.equal(fatal.error.code, 'BAD_ROOT')
    assert.equal((await service.done).code, 1)
    assert.equal(fs.existsSync(path.join(directory, 'data')), false)
    assert.deepEqual(service.invalid, [])
  } finally { await service.dispose(); removeTemporary(directory) }
})

// The browser loses its inspection token on refresh/retry, but the long-lived
// worker keeps the module-level PSD session for 15 minutes. psd-import refuses
// the 4th inspect with "待导入文件过多" (HTTP 400 in the workbench). The worker
// must evict its own oldest sessions so repeated imports never fail.
test('real Electron evicts stale import sessions so repeated inspections keep succeeding', realElectron, async t => {
  const psd = path.join(PRESSPRESS_CHECKOUT, '.workbuddy-ai', 'tmp', 'psd-fixtures', 'text-simple.psd')
  if (!fs.existsSync(psd)) { t.skip('PSD fixture is unavailable'); return }
  const directory = tempDirectory(), service = client({ directory })
  try {
    const info = await service.start()
    assert.ok(info.operations.includes('design:packageInspect'))
    const tokens = []
    for (let index = 0; index < 6; index++) {
      const frame = await service.request('call', { name: 'design:packageInspect', args: [{ filePath: psd }] })
      assert.equal(frame.ok, true, JSON.stringify(frame.error))
      assert.equal(typeof frame.data?.token, 'string')
      tokens.push(frame.data.token)
    }
    assert.equal(new Set(tokens).size, tokens.length, 'each retry receives a fresh inspection token')
    // The newest session is still committable; the oldest was evicted.
    const commit = await service.request('call', { name: 'design:packageCommit', args: [{ token: tokens.at(-1), fontDecisions: {}, rasterizeText: false }] })
    assert.equal(commit.ok, true, JSON.stringify(commit.error))
    assert.equal(commit.data?.revision, 1)
    await service.stop()
  } finally { await service.dispose(); removeTemporary(directory) }
})
