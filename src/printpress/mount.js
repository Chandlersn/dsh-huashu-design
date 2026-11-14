import { createApp, h, reactive } from 'vue';
export { requestPrintpressEdit } from './handoff.js';
import Workbench from './Workbench.vue';
import { createBridge } from './bridge.js';
import { createScope } from './scope.js';
import { photoProcessingChanged } from '@printpress/lib/photo-processing.js';
import './theme.css';

export async function mountPrintpress(element, { locale = 'zh', signal, onEvent } = {}) {
  const bridge = createBridge({ onEvent(message) {
    if (message.event === 'host:capabilities' || message.event === 'photo:processingProgress' && message.payload?.automatic && message.payload.phase === 'completed') photoProcessingChanged();
    onEvent?.(message);
  } });
  const state = reactive({ locale });
  let app, disposeScope, disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; app?.unmount(); disposeScope?.(); bridge.dispose(); element.replaceChildren(); };
  dispose.setLocale = value => { state.locale = value; };
  try {
    const info = await bridge.connect();
    if (signal?.aborted) { dispose(); return () => {}; }
    element.classList.add('hs-printpress');
    disposeScope = createScope(element, bridge.api);
    app = createApp({ render: () => h(Workbench, { info, api: bridge.api, locale: state.locale, onEvent }) });
    app.config.errorHandler = error => {
      onEvent?.({ event: 'bridge:error', payload: { message: error.message } });
      console.error('[PrintPress]', error);
    };
    app.mount(element);
    return dispose;
  } catch (error) { dispose(); throw error; }
}
