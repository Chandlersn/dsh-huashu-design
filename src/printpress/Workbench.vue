<script setup>
import { ref, shallowRef, computed, watch, KeepAlive, onMounted, onBeforeUnmount } from 'vue';
import DatasetView from '@printpress/views/DatasetView.vue';
import PhotoLibraryView from '@printpress/views/PhotoLibraryView.vue';
import TemplateView from '@printpress/views/TemplateView.vue';
import BackgroundDesignerView from '@printpress/views/BackgroundDesignerView.vue';
import PrintCenterView from '@printpress/views/PrintCenterView.vue';
import AppIcon from '@printpress/components/AppIcon.vue';
import { cellNav } from '@printpress/lib/cell-nav.js';
import { designerNav, openDesigner } from '@printpress/lib/designer-nav.js';
import { photoNav } from '@printpress/lib/photo-nav.js';
import { handoffQueue, publishLinkedWork } from './handoff.js';
import PrintpressLogo from './PrintpressLogo.vue';

const props = defineProps({ info: Object, api: Object, locale: String, onEvent: Function });
const english = computed(() => props.locale?.startsWith('en'));
const messages = {
  zh: {
    linkedWork: '当前关联作品', imageEditing: '图片编辑', layersEditing: '图层编辑',
    opening: '正在打开作品；如有草稿或弹窗，请先完成原编辑器的确认。',
    saveToLibrary: '保存回作品库', saving: '正在保存并发布…', returnToLibrary: '返回作品库',
    savedToLibrary: '当前版本已保存回作品库，可继续编辑或返回查看。',
    canceled: '已取消切换，原工程和草稿保持在编辑器中。',
    projectChanged: '当前工程已切换。请从作品库重新打开该作品，再保存回作品库。',
    editorNotReady: '编辑器尚未就绪，请等待作品加载完成。',
    returnHint: '返回作品库会保留编辑内容；稍后可从“批印坊”标签继续。'
  },
  en: {
    linkedWork: 'Linked work', imageEditing: 'Image editing', layersEditing: 'Layer editing',
    opening: 'Opening this work. Complete any draft confirmation or dialog in the editor.',
    saveToLibrary: 'Save to work library', saving: 'Saving and publishing…', returnToLibrary: 'Back to work library',
    savedToLibrary: 'This version is saved to your library. Keep editing or return to view it.',
    canceled: 'Switch canceled. The previous project and draft remain in the editor.',
    projectChanged: 'The current project has changed. Reopen this work from the library before saving it back.',
    editorNotReady: 'Wait for the work to finish loading in the editor.',
    returnHint: 'Returning keeps your edits. Open the PrintPress tab to continue.'
  }
};
const text = key => messages[english.value ? 'en' : 'zh'][key];
const tabs = [
  { id: 'dataset', name: '名单数据', en: 'Data', icon: 'table' },
  { id: 'photos', name: '变量照片', en: 'Photos', icon: 'portrait' },
  { id: 'designer', name: '底图制作', en: 'Designer', icon: 'brush' },
  { id: 'template', name: '模板排版', en: 'Templates', icon: 'layout' },
  { id: 'print', name: '打印中心', en: 'Output', icon: 'print' }
];
const tab = ref('dataset');
// The adapted DatasetView exposes startImport/importing/errorMsg; the template
// reads them through the component instance, so import errors stay visible even
// though the page's own header row is gone.
const dataset = ref(null);
const template = ref(null);
const error = ref('');
const designer = ref(null);
const binding = shallowRef(null);
const opening = shallowRef(null);
const publishing = ref(false);
const notice = ref('');
const projectMatches = computed(() => !!binding.value && designer.value?.getCurrentId() === binding.value.designRef.id);
let alive = false, unsubscribe;
watch(() => designerNav.request, value => { if (value) tab.value = 'designer'; });
watch(() => designerNav.result, value => { if (value && value.origin !== 'huashu') tab.value = value.origin === 'print' ? 'print' : 'template'; });
watch(() => photoNav.request, value => { if (value) tab.value = 'photos'; });
watch(() => photoNav.result, value => { if (value?.origin === 'print') tab.value = 'print'; });
watch(cellNav, value => { if (value?.req) tab.value = 'dataset'; });

function receiveExternalRequest() {
  if (!alive || opening.value || publishing.value) return;
  const request = handoffQueue.peek();
  if (!request) return;
  opening.value = request;
  error.value = ''; notice.value = '';
  tab.value = 'designer';
  openDesigner({
    origin: 'huashu', designRef: request.designRef, artboard: request.artboard, openImageEditor: request.openImageEditor,
    onHuashuResult(result) {
      if (!alive || opening.value?.token !== request.token) return;
      if (result.status === 'opened' && result.designRef?.id === request.designRef.id) {
        // Binding changes only after protectDraft accepted and the load succeeded.
        binding.value = { ...request, designRef: result.designRef };
      } else if (result.status === 'canceled') notice.value = 'canceled';
      else error.value = result.message || text('editorNotReady');
      opening.value = null;
      handoffQueue.acknowledge(request.token);
    }
  });
}
onMounted(() => { alive = true; unsubscribe = handoffQueue.subscribe(receiveExternalRequest); });
onBeforeUnmount(() => { alive = false; unsubscribe?.(); });

