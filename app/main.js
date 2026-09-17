/**
 * main.js — composition root. Wires Store, Sync and View together and owns all
 * DOM event handling. Every other module stays free of globals.
 */

import { CONFIG } from '../config.js';
import { createStore, TEXT_SIZES } from './store.js';
import { createSync, Status } from './sync.js';
import * as View from './view.js';
import * as Crypto from './crypto.js';

const $ = (id) => document.getElementById(id);
const listEl = $('list');

/**
 * Which list this page is. `?list=<name>` so several households can share one
 * deployment and one database, each with its own link, its own passphrase and
 * its own local state. Only one list exists today; the plumbing is here so
 * adding the second does not mean migrating state off anyone's phone.
 */
const okId = (v) => typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v.toLowerCase());

/** The list that carries the scraped Sam's/Costco catalogue. Every other list
 *  starts empty. */
const DEFAULT_LIST = okId(CONFIG.listId) ? CONFIG.listId.toLowerCase() : 'household';

/** Device-wide, not per-list. */
const LAST_KEY = 'pnp.lastList';
const LISTS_KEY = 'pnp.lists';

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

/**
 * Which list this page is.
 *
 * The home-screen icon cannot carry a query string: Add to Home Screen uses the
 * manifest's `start_url`, not the URL on screen, so an icon added from
 * `?list=beach` would silently open the household list instead. Remembering the
 * last list opened on this device makes the icon land where the person expects,
 * and an explicit `?list=` in a shared link always wins.
 */
const LIST_ID = (() => {
  const q = new URLSearchParams(location.search).get('list');
  if (okId(q)) return q.toLowerCase();
  const last = readLocal(LAST_KEY, null);
  if (okId(last)) return String(last).toLowerCase();
  return DEFAULT_LIST;
})();

/* ---- the lists this device knows about (never synced: a device only knows
        the lists it has been given links to) ---- */

function knownLists() {
  const reg = readLocal(LISTS_KEY, null);
  const out = (reg && typeof reg === 'object' && !Array.isArray(reg)) ? { ...reg } : {};
  if (!out[DEFAULT_LIST]) out[DEFAULT_LIST] = { label: 'Household', at: 0 };
  return out;
}

function prettify(id) {
  return String(id).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function listLabel(id = LIST_ID) {
  const rec = knownLists()[id];
  return (rec && rec.label) || prettify(id);
}

function rememberList(id, label) {
  const reg = knownLists();
  reg[id] = { label: label || reg[id]?.label || prettify(id), at: Date.now() };
  writeLocal(LISTS_KEY, reg);
  writeLocal(LAST_KEY, id);
}

function linkFor(id) {
  const base = location.href.split('?')[0].split('#')[0];
  return id === DEFAULT_LIST ? base : `${base}?list=${encodeURIComponent(id)}`;
}

function switchTo(id) {
  if (id === LIST_ID) { closeSheet('listsSheet'); return; }
  writeLocal(LAST_KEY, id);
  location.href = linkFor(id);
}

// Per-list, like the store's own key. Each household gets its own link, its own
// passphrase and its own identity; one shared key across lists would mean
// unlocking one silently unlocked another.
const keyFor = (name) => `pnp.${name}:${LIST_ID}`;
const PASS_KEY = keyFor('pass');
const SALT_KEY = keyFor('salt');
const CHECK_KEY = keyFor('check');

const store = createStore({ ns: LIST_ID });
let sync = null;
let cryptoKey = null;

/**
 * The server holds a complete identity that this device cannot verify, while
 * this device holds one that works. Ambiguous by construction — tampering and a
 * stale local cache look identical — so we keep working locally and tell a
 * human instead of guessing and starting an overwrite war.
 */
let identityConflict = false;
function emitIdentityWarning() {
  toast('This list’s passphrase was changed elsewhere — you are working from this phone’s copy');
}

/* ================= codec ================= */

/** Identity codec when the list is not passphrase-protected. */
const plainCodec = {
  encode: async (rec) => rec,
  decode: async (wire) => (wire && typeof wire === 'object' ? wire : undefined),
};

const sealedCodec = {
  encode: (rec, slot) => Crypto.encryptJSON(cryptoKey, rec, slot),
  decode: (wire, slot) => Crypto.decryptJSON(cryptoKey, wire, slot),
};

/* ================= render ================= */

let renderQueued = false;
let renderTimer = null;

/**
 * Coalesced repaint.
 *
 * rAF alone is not safe to own the latch: browsers do not deliver frames to a
 * hidden document, so a render scheduled while the page is backgrounded would
 * leave `renderQueued` stuck true and silently swallow every later render —
 * including after the page came back. That is the common path here (open the
 * link, switch apps to fetch the passphrase, switch back), so the timer is the
 * guarantee and rAF is only the fast path.
 */
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(paint);
  renderTimer = setTimeout(paint, 250);
}

function paint() {
  if (!renderQueued) return;
  renderQueued = false;
  clearTimeout(renderTimer);
  // Nobody is looking. `visibilitychange -> visible` repaints unconditionally,
  // so skipping here is safe and saves a full rebuild per remote patch while
  // the phone is in a pocket. Do NOT remove that handler without removing this.
  if (document.hidden) return;
  try { repaint(); } catch {
    // A row we cannot render must not take the page down. Without this one bad
    // record blanks the app on every device that merged it, permanently,
    // because the record is persisted and re-thrown on every later paint.
    listEl.innerHTML = '<div class="empty">Something on this list could not be shown.'
      + '<br><br>Tap <b>⋯</b> then <b>Forget this device</b> if this keeps happening.</div>';
  }
}

