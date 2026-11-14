import { bindPreload } from './preload.generated.js';
import { toUserMessage } from '@printpress-domain/user-error.cjs';

export const PRINTPRESS_BASE = '/huashu-design/printpress';
export const MEDIA_BASE = PRINTPRESS_BASE + '/media/';
export function mapMedia(value, browser = true) {
  if (typeof value === 'string') return browser ? value.replaceAll('pp://media/', MEDIA_BASE) : value.replaceAll(MEDIA_BASE, 'pp://media/');
  if (Array.isArray(value)) return value.map(item => mapMedia(item, browser));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapMedia(item, browser)]));
  return value;
}
// The browser bridge crosses JSON; desktop Electron IPC used structured clone.
// A missing optional argument must arrive as "absent", not null: JSON.stringify
// turns [id, undefined] into [id, null], and domains that distinguish undefined
// from null (design:get(id, revision)) then reject with
// "底图版本不存在或尚未提交" — a failure the standalone app never had.
export function forTransport(value) {
  if (Array.isArray(value)) {
    const mapped = value.map(forTransport);
    while (mapped.length && mapped.at(-1) === undefined) mapped.pop();
    return mapped;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, forTransport(item)]));
  }
  return value;
}
export function createBridge({ onEvent = () => {} } = {}) {
  const handlers = new Map();
  let disposed = false;
  const stream = new EventSource(PRINTPRESS_BASE + '/events', { withCredentials: true });
  stream.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      onEvent(message);
      for (const callback of handlers.get(message.event) || []) callback(null, mapMedia(message.payload));
    } catch (error) { onEvent({ event: 'bridge:error', payload: { message: error.message } }); }
  };
  stream.onerror = () => onEvent({ event: 'bridge:reconnecting', payload: {} });
  const ipcRenderer = {
    on(channel, callback) { if (!handlers.has(channel)) handlers.set(channel, new Set()); handlers.get(channel).add(callback); },
    removeListener(channel, callback) { handlers.get(channel)?.delete(callback); }
  };
  async function transport(body) {
    if (disposed) throw new Error('批印坊工作台已关闭，请重新打开');
    const response = await fetch(PRINTPRESS_BASE + '/api', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forTransport(mapMedia(body, false)))
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const error = new Error(result.error?.message || `批印坊请求失败（${response.status}）`);
      error.code = result.error?.code;
      error.status = response.status;
      error.operation = body?.name;
      // The browser console only shows "400 (Bad Request)" for a fetch. Log the
      // domain error itself so a failed import/load can be diagnosed from the
      // real code and message instead of guessing from the HTTP status.
      console.error('[PrintPress]', body?.name || body?.action, response.status, error.code, error.message);
      throw error;
    }
    return mapMedia(result.data);
  }
  async function invoke(name, ...args) {
    try { return await transport({ action: 'call', name, args }); }
    catch (error) { const wrapped = new Error(toUserMessage(error)); wrapped.code = error.code; wrapped.status = error.status; wrapped.operation = error.operation; wrapped.userFacing = true; wrapped.cause = error; throw wrapped; }
  }
  const api = bindPreload(invoke, ipcRenderer);
  api.stageFile = async file => {
    if (!/\.(csv|xlsx?|xlsm)$/i.test(file.name)) throw new Error('请拖入 Excel 或 CSV 名单文件');
    if (file.size > 64 * 1024 * 1024) throw new Error('名单文件超过 64 MB，请拆分后导入');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return transport({ action: 'upload', name: file.name, base64: btoa(text) });
  };
  api.samplePixel = async () => {
    if (!globalThis.EyeDropper) throw new Error('当前浏览器不支持屏幕取色，请使用颜色输入框');
    const { sRGBHex } = await new EyeDropper().open();
    return { color: sRGBHex };
  };
  return { api, connect: () => transport({ action: 'start' }), dispose() { disposed = true; stream.close(); handlers.clear(); } };
}
