/* Study app hub: settings, private content, GitHub sync and Claude calls.
   Runs in the top-level page. The Feed and Desk frames reach it through bridge.js.
   Keys and tokens are stored only in this browser's localStorage. */
(() => {
'use strict';

const K = { settings: 'study-settings-v1', content: 'study-content-v1', docs: 'study-docs-v1', pending: 'study-pending-v1', log: 'study-synclog-v1' };
const DEFAULTS = {
  ghToken: '', ghRepo: 'karolszostekclaw/karol-learning', ghBranch: 'main',
  apiKey: '', modelFast: 'claude-sonnet-5-5', modelComplex: 'claude-opus-5-5', thinking: true
};
const CONTENT_FILES = { deck: 'app-data/content/lemma-deck.txt', desk: 'app-data/content/desk-mfml.json' };
// profile.json holds how prompts describe you; it stays in the private repo so this public code says nothing about you.
const OPTIONAL_FILES = { papers: 'app-data/content/papers.json', schedule: 'app-data/content/schedule.json', profile: 'app-data/content/profile.json' };
const FLUSH_DELAY = 20000;

const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('storage full?', e); } };

let settings = Object.assign({}, DEFAULTS, load(K.settings, {}));
const listeners = new Set();
let status = { state: 'idle', text: '' };
function setStatus(state, text) { status = { state, text, at: Date.now() }; listeners.forEach(fn => { try { fn(status); } catch (e) {} }); }

