import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_IMAGE = 64 * 1024 * 1024;
const MAX_PROJECT = 256 * 1024 * 1024;
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

// Only registered real files and explicitly requested output paths are accepted.
async function checkPath(file, { createParents = false, directory = false } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw error('UNSAFE_PATH', '工程文件必须使用绝对路径', 403);
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    const parent = index < parts.length - 1;
    let stat;
    try { stat = await fs.lstat(current); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      if ((parent || directory) && createParents) { await fs.mkdir(current).catch(cause => { if (cause.code !== 'EEXIST') throw cause; }); stat = await fs.lstat(current); }
      else if (!parent && !directory && createParents) return absolute;
      else throw error('FILE_NOT_FOUND', '已关联的图片或图层工程不存在，请重新登记作品', 404);
    }
    if (stat.isSymbolicLink() || (parent || directory ? !stat.isDirectory() : !stat.isFile())) throw error('UNSAFE_PATH', '工程文件及其父目录不能是目录链接或非普通文件', 403);
  }
  if (pathKey(await fs.realpath(absolute)) !== pathKey(absolute)) throw error('UNSAFE_PATH', '工程文件的真实位置已改变', 403);
  return absolute;
}
async function readFile(file, extensions, maximum, bytes = false) {
  if (!extensions.has(path.extname(file).toLowerCase())) throw error('UNSUPPORTED_FILE', '此文件不支持所选编辑方式', 415);
  const absolute = await checkPath(file);
  const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) throw error('FILE_TOO_LARGE', '图片或工程文件超出可编辑大小', 413);
    const content = bytes ? await handle.readFile() : undefined;
    await checkPath(absolute);
    const current = await fs.stat(absolute), after = await handle.stat();
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || (content && content.length !== before.size)) throw error('FILE_CHANGED', '文件在读取时发生变化，请重新打开', 409);
    return { file: absolute, info: after, ...(content ? { bytes: content } : {}) };
  } finally { await handle.close(); }
}
async function outputPath(file, extension) {
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== extension) throw error('INVALID_OUTPUT', `输出路径必须以 ${extension} 结尾`);
  const absolute = await checkPath(file, { createParents: true });
  try { await fs.lstat(absolute); throw error('OUTPUT_EXISTS', '目标文件已经存在，请使用新路径；原交付文件会保留', 409); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  return absolute;
}

export function layeredGuide() {
  return {
    format: 'PrintPress native editable design + PNG + .ppdesign',
    units: { positionsAndSizes: 'mm', fontSizeAndLetterSpacing: 'pt', imageWidthHeight: 'px', conversion: 'mm=px*25.4/dpi; pt=px*72/dpi; use the same dpi for publish' },
    rules: [
      'For a layered graphic, keep headings/body text as text layers, shapes as rect/ellipse/line, and each photo as a separate image layer. Do not flatten the entire design to one image and call it layered.',
      'Layer order is bottom to top. IDs must be distinct ASCII letters/digits/underscore/hyphen. Colors are hexadecimal, transparent or none.',
      'Call design:importBytes for PNG/JPEG assets first; use the returned full asset record in assets[asset.id]. Every image layer points to assetId. Do not invent local asset paths.',
      'Call font:list and choose actual family names from system/uploaded fonts before creating text. Upload a required font explicitly when needed; do not assume arbitrary browser fonts are portable.',
      'Save with call design:save, params:{design:<complete document>}, allowWrite:true. Updates must keep id and the loaded revision; do not overwrite with an invented revision.',
      'Call publish with designId, saved revision, title, module and allowWrite:true. Optional previewPath (.png) and projectPath (.ppdesign) must be absolute unused output paths. publish exports both and registers the same editable work. Pass workId to update an existing work.',
      'handoff(workId,allowWrite:true) opens or imports an existing registered project; exported raster images remain raster images, with crop/erase/repair tools instead of recovered text layers.',
      'Use guide to discover the native contract; use capabilities to discover the host image provider. AI prefers a real registered DSH image provider. If host cutout is unavailable, only the original fast MODNet model may be used as an explicitly labelled fallback; face analysis still requires a host provider.'
    ],
    example: {
      schemaVersion: 1, name: 'Editable graphic', artboard: { w: 182.88, h: 243.84, background: '#f4f4f5' }, assets: {},
      layers: [
        { id: 'panel', type: 'rect', name: 'Panel', x: 10, y: 10, w: 162.88, h: 223.84, fill: '#ffffff', stroke: 'transparent', strokeWidth: 0, radius: 4 },
        { id: 'title', type: 'text', name: 'Title', x: 20, y: 24, w: 142, h: 24, text: '可编辑标题', fontFamily: '微软雅黑', fontSize: 28, bold: true, color: '#18181b', align: 'left' },
        { id: 'accent', type: 'rect', name: 'Accent', x: 20, y: 56, w: 40, h: 2, fill: '#2563eb', stroke: 'transparent', strokeWidth: 0 }
      ]
    },
    exampleOutput: { dpi: 150, width: 1080, height: 1440 },
    optionalLayerFields: {
      common: 'rotation,opacity,visible,locked,blend',
      text: 'fontFamily,fontSize,bold,color,align,lineHeight,letterSpacing',
      shape: 'fill,stroke,strokeWidth,radius; rect/ellipse may use fillPaint:{type:linear,angle,stops:[{offset:0,color},{offset:1,color}]} and shadow:{dxMm,dyMm,blurMm,color,opacity}',
      image: 'assetId,crop:{x:0,y:0,w:1,h:1},flipX,flipY,adjust:{brightness,contrast,saturate,grayscale,invert}; crop is fraction of original image'
    }
  };
}