function repaint() {
  const s = store.state;
  $('tabs').innerHTML = View.tabsHTML(s);
  const c = View.counts(s, s.ui.store);
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  $('pfill').style.width = pct + '%';
  const storeLabel = (View.STORES.find((x) => x.id === s.ui.store) || View.STORES[0]).label;
  $('pleft').textContent = LIST_ID === DEFAULT_LIST ? storeLabel : `${listLabel()} · ${storeLabel}`;
  $('pright').textContent = planning
    ? 'Tick what you need this time'
    : `${c.done} of ${c.total} handled · ${pct}%`;
  listEl.innerHTML = View.listHTML(s, { planning });
  document.body.classList.toggle('planning', planning);
  $('planBtn').textContent = planning ? '✓ Done — back to shopping' : '✎ Choose what to buy';
  $('planBtn').classList.toggle('on', planning);
}

function setSyncBadge(status, detail) {
  const el = $('syncBadge');
  const pending = store.pendingCount();
  const map = {
    [Status.LIVE]: pending ? [`↑ ${pending}`, 'warn'] : ['● Live', 'ok'],
    [Status.CONNECTING]: ['◌ Connecting', 'warn'],
    [Status.OFFLINE]: [pending ? `Offline ↑${pending}` : 'Offline', 'warn'],
    [Status.ERROR]: [detail?.reason === 'rules' ? 'Blocked' : 'Retrying', 'bad'],
  };
  let [text, cls] = map[status] || ['—', ''];
  // The menu promises taps are saved for later. If the disk is refusing writes
  // that promise is false, and saying nothing would make the app lie.
  if (store.isPersistBroken()) { text = 'Not saved'; cls = 'bad'; }
  el.textContent = text;
  el.className = 'badge ' + cls;
}

/* ================= sheets ================= */

function openSheet(id) { $(id).classList.add('open'); }
function closeSheet(id) { $(id).classList.remove('open'); }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2100);
}

/* ================= actions ================= */

let noteTarget = null;

let lastAct = { id: null, act: null, at: 0 };

function onAct(itemId, act) {
  // Two non-technical users on a cold phone: a double-tap is the commonest
  // input error they make, and untoggling looks identical to the app losing
  // the tap — the one failure that would end their trust in it.
  const now = Date.now();
  if (lastAct.id === itemId && lastAct.act === act && now - lastAct.at < 600) return;
  lastAct = { id: itemId, act, at: now };

  const cur = store.state.items[itemId]?.s || '';
  if (cur === act) { store.setStatus(itemId, null); return; }
  store.setStatus(itemId, act);
  if (act === 'swap' || act === 'skip') openNote(itemId, act);
}

function openNote(itemId, st) {
  noteTarget = itemId;
  const swap = st === 'swap';
  $('noteTitle').textContent = swap ? 'Swapped for…' : 'Skipped — why?';
  $('noteLabel').textContent = swap ? 'What did you actually buy?' : 'Out of stock? Too expensive?';
  const ta = $('noteText');
  ta.placeholder = swap ? 'e.g. Kirkland 25 lb instead, $18.99' : 'e.g. out of stock';
  ta.value = store.state.items[itemId]?.n || '';

  // Offered only on Skip, and only for catalogue rows. Skipping is the moment a
  // shopper discovers the list is wrong about a store, so it is the natural
  // place to ask — and it costs no room on the row itself.
  const storeId = store.state.ui.store;
  const flaggable = !swap && !String(itemId).startsWith('a');
  $('flagWrap').style.display = flaggable ? '' : 'none';
  $('flagBox').checked = flaggable && store.isFlagged(itemId, storeId);
  $('flagLabelText').textContent =
    `${(View.STORES.find((x) => x.id === storeId) || {}).label || 'This store'} never stocks this`;

  openSheet('noteSheet');
  setTimeout(() => ta.focus(), 120);
}

function saveNote() {
  const v = $('noteText').value.trim();
  const st = store.state.items[noteTarget]?.s;
  if (st) store.setStatus(noteTarget, st, v);

  if ($('flagWrap').style.display !== 'none') {
    const storeId = store.state.ui.store;
    const want = $('flagBox').checked;
    if (want !== store.isFlagged(noteTarget, storeId)) store.setFlag(noteTarget, storeId, want);
  }
  closeSheet('noteSheet');
  sync?.drain();
}

let addStore = 'sams';
function openAdd() {
  addStore = store.state.ui.store;
  $('addName').value = '';
  $('addNote').value = '';
  $('addStore').innerHTML = View.STORES
    .map((s) => `<button data-addstore="${s.id}" class="${addStore === s.id ? 'on' : ''}">${View.esc(s.short)}</button>`)
    .join('');
  openSheet('addSheet');
  setTimeout(() => $('addName').focus(), 120);
}

function saveAdd() {
  const name = $('addName').value.trim();
  if (!name) { toast('Give it a name first'); return; }
  store.addItem({ name, note: $('addNote').value.trim(), store: addStore });
  closeSheet('addSheet');
  if (store.state.ui.store !== addStore) store.setUI({ store: addStore });
  toast('Added');
  sync?.drain();
}

/* ================= lists ================= */

