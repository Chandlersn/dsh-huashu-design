function replaceRequired(source, previous, next, label) {
  if (!source.includes(previous)) throw new Error(`PrintPress ${label} changed; recheck the embedded UI adapter.`);
  return source.replace(previous, () => next);
}

export function adaptPrintpressUI(source, filename) {
  let code = source.replaceAll('模板工坊', '模板排版');
  if (filename.endsWith('/components/PageHeader.vue')) {
    const text = /\s*<div class="page-header__text">[\s\S]*?<\/div>/;
    if (!text.test(code)) throw new Error('PrintPress PageHeader changed; recheck the embedded UI adapter.');
    code = code.replace(text, '');
    code = replaceRequired(code, '<header class="page-header">', '<header v-if="$slots.actions" class="page-header">', 'PageHeader actions');
    code = code.replace('justify-content: space-between;', 'justify-content: flex-end;');
  }
  if (filename.endsWith('/views/PrintCenterView.vue')) {
    // This is the editor's resize handle, not exported page content.
    code = code.replaceAll('background:#fff;border:2px solid #d34f32;', 'background:var(--dsw-alias-bg-base);border:2px solid var(--dsw-alias-brand-primary);');
  }
  if (filename.endsWith('/views/DatasetView.vue')) {
    // The workbench header carries the import action next to 打开数据目录, so this
    // page's own one-line header row is pure vertical waste above the table.
    const importHeader = /\s*<PageHeader title="数据">[\s\S]*?<\/template>\s*<\/PageHeader>/;
    if (!importHeader.test(code)) throw new Error('PrintPress dataset header changed; recheck the embedded UI adapter.');
    code = code.replace(importHeader, '');
    code = replaceRequired(code, '</script>', '\n// The workbench header owns the import button; expose the action and its live state.\ndefineExpose({ startImport, importing, errorMsg })\n</script>', 'dataset import expose');
  }
  if (filename.endsWith('/views/TemplateView.vue')) {
    // 模板排版: the header's only action is 新建模板. Move that single button into the
    // workbench header next to 打开数据目录 and drop the now-empty row, so the
    // template list and toolbar start at the top instead of behind a blank band.
    const header = /<PageHeader title="模板排版">\s*<template #actions>\s*<button class="btn-primary" @click="newTemplate"><AppIcon name="add" \/> 新建模板<\/button>\s*<\/template>\s*<\/PageHeader>\s*/;
    if (!header.test(code)) throw new Error('PrintPress template header changed; recheck the embedded UI adapter.');
    code = code.replace(header, '');
    code = replaceRequired(code, '</script>', '\n// The workbench header owns the create-template action so page content starts at the top.\ndefineExpose({ newTemplate })\n</script>', 'template new expose');
  }
  if (filename.endsWith('/views/PhotoLibraryView.vue')) {
    // The header held a single "前往底图制作 → 添加变量图" shortcut that the tab bar
    // already covers. Removing the whole row (not just the button) also frees the
    // vertical band above the photo panels.
    const header = /\s*<PageHeader title="变量照片库"[\s\S]*?<\/template>\s*<\/PageHeader>/;
    if (!header.test(code)) throw new Error('PrintPress photo library header changed; recheck the embedded UI adapter.');
    code = code.replace(header, '');
  }
  return code;
}

