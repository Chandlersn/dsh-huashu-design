// The embedded editor owns its DOM, event subscriptions and API. Nothing is
// installed on window.printpress or on the host document's theme.
let activeScope = null;
const realWindow = globalThis.window;
const realDocument = globalThis.document;
const inputEvents = new Set(['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut', 'pointerdown', 'mousedown', 'click']);
const keyEvents = new Set(['keydown', 'keyup', 'keypress']);

export function createScope(root, api) {
  if (activeScope) throw new Error('批印坊工作台已打开');
  const listeners = [];
  // Canvas layers are not focusable: clicking one leaves activeElement === body,
  // so keydown/keyup are dispatched with target === body. Only count that as
  // in-scope when nothing outside the workbench owns focus. A host chat/input
  // keeps activeElement on itself, so its keys still stay with the host.
  const belongs = event => {
    if (root.contains(event.target)) return true;
    if (event.target === realDocument.body) {
      const active = realDocument.activeElement;
      if (root.contains(active)) return true;
      if (keyEvents.has(event.type) && active === realDocument.body) return true;
    }
    return false;
  };
  function add(target, type, listener, options) {
    const wrapped = inputEvents.has(type) ? event => { if (belongs(event)) typeof listener === 'function' ? listener(event) : listener.handleEvent(event); } : listener;
    listeners.push({ target, type, listener, wrapped, options });
    target.addEventListener(type, wrapped, options);
  }
  function remove(target, type, listener, options) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    for (let i = listeners.length - 1; i >= 0; i--) {
      const item = listeners[i];
      if (item.target === target && item.type === type && item.listener === listener && (typeof item.options === 'boolean' ? item.options : !!item.options?.capture) === capture) {
        target.removeEventListener(type, item.wrapped, item.options); listeners.splice(i, 1);
      }
    }
  }
  activeScope = { root, api, add, remove };
  return () => {
    for (const item of listeners) item.target.removeEventListener(item.type, item.wrapped, item.options);
    listeners.length = 0;
    activeScope = null;
  };
}
function bind(value, owner) { return typeof value === 'function' ? value.bind(owner) : value; }
export const ppDocument = new Proxy({}, {
  get(_target, property) {
    const scope = activeScope;
    if (property === 'querySelector') return selector => scope?.root.querySelector(selector) || null;
    if (property === 'querySelectorAll') return selector => scope?.root.querySelectorAll(selector) || [];
    if (property === 'getElementById') return id => scope?.root.querySelector('#' + CSS.escape(id)) || null;
    if (property === 'body' || property === 'documentElement') return scope?.root;
    if (property === 'activeElement') return scope?.root.contains(realDocument.activeElement) ? realDocument.activeElement : null;
    if (property === 'addEventListener') return (type, listener, options) => scope?.add(realDocument, type, listener, options);
    if (property === 'removeEventListener') return (type, listener, options) => scope?.remove(realDocument, type, listener, options);
    return bind(realDocument[property], realDocument);
  }
});
export const ppWindow = new Proxy({}, {
  get(_target, property) {
    const scope = activeScope;
    if (property === 'printpress') return scope?.api;
    if (property === 'document') return ppDocument;
    if (property === 'addEventListener') return (type, listener, options) => scope?.add(realWindow, type, listener, options);
    if (property === 'removeEventListener') return (type, listener, options) => scope?.remove(realWindow, type, listener, options);
    return bind(realWindow[property], realWindow);
  }
});
