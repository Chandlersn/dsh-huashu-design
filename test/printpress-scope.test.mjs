import test from 'node:test';
import assert from 'node:assert/strict';

// The embedded editor proxies window/document through scope.js. Its keydown
// filter must let canvas shortcuts (Delete / arrows / undo) through when the
// canvas has been clicked but focus stayed on <body>, while never stealing keys
// from the host's own inputs. Reproduce both ends with a minimal DOM.
function target(name) {
  const listeners = [];
  return {
    name, listeners,
    addEventListener(type, fn, opts) { listeners.push({ type, fn, opts }); },
    removeEventListener(type, fn) { const i = listeners.findIndex(x => x.type === type && x.fn === fn); if (i >= 0) listeners.splice(i, 1); },
    dispatch(type, event) { for (const item of [...listeners]) if (item.type === type) item.fn(event); }
  };
}
const win = target('window'), doc = target('document');
doc.body = { name: 'body' };
doc.documentElement = { name: 'html' };
doc.activeElement = doc.body;
globalThis.window = win;
globalThis.document = doc;

const { createScope, ppWindow, ppDocument } = await import('../src/printpress/scope.js');

const inside = new Set();
const root = { contains(node) { return !!node && inside.has(node); } };
const canvasLayer = { name: 'layer-hit' }, hostInput = { name: 'host-chat-input' };
inside.add(canvasLayer);

// createScope is a single active scope; each test owns one lifecycle.
function withScope(fn) {
  const dispose = createScope(root, {});
  try { return fn(dispose); } finally { dispose(); }
}
function keydownHits(eventTarget, active) {
  doc.activeElement = active;
  let hits = 0;
  const listener = () => { hits++; };
  ppWindow.addEventListener('keydown', listener);
  win.dispatch('keydown', { type: 'keydown', target: eventTarget, key: 'Delete' });
  ppWindow.removeEventListener('keydown', listener);
  return hits;
}

test('canvas shortcuts reach the editor after clicking a non-focusable layer (activeElement stays body)', () => withScope(() => {
  assert.equal(keydownHits(canvasLayer, doc.body), 1, 'a key pressed on a selected layer reaches the editor');
  assert.equal(keydownHits(doc.body, doc.body), 1, 'Delete/Arrow after a canvas click must not be swallowed');
  assert.equal(keydownHits(doc.body, canvasLayer), 1, 'focus inside the workbench is always in scope');
}));

test('host input focus is never stolen, and dispose releases every proxied listener', () => withScope(dispose => {
  assert.equal(keydownHits(hostInput, hostInput), 0, 'typing in the host composer must not delete a canvas layer');
  assert.equal(keydownHits(doc.documentElement, hostInput), 0, 'a host-owned input stays out of scope for document-level events');
  // Keep a resident listener to observe teardown.
  ppWindow.addEventListener('keydown', () => {});
  ppDocument.addEventListener('paste', () => {});
  assert.ok(win.listeners.length > 0 && doc.listeners.length > 0);
  dispose();
  assert.equal(win.listeners.length, 0, 'dispose removes the proxied window listeners');
  assert.equal(doc.listeners.length, 0, 'dispose removes the proxied document listeners');
}));

test('ppDocument.activeElement reflects the scoped focus and querySelector stays inside root', () => withScope(() => {
  doc.activeElement = canvasLayer;
  assert.equal(ppDocument.activeElement, canvasLayer);
  doc.activeElement = hostInput;
  assert.equal(ppDocument.activeElement, null, 'host focus is not exposed as editor focus');
  assert.equal(ppDocument.body, root);
}));