/* ---------------- GitHub ---------------- */
class GhError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
async function gh(path, opts = {}) {
  if (!settings.ghToken) throw new GhError('No GitHub token', 0);
  const res = await fetch(`https://api.github.com/repos/${settings.ghRepo}/${path}`, {
    method: opts.method || 'GET',
    headers: Object.assign({
      Authorization: 'Bearer ' + settings.ghToken,
      Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }, opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store'
  });
  if (res.status === 404 && opts.allow404) return null;
  if (!res.ok) {
    let m = ''; try { m = (await res.json()).message || ''; } catch (e) {}
    throw new GhError(`GitHub ${res.status}${m ? ': ' + m : ''}`, res.status);
  }
  return opts.raw ? res.text() : res.json();
}
const enc = p => p.split('/').map(encodeURIComponent).join('/');
const getFile = p => gh(`contents/${enc(p)}?ref=${encodeURIComponent(settings.ghBranch)}`, { raw: true, allow404: true });
async function listDir(p) {
  const r = await gh(`contents/${enc(p)}?ref=${encodeURIComponent(settings.ghBranch)}`, { allow404: true });
  return Array.isArray(r) ? r : [];
}
/* One commit for many files, straight onto the branch (no PRs). */
async function commitFiles(files, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh(`git/ref/heads/${enc(settings.ghBranch)}`);
    const parent = ref.object.sha;
    const base = await gh(`git/commits/${parent}`);
    const tree = await gh('git/trees', { method: 'POST', body: {
      base_tree: base.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content }))
    } });
    const commit = await gh('git/commits', { method: 'POST', body: { message, tree: tree.sha, parents: [parent] } });
    try {
      await gh(`git/refs/heads/${enc(settings.ghBranch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
      return commit.sha;
    } catch (e) {
      if (e.status !== 422 || attempt === 2) throw e;   // someone pushed in between: rebuild on the new head
    }
  }
}

/* ---------------- private content (cards, problems) ---------------- */
let content = load(K.content, null);
async function fetchContent() {
  const [deck, desk] = await Promise.all([getFile(CONTENT_FILES.deck), getFile(CONTENT_FILES.desk)]);
  if (deck == null || desk == null) throw new GhError('Content files missing in the repo (app-data/content/)', 404);
  const [papers, schedule, profile] = await Promise.all([getFile(OPTIONAL_FILES.papers).catch(() => null), getFile(OPTIONAL_FILES.schedule).catch(() => null), getFile(OPTIONAL_FILES.profile).catch(() => null)]);
  let prof = null; try { prof = profile ? JSON.parse(profile) : null; } catch (e) { prof = null; }
  let sched = null; try { sched = schedule ? JSON.parse(schedule) : null; } catch (e) { sched = null; }
  content = { deck, desk: JSON.parse(desk), papers: papers ? JSON.parse(papers).papers : [], schedule: sched, profile: prof, fetchedAt: Date.now() };
  store(K.content, content);
  return content;
}
async function getContent({ refresh = false } = {}) {
  // Copies saved before the Plan tab existed have no schedule: fetch once to pick it up.
  if (content && !refresh && (content.schedule === undefined || content.profile === undefined) && settings.ghToken && navigator.onLine) return fetchContent().catch(() => content);
  if (content && !refresh) {
    if (settings.ghToken && Date.now() - (content.fetchedAt || 0) > 6 * 3600e3) fetchContent().catch(() => {});
    return content;
  }
  return fetchContent();
}

/* ---------------- docs: a tiny document store backed by JSON files ---------------- */
// doc path -> repo file. Lemma's 'data/users/<id>/progress' becomes app-data/lemma-progress.json.
function fileFor(docPath) {
  if (/^data\/users\/[^/]+\/progress$/.test(docPath)) return 'app-data/lemma-progress.json';
  return 'app-data/' + docPath.replace(/[^A-Za-z0-9/_.-]/g, '-') + '.json';
}
// Desk keeps its record as a JSON string in "json"; store it expanded so the repo is readable.
const toFile = obj => { const o = Object.assign({}, obj); if (typeof o.json === 'string') { try { o.record = JSON.parse(o.json); delete o.json; } catch (e) {} } return JSON.stringify(o, null, 2) + '\n'; };
const fromFile = txt => { const o = JSON.parse(txt); if (o.record && o.json === undefined) { o.json = JSON.stringify(o.record); delete o.record; } return o; };

let docs = load(K.docs, {});          // file path -> object (last known, for offline)
let pending = load(K.pending, {});    // file path -> {content, label, at}
let flushTimer = null, flushing = null;

function queueWrite(file, obj, label) {
  docs[file] = obj; store(K.docs, docs);
  pending[file] = { content: toFile(obj), label, at: Date.now() }; store(K.pending, pending);
  scheduleFlush();
}
function scheduleFlush(delay = FLUSH_DELAY) {
  clearTimeout(flushTimer);
  const n = Object.keys(pending).length;
  if (!n) return;
  if (!settings.ghToken) { setStatus('local', 'Saved on this device. Add a GitHub token in Settings to sync.'); return; }
  setStatus('pending', `${n} change${n > 1 ? 's' : ''} waiting to sync`);
  flushTimer = setTimeout(() => flush().catch(() => {}), delay);
}
async function flush() {
  if (flushing) return flushing;
  const batch = Object.assign({}, pending);
  const paths = Object.keys(batch);
  if (!paths.length) { setStatus('ok', 'All changes synced'); return; }
  if (!settings.ghToken) { scheduleFlush(); return; }
  if (!navigator.onLine) { setStatus('offline', 'Offline. Changes are kept on this device and sync when you are back online.'); return; }
  flushing = (async () => {
    setStatus('syncing', 'Syncing to GitHub…');
    try {
      const labels = [...new Set(paths.map(p => batch[p].label).filter(Boolean))];
      const msg = 'study app: ' + (labels.length ? labels.join(', ') : 'save progress');
      const files = {}; paths.forEach(p => { files[p] = batch[p].content; });
      await commitFiles(files, msg);
      paths.forEach(p => { if (pending[p] && pending[p].at === batch[p].at) delete pending[p]; });
      store(K.pending, pending);
      const left = Object.keys(pending).length;
      setStatus(left ? 'pending' : 'ok', left ? `${left} change${left > 1 ? 's' : ''} waiting to sync` : 'All changes synced to ' + settings.ghRepo.split('/')[1]);
      if (left) scheduleFlush();
    } catch (e) {
      setStatus('error', e.status === 401 ? 'GitHub token rejected. Check it in Settings.' : 'Sync failed, will retry: ' + e.message);
      scheduleFlush(60000);
      throw e;
    } finally { flushing = null; }
  })();
  return flushing;
}
async function readDoc(file) {
  if (pending[file]) return fromFile(pending[file].content);
  if (settings.ghToken && navigator.onLine) {
    try { const t = await getFile(file); if (t == null) { delete docs[file]; store(K.docs, docs); return null; } const o = fromFile(t); docs[file] = o; store(K.docs, docs); return o; }
    catch (e) { /* fall back to the copy on this device */ }
  }
  return docs[file] || null;
}
async function readCollection(dirDoc) {
  const dir = 'app-data/' + dirDoc;
  const out = {};
  Object.keys(docs).filter(f => f.startsWith(dir + '/')).forEach(f => { out[f] = docs[f]; });
  if (settings.ghToken && navigator.onLine) {
    try {
      const items = (await listDir(dir)).filter(i => i.type === 'file' && i.name.endsWith('.json'));
      const got = await Promise.all(items.map(i => getFile(i.path).then(t => [i.path, t]).catch(() => [i.path, null])));
      got.forEach(([p, t]) => { if (t != null) { try { out[p] = docs[p] = fromFile(t); } catch (e) {} } });
      store(K.docs, docs);
    } catch (e) {}
  }
  Object.keys(pending).filter(f => f.startsWith(dir + '/')).forEach(f => { out[f] = fromFile(pending[f].content); });
  return out;
}
function makeDb() {
  const docRef = path => ({
    id: path.split('/').pop(),
    async get() { const v = await readDoc(fileFor(path)); return { exists: v != null, id: path.split('/').pop(), data: () => v }; },
    async set(obj) {
      const label = path.startsWith('attempts/') ? (obj.problem ? `${(obj.book || '').replace('deisenroth-', '')} ${obj.problem} attempt` : 'attempt')
        : /\/progress$/.test(path) ? 'lemma progress'
        : path.startsWith('exams/') ? `checkpoint ${obj.checkpoint || ''} exam (${obj.status || ''})`
        : path.startsWith('papers/') ? 'paper ' + path.slice(7)
        : path === 'plan' ? 'plan' + (obj.delayDays ? ` (+${obj.delayDays} d delay)` : '') : path;
      queueWrite(fileFor(path), JSON.parse(JSON.stringify(obj)), label);
    }
  });
  return {
    doc: docRef,
    collection: col => ({
      doc: id => docRef(col + '/' + id),
      async get() {
        const all = await readCollection(col);
        return { docs: Object.entries(all).map(([f, v]) => ({ id: f.split('/').pop().replace(/\.json$/, ''), exists: true, data: () => v })) };
      }
    })
  };
}

/* ---------------- Claude through the Anthropic API ---------------- */
class AiError extends Error { constructor(code, msg, text) { super(msg || code); this.code = code; if (text) this.text = text; } }
async function imageBlock(file) {
  const MAX = 1600;
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (e) { bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new AiError('image_rejected')); i.src = URL.createObjectURL(file); }); }
  const w = bmp.width, h = bmp.height, s = Math.min(1, MAX / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: url.split(',')[1] } };
}
async function prepareImages(images) {
  // Files come from the frames' own realm, so check shape rather than instanceof.
  const files = images ? (typeof images.length === 'number' ? Array.from(images) : [images]) : [];
  return Promise.all(files.map(imageBlock));
}
async function pdfBlock(file) {
  const buf = await file.arrayBuffer();
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: btoa(bin) } };
}

/* ---------------- files kept on this device (queued pages, PDFs) ---------------- */
const IDB = { name: 'study-files', store: 'files' };
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB.name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB.store);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB.store, mode); const st = tx.objectStore(IDB.store);
    const req = fn(st);
    tx.oncomplete = () => { res(req && req.result); db.close(); };
    tx.onerror = () => { rej(tx.error); db.close(); };
  });
}
const files = {
  put: (key, val) => idbDo('readwrite', st => st.put(val, key)),
  get: key => idbDo('readonly', st => st.get(key)),
  del: key => idbDo('readwrite', st => st.delete(key))
};

async function callClaude(input, opts = {}) {
  if (!settings.apiKey) throw new AiError('no_key', 'Add your Anthropic API key in Settings.');
  const complex = opts.modelTier === 'complex';
  let messages = typeof input === 'string' ? [{ role: 'user', content: input }]
    : input.map(t => ({ role: t.role, content: t.content }));
  const pre = opts.imageBlocks ? Array.from(opts.imageBlocks) : [];
  const docs = opts.pdf ? [opts.pdf.type === 'document' ? opts.pdf : await pdfBlock(opts.pdf)] : [];
  const imgs = pre.length ? pre : await prepareImages(opts.images);
  if (imgs.length || docs.length) {
    const blocks = docs.concat(imgs);
    const last = messages[messages.length - 1];
    const text = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    messages = messages.slice(0, -1).concat([{ role: 'user', content: blocks.concat(text) }]);
  }
  const useThinking = complex && settings.thinking && !opts._noThinking;
  const body = {
    model: complex ? settings.modelComplex : settings.modelFast,
    max_tokens: useThinking ? 16000 : (complex ? 8000 : 2000),
    messages, stream: true
  };
  if (useThinking) body.thinking = { type: 'enabled', budget_tokens: 6000 };
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: opts.signal,
      headers: {
        'content-type': 'application/json', 'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new AiError('cancelled');
    throw new AiError(navigator.onLine ? 'network' : 'offline', navigator.onLine ? 'Could not reach Claude.' : 'You are offline.');
  }
  if (!res.ok) {
    let m = ''; try { m = ((await res.json()).error || {}).message || ''; } catch (e) {}
    if (useThinking && res.status === 400 && /thinking|budget/i.test(m)) return callClaude(input, Object.assign({}, opts, { _noThinking: true }));
    if (res.status === 401 || res.status === 403) throw new AiError('not_granted', 'Your Anthropic API key was rejected. Check it in Settings.');
    if (res.status === 429 || res.status === 529) throw new AiError('rate_limited');
    if (res.status === 413 || /too long|too large/i.test(m)) throw new AiError('prompt_too_large');
    throw new AiError('api_error', `Claude API ${res.status}: ${m}`);
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data:'));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          if (opts.onText) { try { opts.onText({ text }); } catch (e) {} }
        } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') truncated = true;
        else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'refusal') throw new AiError('refused', '', text);
        else if (ev.type === 'error') throw new AiError((ev.error && ev.error.type) === 'overloaded_error' ? 'rate_limited' : 'api_error', (ev.error && ev.error.message) || 'Stream error', text);
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new AiError('cancelled', '', text);
    throw e instanceof AiError ? e : new AiError('network', 'The connection dropped.', text);
  }
  return { text, truncated };
}
function parseJsonLoose(t) {
  const s = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  throw new AiError('bad_shape', 'Claude did not return valid JSON.');
}
function makeSample() {
  const s = (input, opts) => callClaude(input, opts);
  s.json = async (prompt, opts = {}) => parseJsonLoose((await callClaude(prompt + '\n\nReply with the JSON object only: no code fences, no text before or after it.', opts)).text);
  s.limits = async () => ({ images: true });
  return s;
}

/* ---------------- public surface ---------------- */
const Hub = {
  get settings() { return Object.assign({}, settings); },
  saveSettings(patch) {
    const had = settings.ghToken;
    settings = Object.assign({}, settings, patch); store(K.settings, settings);
    if (!had && settings.ghToken) scheduleFlush(1000);
  },
  forgetKeys() { settings = Object.assign({}, settings, { ghToken: '', apiKey: '' }); store(K.settings, settings); },
  getContent, fetchContent,
  async testGitHub() {
    const r = await fetch(`https://api.github.com/repos/${settings.ghRepo}`, { headers: { Authorization: 'Bearer ' + settings.ghToken, Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!r.ok) throw new GhError(r.status === 404 ? 'Repo not found, or the token cannot see it' : r.status === 401 ? 'Token rejected' : 'GitHub ' + r.status, r.status);
    const j = await r.json();
    if (!j.permissions || !j.permissions.push) throw new GhError('The token can read but not write. Give it Contents: Read and write.', 403);
    return j;
  },
  async testClaude() { const r = await callClaude('Reply with the single word: ok'); return r.text.trim(); },
  async use(name) {
    if (name === 'db') return makeDb();
    if (name === 'sample') return settings.apiKey ? makeSample() : null;
    if (name === 'user') return { id: async () => 'me' };
    return null;
  },
  files, prepareImages, pdfBlock,
  isOnline: () => navigator.onLine,
  hasKey: () => !!settings.apiKey,
  // Raw markdown/text files in the private repo (paper notes), batched with everything else.
  writeText(path, text, label) { pending[path] = { content: text, label, at: Date.now() }; store(K.pending, pending); scheduleFlush(); },
  flush, onStatus(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); },
  get pendingCount() { return Object.keys(pending).length; }
};

window.addEventListener('online', () => scheduleFlush(2000));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && Object.keys(pending).length) flush().catch(() => {}); });
if (Object.keys(pending).length) scheduleFlush(3000); else setStatus('ok', settings.ghToken ? 'All changes synced' : 'Add a GitHub token in Settings to sync');

window.Hub = Hub;
})();