export function adaptPhotoProcessingPanel(source) {
  let code = replaceRequired(source, 'photoProcessingChanged, photoProcessingDrafts, photoProcessingSample', 'photoProcessingChanged, photoProcessingDrafts, photoProcessingSample, photoProcessingRevision', 'photo capability refresh import');
  code = replaceRequired(code, 'props.datasetId, props.rowId, props.refreshKey], refresh', 'props.datasetId, props.rowId, props.refreshKey, photoProcessingRevision.value], refresh', 'photo capability refresh watch');
  code = replaceRequired(code, "const previewModel = ref('quality'), batchModel = ref('fast')", "const previewModel = ref('fast'), batchModel = ref('fast')\nconst hostModel = ref({ name: 'DSH宿主图像服务', reason: '正在读取宿主图像能力…' })\nconst hostProcessingBlocked = computed(() => (recipe.value.cutout && !modelReady.value && !qualityReady.value) || (recipe.value.faceAlign && !faceReady.value))", 'photo provider state');
  code = replaceRequired(code, '    singleSaved.value = processing.single', "    hostModel.value = { ...processing.model, name: processing.model.name || 'DSH宿主图像服务', reason: processing.model.reason || '' }\n    singleSaved.value = processing.single", 'photo provider status');
  code = replaceRequired(code, '    if (opened.value && selected.value)', "    if (modelReady.value || qualityReady.value) { const mode = modelReady.value ? 'fast' : 'quality'; previewModel.value = mode; batchModel.value = mode }\n    if (opened.value && selected.value)", 'photo provider selection');
  code = replaceRequired(code, "  previewing.value = true; error.value = ''; queued = false", "  if (hostProcessingBlocked.value) { error.value = hostModel.value.reason || '当前设置所需的图像能力不可用，请关闭相应 AI 项目后继续。'; return }\n  previewing.value = true; error.value = ''; queued = false", 'photo preview admission');
  code = replaceRequired(code, '  if (!canEdit.value || previewing.value) return', "  if (!canEdit.value || previewing.value) return\n  if (hostProcessingBlocked.value) { error.value = hostModel.value.reason || '请先关闭不可用的 AI 项目。'; return }", 'photo batch admission');
  code = replaceRequired(code, '  if (!props.rowId || applying.value) return\n  applying.value = true', "  if (!props.rowId || applying.value) return\n  if (!edit && hostProcessingBlocked.value) { error.value = hostModel.value.reason || '请先关闭不可用的 AI 项目。'; return }\n  applying.value = true", 'photo single admission');
  const modelControls = /        <div v-if="recipe.cutout" class="model-options">[\s\S]*?<p v-if="recipe.cutout && previewModel === 'quality' && !qualityReady" class="processing-error">[\s\S]*?<\/p>/;
  if (!modelControls.test(code)) throw new Error('PrintPress photo model controls changed; recheck the host-capability UI adapter.');
  code = code.replace(modelControls, `        <div class="host-image-capability" data-testid="photo-processing-host-capability">
          <strong>{{ hostModel.name }} · {{ hostModel.source === 'local-fast' ? '快速本地模型' : 'DSH宿主' }}</strong>
          <span>{{ modelReady || qualityReady ? '抠图已就绪' : '抠图不可用' }} · {{ faceReady ? '宿主人脸分析已就绪' : '宿主人脸分析不可用' }}</span>
          <p v-if="hostModel.reason">{{ hostModel.reason }}</p>
        </div>`);
  code = replaceRequired(code, '<p v-if="!modelReady && !qualityReady" class="muted">本地抠图组件缺失，请安装完整安装包。</p>', '<p v-if="!modelReady && !qualityReady" class="muted">{{ hostModel.reason || \'当前没有可用的抠图服务。\' }} 普通尺寸、裁剪与手工擦除可继续使用。</p>', 'photo unavailable hint');
  code = code.replaceAll(':disabled="!modelReady && !qualityReady"', ':disabled="!modelReady && !qualityReady && !recipe.cutout"').replaceAll(':disabled="!faceReady"', ':disabled="!faceReady && !recipe.faceAlign"');
  code = code.replaceAll('本地模型不可用', '宿主未提供人脸分析').replaceAll('新版模型抠图', '当前可用的抠图服务');
  code = code.replace('图片编辑 · 抠图边缘修补', '图片编辑 · 裁剪与擦除');
  code = code.replace('选一张照片制作样板，将适配、抠图和柔边规则应用到整份名单。', '选一张照片制作样板，应用尺寸与适配规则；AI 项目按当前图像能力启用。');
  return code;
}