async function saveToLibrary() {
  if (publishing.value || opening.value) return;
  publishing.value = true; error.value = ''; notice.value = '';
  const linked = binding.value;
  try {
    const data = await publishLinkedWork(linked, designer.value);
    if (!alive) return;
    if (binding.value === linked) binding.value = { ...linked, item: data.item, designRef: data.designRef };
    notice.value = 'savedToLibrary';
    props.onEvent?.({ event: 'workbench:published', payload: data });
  } catch (value) {
    if (alive) error.value = value.code === 'HUASHU_PROJECT_CHANGED' ? text('projectChanged') : value.code === 'HUASHU_EDITOR_NOT_READY' ? text('editorNotReady') : value.message;
  } finally {
    publishing.value = false;
    receiveExternalRequest();
  }
}
function returnToLibrary() { props.onEvent?.({ event: 'workbench:return', payload: { workId: binding.value?.item.id } }); }
async function openData() { try { await props.api.openDataDir(); } catch (value) { error.value = value.message; } }
function navKeys(event, index) {
  if (opening.value || publishing.value) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tab.value = tabs[next].id;
  event.currentTarget.parentElement.children[next]?.focus();
}
</script>
<template>
  <header class="pp-heading">
    <h2><PrintpressLogo class="pp-brand-logo" />{{ english ? 'PrintPress' : '批印坊' }} <span class="pp-version">v{{ info.version }}</span></h2>
    <div class="pp-heading-actions">
      <button v-if="tab === 'dataset'" class="btn-primary" :disabled="!!dataset?.importing || !!opening || publishing" data-testid="pp-import-table" @click="dataset?.startImport()"><AppIcon name="upload" />{{ dataset?.importing ? (english ? 'Importing…' : '导入中…') : (english ? 'Import sheet' : '导入表格') }}</button>
      <button v-if="tab === 'template'" class="btn-primary" :disabled="!!opening || publishing" data-testid="pp-new-template" @click="template?.newTemplate()"><AppIcon name="add" />{{ english ? 'New template' : '新建模板' }}</button>
      <span v-if="tab === 'dataset' && dataset?.errorMsg" class="pp-import-error" role="alert">{{ dataset.errorMsg }}</span>
      <button class="pp-data-directory" :title="info.dataDir" @click="openData"><AppIcon name="folder" />{{ english ? 'Data folder' : '打开数据目录' }}</button>
    </div>
  </header>
  <section v-if="binding || opening" class="pp-linked-work" :aria-label="text('linkedWork')">
    <div class="pp-linked-copy">
      <span class="pp-linked-label">{{ text('linkedWork') }} · {{ (opening || binding).mode === 'layers' && !(opening || binding).item.imageOnly ? text('layersEditing') : text('imageEditing') }}</span>
      <strong>{{ (opening || binding).item.title }}</strong>
      <p v-if="opening" role="status">{{ text('opening') }}</p>
      <p v-else-if="tab === 'designer' && !projectMatches" class="pp-linked-warning">{{ text('projectChanged') }}</p>
      <p v-else>{{ text('returnHint') }}</p>
    </div>
    <div class="pp-linked-actions">
      <button class="btn-primary" :disabled="publishing || !!opening || tab !== 'designer' || !projectMatches" @click="saveToLibrary">{{ text(publishing ? 'saving' : 'saveToLibrary') }}</button>
      <button :disabled="publishing || !!opening" @click="returnToLibrary">{{ text('returnToLibrary') }}</button>
    </div>
  </section>
  <p v-if="notice" class="pp-status" role="status">{{ text(notice) }}</p>
  <p v-if="error" class="pp-error" role="alert">{{ error }}</p>
  <nav class="pp-nav" role="tablist" :aria-label="english ? 'PrintPress tools' : '批印坊功能'">
    <button v-for="(item, index) in tabs" :key="item.id" :id="'pp-tab-' + item.id" type="button" role="tab" :disabled="!!opening || publishing" :aria-selected="tab === item.id" :tabindex="tab === item.id ? 0 : -1" aria-controls="pp-view" @click="tab = item.id" @keydown="navKeys($event, index)"><AppIcon :name="item.icon" :size="17" />{{ english ? item.en : item.name }}</button>
    <span class="pp-local-note">{{ english ? 'Local files · Local processing' : '本机数据 · 本地处理' }}</span>
  </nav>
  <main id="pp-view" class="pp-view" role="tabpanel" :aria-labelledby="'pp-tab-' + tab">
    <KeepAlive include="TemplateView,BackgroundDesignerView,PrintCenterView">
      <DatasetView v-if="tab === 'dataset'" ref="dataset" />
      <PhotoLibraryView v-else-if="tab === 'photos'" @navigate="tab = $event" />
      <BackgroundDesignerView v-else-if="tab === 'designer'" ref="designer" />
      <TemplateView v-else-if="tab === 'template'" ref="template" />
      <PrintCenterView v-else />
    </KeepAlive>
  </main>
  <div class="pp-portal" id="hs-printpress-portal"></div>
</template>
<style scoped>
.pp-heading-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.pp-import-error {
  font-size: 12px;
  color: var(--dsw-alias-state-error-primary);
  max-width: 320px;
  overflow-wrap: anywhere;
}
.pp-brand-logo {
  display: block;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
}
</style>