function slugifyName(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function renderLists() {
  const reg = knownLists();
  const ids = Object.keys(reg).sort((a, b) => (reg[b].at || 0) - (reg[a].at || 0));
  $('listsBody').innerHTML = ids.map((id) => {
    const here = id === LIST_ID;
    return `<button class="wide listrow${here ? ' on' : ''}" data-switch="${View.esc(id)}">`
      + `${View.esc(reg[id].label || id)}`
      + (here ? '<span class="tag">you are here</span>' : '')
      + (id === DEFAULT_LIST ? '<span class="tag dim">shopping list</span>' : '')
      + `</button>`;
  }).join('');
}

function openLists() {
  closeSheet('menuSheet');
  renderLists();
  openSheet('listsSheet');
}

function openNewList() {
  closeSheet('listsSheet');
  $('newListName').value = '';
  $('newListErr').textContent = '';
  $('newListPreview').textContent = '';
  openSheet('newListSheet');
  setTimeout(() => $('newListName').focus(), 150);
}

function previewNewList() {
  const id = slugifyName($('newListName').value);
  $('newListPreview').textContent = id ? linkFor(id) : '';
  return id;
}

function createList() {
  const label = $('newListName').value.trim();
  const id = slugifyName(label);
  if (!id) { $('newListErr').textContent = 'Give the list a name.'; return; }
  if (knownLists()[id]) { $('newListErr').textContent = 'You already have a list with that name.'; return; }
  // Nothing is created server-side here. A list exists the moment someone opens
  // it and sets a passphrase, which is the same path the household list took.
  rememberList(id, label);
  location.href = linkFor(id);
}

async function shareThisList() {
  const url = linkFor(LIST_ID);
  if (navigator.share) {
    try { await navigator.share({ title: `Plate & Parcel — ${listLabel()}`, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch { toast(url); }
}

/* ================= appearance ================= */

/**
 * Theme lives in its OWN localStorage key rather than in `store.ui`, where the
 * other device preferences live. That is deliberate: the theme has to be
 * applied before the first paint or a light-preferring phone flashes dark, and
 * the pre-paint reader is an inline script in <head> that runs long before any
 * module is parsed. Making it read the store's JSON would couple that script to
 * the store schema for the sake of one string.
 */
const THEME_KEY = 'pnp.theme';
const THEMES = ['auto', 'light', 'dark'];
const THEME_COLOR = { light: '#f2f4f8', dark: '#12141c' };

function readTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEMES.includes(v) ? v : 'auto';
  } catch { return 'auto'; }
}

function prefersLight() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
}

function applyTheme() {
  const choice = readTheme();
  const resolved = choice === 'auto' ? (prefersLight() ? 'light' : 'dark') : choice;
  document.documentElement.setAttribute('data-theme', resolved);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[resolved]);
  for (const b of document.querySelectorAll('[data-theme-set]')) {
    b.classList.toggle('on', b.dataset.themeSet === choice);
  }
}

function setTheme(v) {
  if (!THEMES.includes(v)) return;
  try { localStorage.setItem(THEME_KEY, v); } catch { /* private mode: this load only */ }
  applyTheme();
}

/**
 * Follow the system while set to Auto. `addEventListener` on a MediaQueryList
 * is Safari 14+; older iPhones only have the deprecated `addListener`, and the
 * parents' phones are exactly the population that might be on one.
 */
function watchSystemTheme() {
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => { if (readTheme() === 'auto') applyTheme(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/* ================= welcome ================= */

const WELCOMED = 'pnp.welcomed';

function openWelcome() {
  closeSheet('menuSheet');
  renderInstallHelp($('welcomeInstall'));
  openSheet('welcomeSheet');
}

/**
 * Shown once per device, on top of the passphrase gate rather than instead of
 * it: the gate is the first thing a new person meets and it explains nothing on
 * its own. Marked seen when dismissed, not when shown, so an accidental reload
 * mid-read does not burn it.
 */
function maybeWelcome() {
  let seen = false;
  try { seen = localStorage.getItem(WELCOMED) === '1'; } catch { seen = true; }
  if (seen) return;
  openWelcome();
}

function dismissWelcome() {
  try { localStorage.setItem(WELCOMED, '1'); } catch { /* nothing to do */ }
  closeSheet('welcomeSheet');
}

/* ================= add to home screen ================= */

/**
 * Android hands us a real install prompt. iOS does not — Apple exposes no API,
 * so all we can do there is point at the Share button.
 *
 * The trap worth handling is that a link tapped inside Messages or Facebook
 * opens in an in-app browser that has NO "Add to Home Screen" at all. Someone
 * following instructions that assume Safari will look for a button that is not
 * there and conclude they did it wrong.
 */
let installPrompt = null;
const INSTALL_DISMISSED = keyFor('installed');

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** In-app browsers (Messages, Mail, Facebook) have no Add to Home Screen. */
function isInAppBrowser() {
  if (!isIOS()) return false;
  const ua = navigator.userAgent;
  if (/CriOS|FxiOS|EdgiOS/.test(ua)) return true;          // Chrome/Firefox/Edge on iOS
  return !/Safari/.test(ua);                                // SFSafariViewController et al
}

function installDismissed() {
  try { return localStorage.getItem(INSTALL_DISMISSED) === '1'; } catch { return false; }
}

function renderInstallHelp(box = $('installBody')) {
  if (isStandalone()) {
    box.innerHTML = '<p class="ok-line">✓ Already on your home screen. Nothing to do.</p>';
    return;
  }
  if (installPrompt) {
    box.innerHTML = '<p>Tap the button and confirm. It will appear with your other apps.</p>'
      + '<button class="wide primary" data-install-go>Add Plate &amp; Parcel to my home screen</button>';
    box.querySelector('[data-install-go]').onclick = async () => {
      const p = installPrompt;
      installPrompt = null;
      try { await p.prompt(); await p.userChoice; } catch { /* dismissed */ }
      renderInstallHelp(box);
    };
    return;
  }
  if (isInAppBrowser()) {
    box.innerHTML =
      '<p><b>Open this in Safari first.</b></p>'
      + '<p>Links tapped inside Messages open in a mini-browser that cannot add to the '
      + 'home screen. Look for the <b>compass icon</b> (Safari) at the bottom of the screen, '
      + 'or tap <b>…</b> then <b>Open in Safari</b>. Then come back here.</p>';
    return;
  }
  if (isIOS()) {
    box.innerHTML =
      '<ol class="steps">'
      + '<li>Tap the <b>Share</b> button &mdash; the square with an arrow pointing up, '
      + 'at the <b>bottom</b> of Safari.</li>'
      + '<li>Scroll down the list that appears.</li>'
      + '<li>Tap <b>Add to Home Screen</b>.</li>'
      + '<li>Tap <b>Add</b> in the top right.</li>'
      + '</ol>'
      + '<p class="hint">If there is no Share button, you are not in Safari &mdash; '
      + 'see the note above about Messages.</p>';
    return;
  }
  box.innerHTML =
    '<ol class="steps">'
    + '<li>Tap the <b>⋮</b> menu, top right of the browser.</li>'
    + '<li>Tap <b>Add to Home screen</b> (or <b>Install app</b>).</li>'
    + '<li>Confirm.</li>'
    + '</ol>';
}

function openInstall() {
  closeSheet('menuSheet');
  renderInstallHelp();
  openSheet('installSheet');
}

function maybeOfferInstall() {
  if (isStandalone() || installDismissed()) return;
  $('installBar').style.display = '';
}

function dismissInstallBar() {
  try { localStorage.setItem(INSTALL_DISMISSED, '1'); } catch { /* ignore */ }
  $('installBar').style.display = 'none';
}

/* ================= import ================= */

let importParsed = [];

function openImport() {
  closeSheet('menuSheet');
  $('importText').value = '';
  $('importPreview').textContent = '';
  $('importGo').disabled = true;
  openSheet('importSheet');
  setTimeout(() => $('importText').focus(), 150);
}

function previewImport() {
  importParsed = store.parseList($('importText').value);
  const storeLabel = (View.STORES.find((x) => x.id === store.state.ui.store) || {}).short || '';
  $('importPreview').textContent = importParsed.length
    ? `${importParsed.length} item${importParsed.length === 1 ? '' : 's'} → ${storeLabel}: ${importParsed.slice(0, 6).join(', ')}${importParsed.length > 6 ? '…' : ''}`
    : 'Nothing to add yet — paste a list above, one item per line.';
  $('importGo').disabled = !importParsed.length;
}

function doImport() {
  if (!importParsed.length) return;
  const n = store.importItems(importParsed, store.state.ui.store);
  closeSheet('importSheet');
  toast(`Added ${n} item${n === 1 ? '' : 's'}`);
  sync?.drain();
}

/* ================= export ================= */

function openTrip() {
  $('report').value = View.buildReport(store.state);
  openSheet('tripSheet');
}

async function shareTrip() {
  const text = View.buildReport(store.state);
  if (navigator.share) {
    try { await navigator.share({ title: 'Shopping trip', text }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copyTrip();
}

async function copyTrip() {
  const text = View.buildReport(store.state);
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch {
    const t = $('report');
    t.removeAttribute('readonly'); t.select();
    try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy failed — select and copy'); }
    t.setAttribute('readonly', 'readonly');
  }
}

function downloadTrip() {
  const blob = new Blob([View.buildReport(store.state)], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'plate-and-parcel-trip-' + new Date().toISOString().slice(0, 10) + '.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Saved');
}

/* ================= passphrase ================= */

function readStoredPass() { try { return localStorage.getItem(PASS_KEY) || ''; } catch { return ''; } }
function readStoredSalt() { try { return localStorage.getItem(SALT_KEY) || ''; } catch { return ''; } }
function readStoredCheck() { try { return localStorage.getItem(CHECK_KEY) || ''; } catch { return ''; } }

/**
 * The salt and the canary are cached next to the passphrase deliberately.
 *
 * The salt is not a secret — it is the list's identity — and the canary is a
 * known plaintext. Together they let a device that was ever unlocked verify
 * itself with no network at all, and put the real identity back if the server
 * loses or is made to lose it.
 *
 * `meta` lives in the same world-writable node as the data. Anyone with the URL
 * can overwrite it. Without a locally cached identity to fall back on, one such
 * write locks the whole family out of a list whose real salt is sitting on all
 * four of their phones.
 */
function writeStoredIdentity(pass, salt, check) {
  try {
    if (pass) localStorage.setItem(PASS_KEY, pass);
    if (salt) localStorage.setItem(SALT_KEY, salt);
    if (check) localStorage.setItem(CHECK_KEY, check);
  } catch { /* ignore */ }
}

/** Derive and verify in one step. Returns the key, or null if it does not fit. */
async function tryKey(pass, salt, check) {
  if (!pass || !Crypto.isValidSalt(salt)) return null;
  let key;
  try { key = await Crypto.deriveKey(pass, salt); } catch { return null; }
  // A salt with no check is NOT a verified identity. Treating a missing check
  // as success let anyone who could write to the node silently re-key the whole
  // list: every device would derive a fresh key from the attacker's salt, seal
  // new work under it, and quietly drop every record written before.
  if (!check) return null;
  return (await Crypto.verifyCheck(key, check)) ? key : null;
}

/**
 * Resolves once a usable key exists (or immediately when the list is open).
 * The passphrase is kept on the device so a non-technical viewer types it once,
 * not once per trip; it is never sent anywhere.
 */
async function unlock(tempSync) {
  if (!CONFIG.requirePassphrase) return plainCodec;
  if (!Crypto.isSupported()) {
    document.body.innerHTML = '<div class="fatal">This browser cannot do the encryption this list needs. '
      + 'Please open it in Chrome, Safari or Firefox over https.</div>';
    throw new Error('no webcrypto');
  }

  const stored = readStoredPass();
  const cachedSalt = readStoredSalt();
  const cachedCheck = readStoredCheck();

  // Local identity first, and without waiting on the network. Every device
  // after its first unlock already has everything it needs; asking the server
  // first cost up to a full read timeout of dead boot on exactly the flaky
  // link where that time is most expensive.
  if (stored && cachedSalt && cachedCheck) {
    const key = await tryKey(stored, cachedSalt, cachedCheck);
    if (key) {
      cryptoKey = key;
      // Repair a lost or overwritten identity in the background; never block on it.
      tempSync.readMeta().then(async (r) => {
        if (!r.ok) return;
        const m = r.meta;
        if (m && m.salt === cachedSalt && m.check) return;         // healthy
        if (m && m.salt && m.check && await tryKey(stored, m.salt, m.check)) return; // theirs is also valid

        // A COMPLETE server identity we cannot verify is ambiguous: either the
        // node was tampered with, or this device's cache is from a superseded
        // incarnation of the list. Overwriting on a guess creates a flip-flop
        // war between two self-consistent devices, each healing the other away.
        // Keep working locally, say so once, and let a human decide.
        if (m && m.salt && m.check) { identityConflict = true; emitIdentityWarning(); return; }

        // Absent or half-written is not ambiguous. Nobody can use that, and we
        // hold something that verifies, so put it back.
        const write = m && m.salt ? tempSync.forceWriteMeta : tempSync.writeMetaIfAbsent;
        write.call(tempSync, { salt: cachedSalt, check: cachedCheck }).catch(() => {});
      }).catch(() => {});
      return sealedCodec;
    }
  }

  const r = await tempSync.readMeta();
  if (!r.ok) {
    // Unreachable, full stop — cached identity or not. With a stored passphrase
    // but no usable cache this used to fall through to promptPass, tell the user
    // their CORRECT passphrase did not match, and trap them there: the gate is
    // deliberately exempt from backdrop-close, so there was no way back.
    throw new Error('unreachable');
  }
  const meta = r.meta;

  if (stored) {
    const key = (await tryKey(stored, meta?.salt, meta?.check))
             || (await tryKey(stored, cachedSalt, cachedCheck));
    if (key) {
      cryptoKey = key;
      const salt = (await tryKey(stored, meta?.salt, meta?.check)) ? meta.salt : cachedSalt;
      const check = salt === cachedSalt ? cachedCheck : meta.check;
      writeStoredIdentity(stored, salt, check);
      return sealedCodec;
    }
    if (!navigator.onLine) return null;   // offline, nothing verifiable yet
  }

  return await promptPass(tempSync, meta, r.ok);
}

const MIN_PASS = 10;

/**
 * @param {boolean} reachable whether the list could be read at all. Only a
 *   confirmed-absent identity may be claimed; an unreachable one must never be,
 *   or a timeout on one person's first open silently re-keys everyone's data.
 */
function promptPass(tempSync, meta, reachable) {
  return new Promise((resolve) => {
    const hasIdentity = !!(meta && meta.salt && meta.check);
    const isNew = reachable && !hasIdentity;
    const cachedSalt = readStoredSalt();
    const cachedCheck = readStoredCheck();

    $('passTitle').textContent = isNew ? 'Set the list passphrase' : 'Enter the list passphrase';
    $('passHint').textContent = isNew
      ? `You are the first person here. Pick a passphrase of at least ${MIN_PASS} characters — a few words is easiest — and share it with the others. They type it once on their own phone.`
      : 'Ask whoever set the list up. You only have to type it once on this device.';
    $('passInput').value = '';
    $('passErr').textContent = '';
    openSheet('passSheet');
    setTimeout(() => $('passInput').focus(), 150);

    const submit = async () => {
      const p = $('passInput').value;
      if (isNew && p.length < MIN_PASS) {
        // Only enforced when SETTING one. An existing list may predate the rule
        // and its members must still be able to get in.
        $('passErr').textContent = `At least ${MIN_PASS} characters — try three words.`;
        return;
      }
      if (!p) { $('passErr').textContent = 'Type the passphrase.'; return; }
      $('passGo').disabled = true;
      $('passErr').textContent = 'Checking…';
      try {
        if (isNew) {
          const salt = Crypto.randomSalt();
          const key = await Crypto.deriveKey(p, salt);
          const check = await Crypto.makeCheck(key);
          // Throws if the list is unreachable; adopts a rival claim if two
          // people open a fresh list within the same few seconds.
          const settled = await tempSync.writeMetaIfAbsent({ salt, check }, store.state.me.id);
          const finalKey = settled.salt === salt ? key : await Crypto.deriveKey(p, settled.salt);
          if (!(await Crypto.verifyCheck(finalKey, settled.check))) {
            $('passErr').textContent = 'Someone already set a different passphrase. Ask them for it.';
            $('passGo').disabled = false;
            return;
          }
          cryptoKey = finalKey;
          writeStoredIdentity(p, settled.salt, settled.check);
        } else {
          // Try the server's identity, then the one this device remembers. The
          // second is what rescues the family when the node has been tampered
          // with or half-written.
          const key = (await tryKey(p, meta?.salt, meta?.check))
                   || (await tryKey(p, cachedSalt, cachedCheck));
          if (!key) {
            $('passErr').textContent = 'That passphrase does not match.';
            $('passGo').disabled = false;
            return;
          }
          const viaServer = !!(await tryKey(p, meta?.salt, meta?.check));
          cryptoKey = key;
          writeStoredIdentity(p, viaServer ? meta.salt : cachedSalt, viaServer ? meta.check : cachedCheck);
        }
        closeSheet('passSheet');
        $('passGo').disabled = false;
        resolve(sealedCodec);
      } catch {
        $('passErr').textContent = 'Could not reach the list. Check your signal and try again.';
        $('passGo').disabled = false;
      }
    };

    $('passGo').onclick = submit;
    // The phone keyboard's Go key must work. Without this a user types the
    // passphrase, presses Go, nothing happens, and they conclude it is broken.
    $('passInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  });
}

/* ================= name ================= */

function ensureName() {
  if (store.state.me.name) return;
  $('nameInput').value = '';
  openSheet('nameSheet');
  setTimeout(() => $('nameInput').focus(), 150);
}

/* ================= boot ================= */

function wireEvents() {
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-store]');
    if (b) { store.setUI({ store: b.dataset.store }); scrollTo({ top: 0 }); }
  });

  // One delegated listener for ~80 rows instead of ~250 node listeners.
  listEl.addEventListener('click', (e) => {
    const qtyBtn = e.target.closest('[data-qty]');
    if (qtyBtn) {
      if (qtyBtn.disabled) return;
      store.bumpQty(qtyBtn.dataset.qty, Number(qtyBtn.dataset.delta));
      sync?.drain();
      return;
    }
    const planBtn = e.target.closest('[data-plan]');
    if (planBtn) {
      const id = planBtn.dataset.plan;
      store.setPlanned(id, !store.isPlanned(id));
      sync?.drain();
      return;
    }
    const unflag = e.target.closest('[data-unflag]');
    if (unflag) {
      const id = unflag.dataset.unflag;
      if (confirm('Clear the "not stocked here" note for everyone?')) {
        store.setFlag(id, store.state.ui.store, false);
        sync?.drain();
      }
      return;
    }
    if (planning) return;   // planning mode has no Got/Swap/Skip
    const rm = e.target.closest('[data-remove]');
    if (rm) { store.removeAdded(rm.dataset.remove); sync?.drain(); return; }
    const noteLine = e.target.closest('[data-note]');
    if (noteLine) {
      const id = noteLine.dataset.note;
      openNote(id, store.state.items[id]?.s);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const row = act.closest('[data-id]');
    if (!row) return;
    onAct(row.dataset.id, act.dataset.act);
    sync?.drain();
  });

  $('addStore').addEventListener('click', (e) => {
    const b = e.target.closest('[data-addstore]');
    if (!b) return;
    addStore = b.dataset.addstore;
    [...$('addStore').children].forEach((x) => x.classList.toggle('on', x.dataset.addstore === addStore));
  });

  document.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', () => {
      closeSheet(b.dataset.close);
      // Cancelling a note and immediately retrying the same button is a
      // legitimate correction; without this the double-tap guard swallows it
      // and nothing at all happens on screen.
      lastAct = { id: null, act: null, at: 0 };
    }));
  document.querySelectorAll('.sheet-bg').forEach((bg) => {
    // Tapping the backdrop is how every other sheet closes, so a user will try
    // it here too. On the passphrase sheet it used to hide the gate while
    // leaving its promise pending forever: the list looked fine and fully
    // interactive, sync never started, and an afternoon of ticks reached nobody.
    if (bg.id === 'passSheet') return;
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.remove('open'); });
  });

  $('planBtn').onclick = () => { planning = !planning; render(); scrollTo({ top: 0 }); };
  $('fabAdd').onclick = openAdd;
  $('importText').addEventListener('input', previewImport);
  $('importGo').onclick = doImport;
  $('menuImport').onclick = openImport;
  $('menuInstall').onclick = openInstall;
  $('menuLists').onclick = openLists;
  $('menuWelcome').onclick = openWelcome;
  $('welcomeGo').onclick = dismissWelcome;
  for (const b of document.querySelectorAll('[data-theme-set]')) {
    b.onclick = () => setTheme(b.dataset.themeSet);
  }
  $('newListGo').onclick = createList;
  $('listsNew').onclick = openNewList;
  $('listsShare').onclick = shareThisList;
  $('newListName').addEventListener('input', previewNewList);
  $('newListName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createList(); }
  });
  $('listsBody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-switch]');
    if (b) switchTo(b.dataset.switch);
  });
  $('installOpen').onclick = openInstall;
  $('installNo').onclick = dismissInstallBar;
  $('saveAdd').onclick = saveAdd;
  $('saveNote').onclick = saveNote;
  $('btnTrip').onclick = openTrip;
  $('btnMenu').onclick = () => openSheet('menuSheet');
  $('btnBig').onclick = () => {
    const next = (store.state.ui.text + 1) % TEXT_SIZES.length;
    store.setUI({ text: next });
    applyTextSize();
  applyTheme();
  watchSystemTheme();
    // The button cycles, so its own face cannot show every option. Name the one
    // you just landed on: without this, somebody who cannot read the small text
    // has no way to tell whether the tap did anything at all.
    toast(`Text size: ${TEXT_SIZES[next]}`);
  };
  $('doneBtn').onclick = () => {
    store.setUI({ hideDone: !store.state.ui.hideDone });
    $('doneBtn').textContent = store.state.ui.hideDone ? 'Show done' : 'Hide done';
  };

  $('shareTrip').onclick = shareTrip;
  $('copyTrip').onclick = copyTrip;
  $('dlTrip').onclick = downloadTrip;

  $('menuTrip').onclick = () => { closeSheet('menuSheet'); openTrip(); };
  $('menuName').onclick = () => { closeSheet('menuSheet'); $('nameInput').value = store.state.me.name; openSheet('nameSheet'); };
  $('menuClear').onclick = () => {
    if (!confirm('Start a new trip?\n\nThis clears EVERYONE\u2019s ticks, and sets the new trip to whatever was bought on this one. You can change it under “Choose what to buy”.')) return;
    // Order matters: the statuses are the only record of what this trip
    // contained, so the plan must be captured before they are cleared.
    const n = store.replanFromLastTrip();
    store.clearAllMarks();
    closeSheet('menuSheet');
    sync?.drain();
    toast(n ? `New trip — ${n} item${n === 1 ? '' : 's'} carried over` : 'Ready for a new trip');
  };
  $('menuClearPlan').onclick = () => {
    if (!confirm('Put every item back on the trip for everyone?')) return;
    store.clearPlan(); closeSheet('menuSheet'); sync?.drain(); toast('Everything is back on the list');
  };
  $('menuForget').onclick = () => {
    if (!confirm('Forget this device only? The shared list is untouched.')) return;
    store.reset();
    try { [PASS_KEY, SALT_KEY, CHECK_KEY].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
    location.reload();
  };

  // The phone keyboard's Go/Done key must submit. Inputs outside a <form> with
  // no keydown handler leave it inert, and a user who presses it and sees
  // nothing happen concludes the app is frozen.
  const onEnter = (inputId, buttonId) => {
    const el = $(inputId);
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      $(buttonId).click();
    });
  };
  onEnter('nameInput', 'saveName');
  onEnter('addName', 'saveAdd');
  onEnter('addNote', 'saveAdd');

  $('saveName').onclick = () => {
    const n = $('nameInput').value.trim().slice(0, 24);
    if (!n) { toast('A first name is plenty'); return; }
    store.setName(n); closeSheet('nameSheet');
  };

  // A tick made as the phone goes into a pocket must not die with the tab.
  // Android fires this when the app is installable. Capturing it lets us offer a
  // real one-tap install instead of instructions nobody reads.
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    maybeOfferInstall();
  });
  addEventListener('appinstalled', () => {
    installPrompt = null;
    dismissInstallBar();
    toast('Added to your home screen');
  });

  addEventListener('pagehide', () => store.flushPersist());
  // iOS home-screen PWAs restore through pageshow; visibilitychange is documented
  // as not firing on app-switcher resume in several versions. Without this a
  // render discarded while hidden is never re-issued and the user comes back to
  // a stale list, with the stream possibly suspended behind a "Live" badge.
  addEventListener('pageshow', () => { render(); sync?.drain(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Into a pocket. Flush to disk AND push: `keepalive` on the PATCH exists
      // for exactly this moment. Otherwise a note typed at the freezer sits
      // unsent until the phone is next unlocked.
      store.flushPersist();
      sync?.drain();
      return;
    }
    // Coming back from another app: repaint unconditionally. Anything that
    // arrived while we were hidden has already merged into the store, and a
    // frame was never served to show it.
    render();
    sync?.drain();
  });
}