export function createWorkEditor(operations, runtime) {
  const queues = new Map();
  const invoke = (name, params, write = false) => runtime.operation('invoke', { name, params, allowWrite: write });
  async function serial(key, run) {
    const previous = queues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(run); queues.set(key, result);
    try { return await result; } finally { if (queues.get(key) === result) queues.delete(key); }
  }
  async function currentWork(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw error('INVALID_WORK', '请选择作品库里的作品');
    return (await operations.workFile(id)).item;
  }
  async function targetPair(args, item, design) {
    const base = path.join(path.dirname(operations.libraryPath), 'projects', item?.id || design.id);
    const stem = `r${design.revision}-${randomUUID().slice(0, 8)}`;
    return {
      previewPath: await outputPath(args.previewPath || path.join(base, `${stem}.png`), '.png'),
      projectPath: await outputPath(args.projectPath || path.join(base, `${stem}.ppdesign`), '.ppdesign')
    };
  }
  async function bind(item, projectPath, design, previewPath) {
    const info = await runtime.start();
    const designRef = { id: design.id, revision: design.revision, dataDir: info.dataDir };
    const imageOnly = design.layers.length === 1 && design.layers[0].type === 'image';
    const saved = await operations.operation('linkProject', { id: item.id, projectPath, designRef, imageOnly, ...(previewPath ? { previewPath } : {}) });
    return { item: saved.item, designRef: { id: design.id, revision: design.revision }, imageOnly };
  }
  async function packageFile(item) {
    const project = item.projectPath || (path.extname(item.path).toLowerCase() === '.ppdesign' ? item.path : null);
    if (!project) throw error('NO_LAYERED_PROJECT', '这个作品还没有可编辑图层工程', 404);
    return (await readFile(project, new Set(['.ppdesign']), MAX_PROJECT)).file;
  }
  async function handoff(args) {
    return serial(`work:${args.workId}`, async () => {
      let item = await currentWork(args.workId);
      const info = await runtime.start();
      let design;
      if (item.designRef && pathKey(item.designRef.dataDir) === pathKey(info.dataDir)) {
        // The latest saved revision includes native-editor saves made after a previous handoff.
        try { design = await invoke('design:get', { id: item.designRef.id }); }
        catch (cause) { if (!item.projectPath && path.extname(item.path).toLowerCase() !== '.ppdesign') throw cause; }
      }
      if (!design && (item.projectPath || path.extname(item.path).toLowerCase() === '.ppdesign')) {
        const filePath = await packageFile(item);
        const inspected = await invoke('design:packageInspect', { filePath }, true);
        try {
          const ref = await invoke('design:packageCommit', { token: inspected.token, name: item.title }, true);
          design = await invoke('design:get', { id: ref.id, revision: ref.revision });
        } catch (cause) {
          await invoke('design:packageCancel', { token: inspected.token }, true).catch(() => {});
          throw cause;
        }
      }
      if (!design) {
        const input = await readFile(item.path, IMAGE_EXTENSIONS, MAX_IMAGE, true);
        const imported = await runtime.request('importImage', { base64: input.bytes.toString('base64'), name: path.basename(item.path) });
        const asset = imported.asset;
        const dpi = 150, scale = Math.max(1, dpi / (25.4 * Math.min(asset.width, asset.height)));
        const w = Math.max(1, asset.width * 25.4 / dpi * scale), h = Math.max(1, asset.height * 25.4 / dpi * scale);
        const draft = { name: item.title.slice(0, 120), artboard: { w, h, background: 'transparent' }, assets: { [asset.id]: asset }, layers: [{ id: 'original-image', type: 'image', name: item.title.slice(0, 120), assetId: asset.id, x: 0, y: 0, w, h }] };
        const ref = await invoke('design:save', { design: draft }, true);
        design = await invoke('design:get', { id: ref.id, revision: ref.revision });
      }
      let projectPath = item.projectPath || (path.extname(item.path).toLowerCase() === '.ppdesign' ? item.path : null);
      if (!projectPath) {
        const base = path.join(path.dirname(operations.libraryPath), 'projects', item.id);
        projectPath = await outputPath(path.join(base, `original-${randomUUID().slice(0, 8)}.ppdesign`), '.ppdesign');
        await invoke('design:packageExport', { id: design.id, revision: design.revision, taskId: randomUUID(), filePath: projectPath }, true);
      }
      const linked = await bind(item, projectPath, design);
      const mode = linked.imageOnly ? 'image' : 'layers';
      return { ...linked, artboard: design.artboard, mode, openImageEditor: mode === 'image', layerCount: design.layers.length };
    });
  }
  async function publish(args) {
    if (typeof args.designId !== 'string' || !/^design_[a-f0-9]{24}$/.test(args.designId) || !Number.isSafeInteger(args.revision) || args.revision < 1) throw error('INVALID_DESIGN_REF', '请先保存当前图层工程，再发布该版本');
    return serial(args.workId ? `work:${args.workId}` : `design:${args.designId}`, async () => {
      let item = args.workId ? await currentWork(args.workId) : null;
      const engine = await runtime.start();
      if (item?.designRef && (item.designRef.id !== args.designId || pathKey(item.designRef.dataDir) !== pathKey(engine.dataDir))) throw error('PROJECT_MISMATCH', '当前工程与作品关联不一致，请从作品卡片重新进入编辑器', 409);
      const design = await invoke('design:get', { id: args.designId, revision: args.revision });
      if (args.requireLayers === true && design.layers.length < 2) throw error('NOT_LAYERED', '分图层交付至少需要两个独立可编辑图层，不能把整张图片套成工程');
      const dpi = args.dpi ?? 150;
      if (![150, 300, 600].includes(dpi)) throw error('INVALID_DPI', '出图分辨率须为150、300或600 DPI');
      const paths = await targetPair(args, item, design);
      await invoke('design:packageExport', { id: design.id, revision: design.revision, taskId: randomUUID(), filePath: paths.projectPath, includeFonts: true }, true);
      await invoke('design:exportPng', { design, dpi, format: 'png', filePath: paths.previewPath, transparent: design.artboard.background === 'transparent' }, true);
      await readFile(paths.previewPath, new Set(['.png']), MAX_IMAGE);
      await readFile(paths.projectPath, new Set(['.ppdesign']), MAX_PROJECT);
      if (!item) item = (await operations.operation('add', { title: args.title || design.name, path: paths.previewPath, projectPath: paths.projectPath, module: args.module || 'infographic', ...(args.style ? { style: args.style } : {}), note: '可编辑图层工程与预览；通过批印坊继续编辑。' })).item;
      const linked = await bind(item, paths.projectPath, design, paths.previewPath);
      return { ...linked, ...paths, layerCount: design.layers.length, dpi };
    });
  }
  async function projectFile(id) {
    const item = await currentWork(id);
    return { file: await packageFile(item), mime: 'application/octet-stream', attachment: true };
  }
  return { handoff, publish, projectFile, guide: layeredGuide };
}
