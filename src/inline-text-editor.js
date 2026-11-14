/**
 * Install in a trusted, isolated full-screen preview after DOM ready. Keep all
 * helpers inside: the preview bridge serializes this function with toString().
 * Only raw source documents are saved; live preview markup/assets are never
 * serialized. readSource/writeSource own the work association and revision CAS.
 */
export function installInlineTextEditor({ readSource, writeSource, storage, storageKey, onState } = {}) {
  if (typeof readSource !== 'function' || typeof writeSource !== 'function' || typeof storageKey !== 'string' || !storageKey) throw new Error('文字编辑需要本作品的源码接口和独立草稿键。');
  const doc = document, win = window, limit = 128 * 1024;
  const excluded = new Set(['SCRIPT', 'STYLE', 'SVG', 'MATH', 'IMG', 'PICTURE', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'TEMPLATE', 'NOSCRIPT', 'HEAD']);
  const edits = new Map(), touched = new Map();
  let disposed = false, active = null, source = null, sourceDocument = null, blockedDraft = false, savingPromise = null, composing = false;
  let state = { dirty: false, saving: false, saved: false, error: null };
  const problem = (code, message) => Object.assign(new Error(message), { code });
  const bytes = value => new TextEncoder().encode(value).length;
  const keyFor = path => path.join('.');
  const tag = node => String(node?.localName || node?.nodeName || '').toUpperCase();
  const valueOf = node => node?.nodeType === 3 ? String(node.nodeValue ?? '') : null;
  const copyEdit = edit => ({ textPath: [...edit.textPath], before: edit.before, value: edit.value });
  function emit(patch = {}) {
    if (disposed) return;
    state = { ...state, ...patch, dirty: edits.size > 0 || blockedDraft };
    try { onState?.({ ...state }); } catch { /* A view callback cannot change persistence. */ }
  }
  function errorMessage(error) {
    if (error?.code === 'SOURCE_CONFLICT' || /REVISION|CONFLICT/.test(String(error?.code || '')) || error?.status === 409) return '原文件已变化，未覆盖文件；你的修改仍保留在草稿中，请重新打开后核对。';
    return String(error?.message || error || '文字修改未能保存，草稿仍保留。');
  }
  function parse(content) {
    if (typeof content !== 'string' || bytes(content) > limit) throw problem('SOURCE_SIZE', '原稿不是可编辑 HTML，或已超过 128 KiB 保存上限。');
    const parsed = new DOMParser().parseFromString(content, 'text/html');
    if (!parsed?.body || !parsed.documentElement) throw problem('SOURCE_INVALID', '无法解析本作品的 HTML 原稿。');
    return parsed;
  }
  function checkedSource(result) {
    if (!result || typeof result.content !== 'string' || typeof result.revision !== 'string' || !result.revision) throw problem('SOURCE_INVALID', '源码接口没有返回原稿和版本，请重新打开作品。');
    return { content: result.content, revision: result.revision };
  }
  function nodeAt(root, path) {
    let node = root;
    for (const index of path) { node = node?.childNodes?.[index]; if (!node) return null; }
    return node;
  }
  function pathOf(node) {
    const path = [];
    while (node && node !== doc.body) {
      const parent = node.parentNode;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.childNodes, node);
      if (index < 0) return null;
      path.unshift(index); node = parent;
    }
    return node === doc.body && path.length ? path : null;
  }
  function allowed(node) {
    for (let parent = node?.nodeType === 1 ? node : node?.parentNode; parent && parent !== doc.body; parent = parent.parentNode) {
      if (excluded.has(tag(parent))) return false;
      if (parent.nodeType === 1 && parent.hasAttribute('contenteditable') && parent !== active?.wrapper) return false;
    }
    return !!pathOf(node);
  }
  function virtual(node) {
    if (node !== active?.wrapper) return node;
    active.text.nodeValue = String(active.wrapper.textContent ?? '');
    return active.text;
  }
  function visibleValue(path) {
    const node = nodeAt(doc.body, path);
    return node === active?.wrapper ? String(active.wrapper.textContent ?? '') : valueOf(node);
  }
  // Preview head policy/scripts and inlined img URLs differ from source. Map
  // only body childNodes and check text + element/id structure, never URLs.
  function corresponds(parsed, path, before, expected) {
    let raw = parsed.body, live = doc.body;
    for (let depth = 0; depth < path.length; depth++) {
      if (!raw || !live || tag(raw) !== tag(live)) return false;
      const rawId = raw.getAttribute?.('id');
      if (rawId && rawId !== live.getAttribute?.('id')) return false;
      const index = path[depth];
      if (depth === path.length - 1) {
        if (raw.childNodes.length !== live.childNodes.length) return false;
        for (let n = 0; n < raw.childNodes.length; n++) {
          const a = raw.childNodes[n], b = virtual(live.childNodes[n]);
          if (!b || a.nodeType !== b.nodeType || a.nodeType === 1 && tag(a) !== tag(b)) return false;
          if (a.nodeType === 1 && a.getAttribute('id') && a.getAttribute('id') !== b.getAttribute('id')) return false;
          if (a.nodeType === 3 && n !== index) {
            const siblingPath = [...path.slice(0, -1), n], changed = edits.get(keyFor(siblingPath));
            if (valueOf(b) !== (changed ? changed.value : valueOf(a))) return false;
          }
        }
      }
      raw = raw.childNodes?.[index]; live = virtual(live.childNodes?.[index]);
      if (!raw || !live || raw.nodeType !== live.nodeType) return false;
    }
    return raw.nodeType === 3 && valueOf(raw) === before && visibleValue(path) === expected;
  }
  function persist() {
    try {
      if (!storage || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') throw new Error('浏览器草稿存储不可用');
      if (!edits.size && !blockedDraft) storage.removeItem(storageKey);
      else if (!blockedDraft) {
        const draft = JSON.stringify({ version: 1, revision: source.revision, edits: [...edits.values()].map(copyEdit) });
        if (bytes(storageKey) + bytes(draft) > limit) throw new Error('草稿超过 128 KiB');
        storage.setItem(storageKey, draft);
      }
      return null;
    } catch { return '浏览器草稿未能保存，请保持此预览打开并点击“保存修改”。'; }
  }
  function change(path, before, value) {
    const key = keyFor(path), item = { textPath: [...path], before, value: String(value) };
    touched.set(key, item);
    if (item.value === before) edits.delete(key); else edits.set(key, item);
    emit({ saved: false, error: persist() });
  }
  function commitActive() {
    const current = active;
    if (!current) return;
    const value = String(current.wrapper.textContent ?? '');
    active = null; composing = false;
    if (current.wrapper.parentNode) current.wrapper.parentNode.replaceChild(doc.createTextNode(value), current.wrapper);
    change(current.path, current.before, value);
  }
  function candidate(event) {
    let target = event.target;
    if (!target || !allowed(target)) return null;
    for (const lookup of ['caretRangeFromPoint', 'caretPositionFromPoint']) {
      try {
        const caret = doc[lookup]?.(event.clientX, event.clientY), node = caret?.startContainer || caret?.offsetNode;
        if (node?.nodeType === 3 && (node === target || target.contains?.(node)) && allowed(node)) return node;
      } catch { /* Fall back only to an unambiguous direct text child. */ }
    }
    if (target.nodeType === 3) return target;
    const direct = Array.from(target.childNodes || []).filter(node => node.nodeType === 3 && valueOf(node).trim());
    return direct.length === 1 ? direct[0] : null;
  }
  async function begin(event) {
    const text = candidate(event);
    if (!text || !valueOf(text)?.trim() || active?.wrapper.contains?.(text)) return;
    event.preventDefault(); event.stopPropagation();
    await initialized;
    if (disposed) return;
    if (!source || blockedDraft) { emit({ saved: false, error: state.error || '原稿或未恢复的草稿存在冲突，暂不能编辑这段文字。' }); return; }
    commitActive();
    const path = pathOf(text), key = path && keyFor(path), raw = path && nodeAt(sourceDocument.body, path);
    const before = valueOf(raw), expected = edits.get(key)?.value ?? before;
    if (!path || before === null || !corresponds(sourceDocument, path, before, expected) || valueOf(text) !== expected) {
      emit({ saved: false, error: '这段文字已由页面动态生成或改动，无法可靠对应原稿；现有草稿仍保留。' }); return;
    }
    const wrapper = doc.createElement('span');
    wrapper.setAttribute('data-huashu-inline-editor', '');
    wrapper.setAttribute('contenteditable', 'plaintext-only');
    wrapper.setAttribute('spellcheck', 'false');
    wrapper.setAttribute('style', 'outline:2px solid currentColor;outline-offset:2px;cursor:text;');
    wrapper.textContent = expected;
    const current = { path, before, wrapper, text: doc.createTextNode(expected) };
    text.parentNode.replaceChild(wrapper, text); active = current;
    wrapper.addEventListener('blur', () => { if (active === current) commitActive(); });
    wrapper.focus?.();
    try {
      const selection = win.getSelection?.(), range = doc.createRange();
      range.selectNodeContents(wrapper); selection?.removeAllRanges(); selection?.addRange(range);
    } catch { /* Editing also works without programmatic text selection. */ }
    emit({ saved: false, error: null });
  }
  function input(event) {
    if (!disposed && active && (event.target === active.wrapper || active.wrapper.contains?.(event.target))) change(active.path, active.before, active.wrapper.textContent ?? '');
  }
  function paste(event) {
    if (!active || !(event.target === active.wrapper || active.wrapper.contains?.(event.target))) return;
    const plain = event.clipboardData?.getData('text/plain');
    if (typeof plain !== 'string') return;
    event.preventDefault();
    try {
      const selection = win.getSelection?.(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (range && active.wrapper.contains(range.commonAncestorContainer)) {
        range.deleteContents(); const text = doc.createTextNode(plain); range.insertNode(text); range.setStartAfter(text); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
      } else active.wrapper.textContent += plain;
    } catch { active.wrapper.textContent += plain; }
    input({ target: active.wrapper });
  }
  function click(event) {
    if (disposed || !allowed(event.target)) return;
    for (let node = event.target?.nodeType === 3 ? event.target.parentNode : event.target; node && node !== doc.body; node = node.parentNode) {
      if ((tag(node) === 'A' || tag(node) === 'BUTTON') && String(node.textContent || '').trim()) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
    }
  }
  function compositionStart(event) {
    if (active && (event.target === active.wrapper || active.wrapper.contains?.(event.target))) composing = true;
  }
  function compositionEnd(event) {
    if (active && (event.target === active.wrapper || active.wrapper.contains?.(event.target))) { composing = false; input(event); }
  }
  function keydown(event) {
    if (disposed || composing || event.isComposing || event.keyCode === 229 || event.which === 229) return;
    if ((event.ctrlKey || event.metaKey) && String(event.key || '').toLowerCase() === 's') {
      event.preventDefault(); event.stopImmediatePropagation(); void save().catch(() => {});
    } else if (active && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); commitActive();
    }
  }
  function serialize(parsed) {
    let html = '';
    for (const node of Array.from(parsed.childNodes)) {
      if (node.nodeType === 1) html += node.outerHTML;
      else if (node.nodeType === 8) html += '<!--' + node.nodeValue + '-->';
      else if (node.nodeType === 10) {
        html += '<!DOCTYPE ' + node.name + (node.publicId ? ' PUBLIC "' + node.publicId + '"' + (node.systemId ? ' "' + node.systemId + '"' : '') : node.systemId ? ' SYSTEM "' + node.systemId + '"' : '') + '>\n';
      }
    }
    if (!html || bytes(html) > limit) throw problem('SOURCE_SIZE', '修改后的原稿超过 128 KiB，尚未写入文件。');
    return html;
  }
  function restoreDraft() {
    let raw;
    try { raw = storage?.getItem(storageKey); } catch { emit({ error: '浏览器草稿不可读取，请保持预览打开后再保存修改。' }); return; }
    if (!raw) return;
    try {
      if (typeof raw !== 'string' || bytes(raw) > limit) throw new Error('draft size');
      const draft = JSON.parse(raw), paths = new Set();
      if (draft?.version !== 1 || draft.revision !== source.revision || !Array.isArray(draft.edits) || draft.edits.length > 1000) throw new Error('draft revision');
      const pending = draft.edits.map(item => {
        if (!item || !Array.isArray(item.textPath) || !item.textPath.length || item.textPath.length > 128 || !item.textPath.every(index => Number.isSafeInteger(index) && index >= 0 && index <= 100000) || typeof item.before !== 'string' || typeof item.value !== 'string') throw new Error('draft shape');
        const key = keyFor(item.textPath);
        if (paths.has(key) || !corresponds(sourceDocument, item.textPath, item.before, item.before)) throw new Error('draft target');
        const node = nodeAt(doc.body, item.textPath);
        if (!allowed(node)) throw new Error('draft element');
        paths.add(key); return copyEdit(item);
      });
      for (const item of pending) {
        const node = nodeAt(doc.body, item.textPath); node.nodeValue = item.value;
        const key = keyFor(item.textPath); touched.set(key, item);
        if (item.value !== item.before) edits.set(key, item);
      }
      emit({ saved: false, error: null });
    } catch {
      blockedDraft = true;
      emit({ saved: false, error: '原稿版本、文字或结构已变化，草稿未自动套用；原草稿已保留，请先核对。' });
    }
  }
  function save() {
    if (disposed) return Promise.reject(problem('EDITOR_DISPOSED', '此预览已关闭，文字尚未写入文件。'));
    if (savingPromise) return savingPromise;
    savingPromise = (async () => {
      await initialized;
      if (disposed) throw problem('EDITOR_DISPOSED', '此预览已关闭，文字尚未写入文件。');
      if (composing) throw problem('EDITOR_COMPOSING', '请先完成中文输入，再保存修改；当前文字仍保留。');
      commitActive();
      if (!source || blockedDraft) throw problem('DRAFT_CONFLICT', state.error || '原稿或草稿存在冲突，修改仍保留。');
      if (!edits.size) return null;
      const snapshot = [...edits.values()].map(copyEdit), revision = source.revision;
      emit({ saving: true, saved: false, error: null });
      const latest = checkedSource(await readSource());
      if (disposed) throw problem('EDITOR_DISPOSED', '此预览已关闭，未发起文件写入；草稿仍保留。');
      if (latest.revision !== revision) throw problem('SOURCE_CONFLICT', '原稿版本已变化。');
      const parsed = parse(latest.content);
      for (const item of snapshot) {
        const target = nodeAt(parsed.body, item.textPath), current = touched.get(keyFor(item.textPath));
        if (valueOf(target) !== item.before || !corresponds(parsed, item.textPath, item.before, current?.value ?? item.value)) throw problem('SOURCE_TARGET_CHANGED', '原稿或预览文字已变化，未覆盖文件；修改仍保留在草稿中。');
      }
      for (const item of snapshot) nodeAt(parsed.body, item.textPath).nodeValue = item.value;
      const content = serialize(parsed);
      const result = await writeSource({ content, revision });
      if (!result || typeof result.revision !== 'string' || !result.revision || result.error) throw problem(result?.error?.code || 'SOURCE_SAVE_FAILED', result?.error?.message || '保存接口没有确认新版本，草稿仍保留。');
      const savedDocument = parse(content), savedItems = new Map(snapshot.map(item => [keyFor(item.textPath), item]));
      const pending = [], emptyNodes = [];
      for (const [key, item] of touched) {
        const node = nodeAt(doc.body, item.textPath);
        if (savedItems.get(key)?.value === item.value) {
          // Empty text is absent after HTML serialization. Remove the matching
          // invisible live node too, so later body paths stay aligned.
          if (item.value === '' && node?.nodeType === 3 && valueOf(node) === '') emptyNodes.push(node);
        } else pending.push({ item, node });
      }
      for (const node of emptyNodes) node.parentNode?.removeChild(node);
      const nextEdits = new Map();
      for (const { item, node } of pending) {
        const path = node && pathOf(node), before = path && valueOf(nodeAt(savedDocument.body, path));
        if (!path || before === null) throw problem('SOURCE_TARGET_CHANGED', '本次原稿已保存，但后续输入无法重新定位；草稿仍保留，请保持预览打开。');
        const rebased = { textPath: path, before, value: item.value };
        if (item.value !== before) nextEdits.set(keyFor(path), rebased);
      }
      source = { content, revision: result.revision }; sourceDocument = savedDocument;
      edits.clear(); touched.clear();
      for (const [key, item] of nextEdits) { edits.set(key, item); touched.set(key, item); }
      if (active) {
        active.path = pathOf(active.wrapper) || active.path;
        active.before = valueOf(nodeAt(savedDocument.body, active.path));
      }
      const storageError = persist();
      emit({ saved: edits.size === 0, error: storageError });
      return result;
    })().catch(error => { emit({ saved: false, error: errorMessage(error) }); throw error; })
      .finally(() => { savingPromise = null; emit({ saving: false }); });
    return savingPromise;
  }
  function dispose() {
    if (disposed) return;
    if (source && active) commitActive();
    disposed = true;
    doc.removeEventListener('dblclick', begin, true);
    doc.removeEventListener('input', input, true);
    doc.removeEventListener('paste', paste, true);
    doc.removeEventListener('compositionstart', compositionStart, true);
    doc.removeEventListener('compositionend', compositionEnd, true);
    win.removeEventListener('click', click, true);
    win.removeEventListener('keydown', keydown, true);
  }
  emit();
  const initialized = Promise.resolve().then(() => readSource()).then(result => {
    if (disposed) return;
    const checked = checkedSource(result), parsed = parse(checked.content);
    source = checked; sourceDocument = parsed; restoreDraft();
  }).catch(error => { emit({ error: errorMessage(error) }); });
  // Capture prevents the first click on editable links/buttons from navigating
  // or running page actions before a double click can reach the text editor.
  doc.addEventListener('dblclick', begin, true);
  doc.addEventListener('input', input, true);
  doc.addEventListener('paste', paste, true);
  doc.addEventListener('compositionstart', compositionStart, true);
  doc.addEventListener('compositionend', compositionEnd, true);
  win.addEventListener('click', click, true);
  win.addEventListener('keydown', keydown, true);
  return { save, dispose, isDirty: () => edits.size > 0 || blockedDraft };
}