/**
 * The scale is applied to the ROOT element. Everything in the sheet is sized in
 * `rem`, which resolves against `html` and ignores `body` entirely - see the
 * comment on the `html` rule in index.html.
 */
function applyTextSize() {
  const n = store.state.ui.text;
  document.documentElement.classList.toggle('t1', n === 1);
  document.documentElement.classList.toggle('t2', n === 2);
  $('btnBig').classList.toggle('set', n > 0);
  $('btnBig').title = `Text size: ${TEXT_SIZES[n]}`;
  $('btnBig').setAttribute('aria-label', `Text size, currently ${TEXT_SIZES[n]}. Tap to change.`);
}

async function boot() {
  View.configure({ catalogue: LIST_ID === DEFAULT_LIST });
  rememberList(LIST_ID);
  applyTextSize();
  $('doneBtn').textContent = store.state.ui.hideDone ? 'Show done' : 'Hide done';
  wireEvents();
  store.subscribe((d) => {
    setSyncBadge(lastStatus, lastDetail);
    // 'sync' means an ack landed: the only thing on screen that changed is the
    // badge, already handled above. Repainting here doubled the repaint count
    // for the whole trip, landing right as the thumb starts the next scroll.
    if (d && d.type === 'sync') return;
    render();
  });
  render();

  // A page served over https can only reach an https database; anything else is
  // blocked as mixed content and the app would sit on "Retrying" forever with no
  // explanation. `config.js.mock` points at 127.0.0.1 and is the likely way that
  // happens, so check the shape rather than one placeholder string.
  const badUrl = !CONFIG.dbUrl
    || CONFIG.dbUrl.includes('YOUR-')
    || (location.protocol === 'https:' && !/^https:\/\//i.test(CONFIG.dbUrl));
  if (badUrl) {
    setSyncBadge(Status.ERROR, { reason: 'rules' });
    $('syncBadge').textContent = 'Not set up';
    toast('config.js needs a valid https database URL');
    ensureName();
    return;
  }

  // A transport instance used only for the meta read during unlock; the real
  // one is built once a codec exists.
  const probe = createSync({
    dbUrl: CONFIG.dbUrl, listId: LIST_ID, codec: plainCodec,
    onRemote: () => {}, onStatus: () => {},
  });

  // Before the gate, not after it. `unlock` is what opens the passphrase sheet
  // and it does not resolve until the passphrase is in, so anything awaited on
  // the far side of it arrives long after the moment it was meant to explain.
  // The welcome sheet is last in the document, so it stacks above the gate
  // whichever opened first; dismissing it reveals the gate underneath.
  maybeWelcome();

  let codec;
  try {
    codec = await unlock(probe);
  } catch (e) {
    // Only the WebCrypto case has already painted an explanation. Every other
    // failure used to return here silently: the catalogue rendered, taps
    // worked, the badge kept its placeholder glyph, and every tick for the rest
    // of the day reached nobody. A remotely-writable `meta.salt` of the wrong
    // type was enough to trigger it on all four phones at once.
    if (e && e.message === 'no webcrypto') return;
    lastStatus = Status.ERROR;
    setSyncBadge(Status.ERROR, {});
    $('syncBadge').textContent = 'Not syncing';
    toast('Could not open the shared list — taps are saved on this phone only');
    retryBootWhenOnline();
    ensureName();
    return;
  }
  if (!codec) {
    // Offline with nothing verifiable yet. The comment used to promise
    // local-only "until we reconnect" while nothing ever reconnected.
    setSyncBadge(Status.OFFLINE);
    retryBootWhenOnline();
    ensureName();
    return;
  }

  sync = createSync({
    dbUrl: CONFIG.dbUrl,
    listId: LIST_ID,
    codec,
    onRemote: (remote, meta) => {
      const { clobbered } = store.mergeRemote(remote);
      // One of OUR queued writes just lost to a newer one from another phone.
      // Saying nothing means a tick disappears in front of the person who made
      // it, with no explanation, which is the failure they cannot diagnose.
      if (meta && meta.first) pendingRestamp = true;
      if (clobbered.length) {
        toast(clobbered.length === 1
          ? 'One of your ticks was changed on another phone'
          : `${clobbered.length} of your ticks were changed on another phone`);
      }
    },
    onBeforeDrain: () => {
      // Queued offline work is re-stamped here, after the reconnect snapshot has
      // been merged and before it goes out, so it is ordered after anything that
      // happened during the outage. Doing it inside onRemote re-stamped the
      // REMOTE record that had already won, which rescued nothing and produced
      // false "your tick was changed" toasts.
      if (pendingRestamp) { pendingRestamp = false; store.restampPending(); }
    },
    onStatus: (s, d) => { lastStatus = s; lastDetail = d; setSyncBadge(s, d); },
    onEmptySnapshot: () => {
      // The shared list holds nothing but this device does. That is data loss,
      // not a fresh start, so put our copy back. Harmless on a genuinely new
      // list: we would simply be the first writer.
      const n = store.requeueAll();
      if (n) { toast(`Restoring ${n} from this phone`); sync?.drain(); }
    },
  });
  sync.bindOutbox(store.pendingOps, store.ackOps);
  sync.start();
  bootRetryArmed = false;

  ensureName();
  maybeOfferInstall();
}

let planning = false;
let pendingRestamp = false;
let bootRetryArmed = false;
function retryBootWhenOnline() {
  if (bootRetryArmed) return;
  bootRetryArmed = true;
  addEventListener('online', () => { if (!sync) boot(); }, { once: true });
}

let lastStatus = Status.CONNECTING;
let lastDetail = null;

boot();

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));

  /**
   * Reload once when a new service worker takes over.
   *
   * Module URLs are unversioned, so on the first load after a deploy the
   * browser's own HTTP cache can hand back yesterday's `store.js` alongside
   * today's `main.js` — a combination that was never tested. Observed in
   * testing: the new main.js wrote namespaced keys while the cached store.js
   * wrote the old ones, into the same page.
   *
   * The new worker precaches with `cache: 'reload'`, so by the time it controls
   * the page a coherent set is available. One reload swaps the whole graph at
   * once. Guarded so a worker update can never put the page in a reload loop.
   */
  let swReloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloaded) return;
    swReloaded = true;
    location.reload();
  });
}
