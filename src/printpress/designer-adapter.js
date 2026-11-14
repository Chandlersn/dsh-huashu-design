function replaceOnce(source, previous, next, label) {
  if (!source.includes(previous) || source.indexOf(previous) !== source.lastIndexOf(previous)) {
    throw new Error(`PrintPress ${label} changed; recheck the Huashu editor adapter.`);
  }
  return source.replace(previous, () => next);
}

// Applied only to the bundled copy; the original checkout remains untouched.
export function adaptDesignerView(source) {
  if (!source.includes("openImageEdit('crop')") || /defineExpose\s*\(/.test(source)) {
    throw new Error('PrintPress image edit mode or exposed API changed; recheck the Huashu editor adapter.');
  }
  const start = source.indexOf('async function consumeRequest(request) {');
  const end = source.indexOf('watch(() => designerNav.request', start);
  if (start < 0 || end < 0) throw new Error('PrintPress request consumer changed; recheck the Huashu editor adapter.');
  let consumer = source.slice(start, end);
  consumer = replaceOnce(consumer, 'if (!request || busy.value) return', "if (!request || busy.value || (request.origin === 'huashu' && modalOpen.value)) return", 'request guard');
  consumer = replaceOnce(consumer, '  designerNav.request = null', "  designerNav.request = null\n  if (request.origin === 'huashu') finishTextEdit()", 'request draft protection');
  consumer = replaceOnce(consumer,
    '      if (request.designRef) value = await window.printpress.getDesign(request.designRef.id, request.designRef.revision)',
    `      if (request.designRef) {
        try { value = await window.printpress.getDesign(request.designRef.id, request.designRef.revision) }
        catch (err) {
          if (request.origin !== 'huashu') throw err
          // A re-import, a changed data directory, or a deferred handoff can leave
          // a pinned revision that no longer exists ("底图版本不存在或尚未提交").
          // Huashu always wants the latest saved version, not a stale snapshot.
          value = await window.printpress.getDesign(request.designRef.id)
        }
      }`,
    'stale revision fallback');
  consumer = replaceOnce(consumer, '    busy.value = true\n    try {', '    busy.value = true\n    let huashuFailure = null\n    try {', 'request load');
  consumer = replaceOnce(consumer, 'replaceDesign(value, clone(request),', "replaceDesign(value, request.origin === 'huashu' ? null : clone(request),", 'request context');
  consumer = replaceOnce(consumer, '    } catch (err) { fail(err) }\n    finally { busy.value = false }', `    } catch (err) { fail(err); huashuFailure = err }
    finally { busy.value = false }
    if (request.origin === 'huashu') {
      if (!huashuFailure && request.openImageEditor) {
        try {
          const layer = design.value.layers.find(item => item.type === 'image')
          if (!layer) throw new Error('该工程没有可编辑的图片图层。')
          selectedIds.value = [layer.id]
          await nextTick()
          await openImageEdit('crop')
          if (!imageEdit.value) throw new Error('图片编辑未打开，请检查图片图层是否锁定。')
        } catch (err) { fail(err); huashuFailure = err }
      }
      request.onHuashuResult?.(huashuFailure
        ? { status: 'failed', message: error.value }
        : { status: 'opened', designRef: { id: design.value.id, revision: design.value.revision } })
    }`, 'request result');
  consumer = replaceOnce(consumer, '  }, () => returnToTemplate(request))', "  }, () => request.origin === 'huashu' ? request.onHuashuResult?.({ status: 'canceled' }) : returnToTemplate(request))", 'request cancellation');
  const exposed = `
// Huashu saves share the component's text, gesture, revision and dirty lifecycle.
// Only replay a handoff that ARRIVED WHILE a modal was open. A stale request
// that already existed when an unrelated dialog (notably the package/PSD import
// check) opened must never be re-consumed: the standalone desktop app has no
// such watch, and re-reading an old pinned revision reports
// "底图版本不存在或尚未提交" there would never occur.
let deferredHuashuRequest = null
watch(modalOpen, value => {
  if (!value) {
    const pending = deferredHuashuRequest
    deferredHuashuRequest = null
    if (pending && initialized && designerNav.request === pending) consumeRequest(pending)
  }
})
watch(() => designerNav.request, request => {
  if (modalOpen.value && request?.origin === 'huashu') deferredHuashuRequest = request
})
defineExpose({
  getCurrentId: () => design.value.id || null,
  async saveForHuashu() {
    if (busy.value) throw new Error('编辑器正在处理，请稍后再保存。')
    if (imageEdit.value) throw new Error('请先应用或取消图片编辑弹窗中的修改，再保存回作品库。')
    if (modalOpen.value) throw new Error('请先完成或关闭当前弹窗，再保存回作品库。')
    finishTextEdit()
    await save()
    if (error.value) throw new Error(error.value)
    if (dirty.value) throw new Error('保存期间又产生了修改，请再次保存后再发布。')
    if (!design.value.id || !Number.isInteger(design.value.revision) || design.value.revision < 1) throw new Error('工程尚未保存，请重试。')
    return { id: design.value.id, revision: design.value.revision }
  }
})
`;
  return replaceOnce(source.slice(0, start) + consumer + source.slice(end), '</script>', exposed + '</script>', 'script boundary');
}
