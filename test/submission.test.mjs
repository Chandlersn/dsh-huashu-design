import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Execute only the real transport orchestrator; no React or DOM is emulated.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8');
const start = source.indexOf('async function submitWorkspacePrompt(');
const end = source.indexOf('// End pure submission orchestration.', start);
assert.ok(start >= 0 && end > start);
const submit = new Function(source.slice(start, end) + ';return submitWorkspacePrompt;')();
const pathStart = source.indexOf('function projectInWorkspace(');
const pathEnd = source.indexOf('// End pure path matching.', pathStart);
const contains = new Function(source.slice(pathStart, pathEnd) + ';return projectInWorkspace;')();
const stateStart = source.indexOf('function createViewStore(');
const stateEnd = source.indexOf('// End pure view store.', stateStart);
const createStore = new Function(source.slice(stateStart, stateEnd) + ';return createViewStore;')();

function fixture({ result = { ok:true,value:{accepted:true} }, promptError, readyError } = {}) {
  const calls = [];
  let retained = false;
  const services = {
    uiWorkspace: { async connectWorkspace(id) { calls.push(['connect', id]);return 'session-in-chosen-workspace'; } },
    sessions: { async using(id, options, operation) {
      retained = true;calls.push(['retain', id, options.source]);
      try {
        const session = {
          beginSubmission(input) { assert.ok(retained);calls.push(['echo',input]);return { requestId:'request-1',abandon(){calls.push(['abandon']);} }; },
          async prompt(parts, mode, signal, requestId) { assert.ok(retained);calls.push(['prompt',parts,mode,signal,requestId]);if(promptError)throw promptError;return result; }
        };
        return await operation({ready:readyError?Promise.reject(readyError):Promise.resolve({session})});
      } finally {retained = false;calls.push(['release']);}
    } }
  };
  return { services, calls };
}

test('direct send targets the chosen workspace, registers an echo and passes its request identity to native prompt', async () => {
  const {services,calls} = fixture();
  const text = '  Make an editable HTML deck.\nKeep the source.  ';
  assert.equal(await submit(services, 'workspace-B', text), 'session-in-chosen-workspace');
  assert.deepEqual(calls, [
    ['connect','workspace-B'],
    ['retain','session-in-chosen-workspace','controllerOperation'],
    ['echo',{mode:'queue',text,attachments:[]}],
    ['prompt',[{type:'text',text}],'queue',undefined,'request-1'],
    ['release']
  ]);
});

test('blank workspace or blank message cannot create a Session', async () => {
  const {services,calls} = fixture();
  await assert.rejects(submit(services, '', 'hello'));
  await assert.rejects(submit(services, 'workspace-B', ' \n '));
  assert.deepEqual(calls, []);
});

test('Host refusal retains the Session address, retires its echo and does not retry', async () => {
  const {services,calls} = fixture({result:{ok:false,error:{code:'permission/denied',message:'Cannot send here'}}});
  await assert.rejects(submit(services, 'workspace-B', 'hello'), error => error.message === 'Cannot send here' && error.sessionId === 'session-in-chosen-workspace');
  assert.equal(calls.filter(x=>x[0]==='prompt').length, 1);
  assert.deepEqual(calls.slice(-2), [['abandon'],['release']]);
});

test('failed Session opening sends nothing and releases its reference', async () => {
  const {services,calls} = fixture({readyError:new Error('Session opening failed')});
  await assert.rejects(submit(services, 'workspace-B', 'hello'), /Session opening failed/);
  assert.ok(!calls.some(x=>x[0]==='echo'||x[0]==='prompt'));
  assert.equal(calls.at(-1)[0], 'release');
});

test('transport failure preserves the Session address for checking acceptance before retry', async () => {
  const {services,calls} = fixture({promptError:new Error('Connection lost')});
  await assert.rejects(submit(services, 'workspace-B', 'hello'), error=>error.message==='Connection lost'&&error.sessionId==='session-in-chosen-workspace');
  assert.deepEqual(calls.slice(-2), [['abandon'],['release']]);
});

test('workspace and unsent composer values survive view subscription removal and re-entry', () => {
  const store = createStore({workspaceId:'workspace-B',brief:'Keep this unsent request',draft:'Editable full instructions',editingWork:{id:'work-1'}});
  const before = store.getSnapshot();
  const stop = store.subscribe(()=>{});
  stop();
  assert.equal(store.getSnapshot(), before);
  assert.equal(store.getSnapshot().brief, 'Keep this unsent request');
  let observed;
  const stopAgain = store.subscribe(()=>{observed=store.getSnapshot();});
  store.set('draft', current=>current+' updated');
  assert.equal(observed.draft, 'Editable full instructions updated');
  assert.equal(observed.workspaceId, 'workspace-B');
  stopAgain();
});

test('a source save completing after the view leaves updates the restored revision and clears pending state', async () => {
  const store = createStore({editor:{revision:'old',content:'old'},sourceText:'new',sourceBusy:true});
  const stop = store.subscribe(()=>{});
  let settle;
  const saved = new Promise(resolve=>{settle=resolve;});
  const completion = saved.then(result=>{store.set('editor', result);store.set('sourceBusy',false);});
  stop();
  settle({revision:'new-revision',content:'new'});
  await completion;
  assert.equal(store.getSnapshot().editor.revision, 'new-revision');
  assert.equal(store.getSnapshot().editor.content, store.getSnapshot().sourceText);
  assert.equal(store.getSnapshot().sourceBusy, false);
});

test('revision workspace containment handles Windows and POSIX boundaries without accepting a sibling prefix', () => {
  assert.ok(contains('D:\\Projects\\Deck\\source', 'd:\\projects\\deck\\'));
  assert.ok(contains('\\\\Server\\Share\\Deck', '\\\\server\\share'));
  assert.ok(!contains('D:\\Projects\\Deck-other', 'D:\\Projects\\Deck'));
  assert.ok(contains('/work/deck', '/work'));
  assert.ok(contains('/work/deck', '/'));
  assert.ok(!contains('/Work/deck', '/work'));
  assert.ok(!contains('/work/deck', ''));
});
