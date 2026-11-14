export const PRINTPRESS_API = '/huashu-design/printpress/api';

export async function printpressAction(action, args = {}, signal) {
  const response = await fetch(PRINTPRESS_API, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...args, action }), signal
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    const error = new Error(result.error?.message || `HTTP ${response.status}`);
    error.code = result.error?.code;
    error.status = response.status;
    throw error;
  }
  return result.data;
}

export function editorMode(item) {
  if (item.layeredEditable && !item.imageOnly) return 'layers';
  return item.imageEditable || item.imageOnly ? 'image' : null;
}

export function workPreviewUrl(item) {
  if (!item.url || !item.updatedAt) return item.url;
  return item.url + (item.url.includes('?') ? '&' : '?') + 'updatedAt=' + encodeURIComponent(item.updatedAt);
}

// Layered output is a per-creation user choice for every task. The composer
// defaults to the conventional 'standard' output; only an explicit selection
// requests a native editable .ppdesign project.
export function outputModeFor(_task, preference = 'standard') {
  return preference === 'layered' ? 'layered' : 'standard';
}

// Module-owned queue: React may enqueue before the Vue workbench has connected.
// A request stays queued until the original editor reports opened/canceled/failed.
export function createHandoffQueue() {
  const pending = [], listeners = new Set();
  let sequence = 0;
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    request(data) {
      if (!data?.item?.id || !data.designRef?.id || !Number.isInteger(data.designRef.revision) || data.designRef.revision < 1 || !data.artboard?.w || !data.artboard?.h) {
        throw new Error('Invalid PrintPress editor handoff.');
      }
      const request = { ...data, token: ++sequence };
      pending.push(request);
      notify();
      return request.token;
    },
    peek: () => pending[0] || null,
    acknowledge(token) {
      if (pending[0]?.token !== token) return false;
      pending.shift();
      notify();
      return true;
    },
    subscribe(listener) { listeners.add(listener); listener(); return () => listeners.delete(listener); }
  };
}

export const handoffQueue = createHandoffQueue();
export const requestPrintpressEdit = data => handoffQueue.request(data);

function bindingError(code) { const error = new Error(code); error.code = code; return error; }

// Save through the exposed component API so its revision and dirty state stay in sync.
export async function publishLinkedWork(binding, editor, publish = printpressAction) {
  if (!binding?.item?.id || !binding.designRef?.id || !editor) throw bindingError('HUASHU_EDITOR_NOT_READY');
  const expectedId = binding.designRef.id;
  if (editor.getCurrentId() !== expectedId) throw bindingError('HUASHU_PROJECT_CHANGED');
  const saved = await editor.saveForHuashu();
  if (saved?.id !== expectedId || editor.getCurrentId() !== expectedId) throw bindingError('HUASHU_PROJECT_CHANGED');
  if (!Number.isInteger(saved.revision) || saved.revision < 1) throw bindingError('HUASHU_EDITOR_NOT_READY');
  return publish('publish', { workId: binding.item.id, designId: saved.id, revision: saved.revision });
}