const localTokens = { 'bg-base': 'bg-base', 'bg-layer-1': 'bg-layer-1', 'bg-layer-2': 'bg-layer-2', 'border-l1': 'border-l1', 'border-l2': 'border-l2', 'brand-primary': 'accent-ink' };
const token = name => localTokens[name] ? `var(--hs-${localTokens[name]},var(--dsw-alias-${name}))` : `var(--dsw-alias-${name})`;
function rgba(color) {
  if (color === 'white') return [255, 255, 255, 1];
  if (color === 'black') return [0, 0, 0, 1];
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map(char => char + char).join('');
    if (hex.length === 6) hex += 'ff';
    if (hex.length !== 8) return null;
    return [0, 2, 4].map(start => parseInt(hex.slice(start, start + 2), 16)).concat(parseInt(hex.slice(6), 16) / 255);
  }
  const values = color.match(/[\d.]+/g)?.map(Number);
  return values?.length >= 3 ? [values[0], values[1], values[2], values[3] ?? 1] : null;
}

// UI declarations only. Artwork, field content and color-picker spectra retain
// their literal colors; inline design data and rendering modules are never touched.
export function hostThemeValue(property, value, selector = '') {
  const primary = /\.btn-primary\b|button\.primary\b/.test(selector);
  const disabled = selector.replaceAll(':not(:disabled)', '').includes(':disabled');
  if (primary && !disabled && property === 'opacity') return '1';
  if (primary && !disabled && property === 'filter' && /brightness/.test(value)) return 'none';
  if (!/(?:color|background|border|shadow|outline|fill|stroke)/.test(property)) return value;
  if (/(?:^|[\s,>+~])\.(?:canvas|canvas-cell|design-stage|canvas-navigator|preview-holder|preview-frame|record-field|field-text|design-surface-content|color-square|square-marker|hue)(?=[\s,.#:[>+~]|$)/.test(selector)) return value;
  if (primary && /background/.test(property)) value = value.replace(/var\(--cinnabar(?:,\s*#[\da-f]+)?\s*\)/gi, 'var(--hs-accent,var(--dsw-alias-brand-primary))');
  if (/danger/.test(selector)) value = value.replace(/var\(--cinnabar(?:,\s*#[\da-f]+)?\s*\)/gi, 'var(--dsw-alias-state-error-primary)');
  return value.replace(/url\([^)]*\)|#[\da-f]{3,8}\b|\brgba?\([\d.,\s]+\)|\bwhite\b|\bblack\b/gi, color => {
    if (color.startsWith('url(')) return color;
    const channels = rgba(color.toLowerCase());
    if (!channels) return color;
    const [r, g, b, alpha] = channels;
    if (primary && /background/.test(property)) return 'var(--hs-accent,var(--dsw-alias-brand-primary))';
    if (primary && property === 'color' && r > 245 && g > 245 && b > 245) return 'var(--hs-on-accent,var(--dsw-alias-bg-base))';
    const neutral = Math.max(r, g, b) - Math.min(r, g, b) < 30;
    let mapped;
    if (/mask|backdrop/.test(selector) && /background/.test(property)) return `color-mix(in srgb, ${token('bg-base')} 76%, transparent)`;
    if (/shadow/.test(property)) mapped = token('label-primary');
    else if (/error/.test(selector)) mapped = token('state-error-primary');
    else if (!neutral && g > r && g > b) mapped = token('state-success-primary');
    else if (!neutral && r > 100 && g > 70 && g < r && b < g * .65) mapped = token('state-warn-primary');
    else if (!neutral && (r > 90 && g < r * .85 || b > r * 1.2)) mapped = token('brand-primary');
    else if (/background/.test(property) && /\.bg-tip\b|tooltip/.test(selector)) mapped = token('label-primary');
    else if (/background/.test(property)) mapped = token(r > 240 ? 'bg-layer-1' : 'bg-layer-2');
    else if (/border|outline/.test(property)) mapped = token(r > 210 ? 'border-l1' : 'border-l2');
    else if (/color/.test(property)) mapped = token(r > 245 ? 'bg-base' : r < 60 ? 'label-primary' : 'label-secondary');
    else mapped = token('brand-primary');
    return alpha < 1 ? `color-mix(in srgb, ${mapped} ${Math.round(alpha * 100)}%, transparent)` : mapped;
  });
}
