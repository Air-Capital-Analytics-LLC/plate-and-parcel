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
const RESOLVED = (() => {
  const q = new URLSearchParams(location.search).get('list');
  if (okId(q)) return q.toLowerCase();                 // an explicit link always wins
  const last = readLocal(LAST_KEY, null);
  if (okId(last)) return String(last).toLowerCase();   // this device has been here before

  // Installed app with no memory. iOS has historically given a standalone PWA
  // its own storage bucket, separate from the Safari tab it was added from, so
  // the icon can launch with `pnp.lastList` empty on a phone that has used this
  // for months. Stranding the owner behind a neutral screen would be a far
  // worse failure than a stranger seeing the default list, so the installed app
  // always opens something.
  if (isStandalone()) return DEFAULT_LIST;

  return null;                                          // a bare link in a browser
})();

/**
 * A bare link, in a browser, on a device that has never opened a list.
 *
 * That is a stranger who was sent the URL, or somebody who found it. It used to
 * land them on the household list's gate, which named the list and confirmed it
 * existed. Now it opens nothing at all.
 *
 * This is obscurity and is filed as such: the list ids are in the public repo
 * for anyone who goes looking. What it buys is that a link pasted into a chat
 * no longer resolves to a working front door for whoever idly taps it, which is
 * the difference between a passer-by and somebody who meant it.
 */
const NO_LIST = RESOLVED === null;

/** Everything downstream still needs a namespace; nothing is opened when
 *  NO_LIST, so which one it is does not matter. */
const LIST_ID = RESOLVED || DEFAULT_LIST;

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

/**
 * Every share link now names its list, the household one included. The bare URL
 * deliberately opens nothing, so a link without `?list=` would hand somebody a
 * neutral screen and no way forward.
 */
function linkFor(id) {
  const base = location.href.split('?')[0].split('#')[0];
  return `${base}?list=${encodeURIComponent(id)}`;
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

/**
 * Nothing about the list is painted until a key exists.
 *
 * `render()` used to run before `unlock()`, so the catalogue - every item name,
 * pack size and price - was on screen behind the passphrase box to anyone who
 * opened the link. The ticks, the added items and the quantities were always
 * encrypted and never showed, but "the passphrase protects this list" was not
 * true of what you could actually see.
 *
 * This is a blind, not a lock: `app/data.js` ships in a public repository and
 * always will, because Pages serves from one. It raises the cost of reading the
 * catalogue from a tap to finding and reading the repo, which is the difference
 * between a passer-by and somebody who meant it.
 */
let locked = !!CONFIG.requirePassphrase;

/**
 * WHY it is locked, which decides what the locked screen offers.
 *
 * 'pass'        the gate is up and waiting - normal.
 * 'unreachable' the list could not be read, so a passphrase cannot be checked
 *               even if it were typed. Offering a box here would be a lie.
 * 'offline'     no signal and this phone has never unlocked this list.
 *
 * Reported as a dead end: locked, no passphrase box, nothing to press. Both
 * failure paths returned early from boot leaving `locked` true and no gate, and
 * the gate is deliberately exempt from backdrop-close, so there was no way out
 * and no explanation.
 */
let lockReason = 'pass';

/** Anything that reads or changes list content refuses while locked. The Trip
 *  summary is built from the catalogue, so the button was a second door into
 *  exactly what the lock exists to hide - reported, and the reason these are
 *  guarded at the function rather than only hidden in the UI. */
function blockedWhileLocked() {
  if (!locked) return false;
  toast('Enter the passphrase first');
  return true;
}

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
  // No list at all outranks everything: there is nothing to lock or show.
  if (NO_LIST) { paintNoList(); return; }
  // Read once: `listLabel()` goes through `knownLists()`, which parses
  // localStorage, and it is now wanted in two places on every paint.
  const label = listLabel();
  if (locked) {
    $('tabs').innerHTML = '';
    $('pfill').style.width = '0%';
    // Named even while locked, and especially while locked: being asked for a
    // passphrase is the moment you most need to know WHICH list is asking.
    $('listName').textContent = label;
    $('pleft').textContent = '';
    $('pright').textContent = 'Locked';
    const body = {
      pass: 'This list is locked.<br><br>Enter the passphrase to see it.',
      unreachable: 'Cannot reach this list right now.<br><br>'
        + 'Without it the passphrase cannot be checked, so there is nothing to type yet. '
        + 'This is usually signal.<br><br>'
        + '<button class="pxl wide primary" id="lockRetry">Try again</button>',
      offline: 'You are offline, and this phone has not opened this list before.<br><br>'
        + 'Connect to something and it will ask for the passphrase.<br><br>'
        + '<button class="pxl wide primary" id="lockRetry">Try again</button>',
    }[lockReason] || 'This list is locked.';
    listEl.innerHTML = '<div class="empty">' + body + '</div>';
    const retry = $('lockRetry');
    if (retry) retry.onclick = () => location.reload();
    $('planBtn').hidden = true;
    // The Trip summary is built from the catalogue. Leaving it reachable while
    // locked made the lock decorative.
    $('btnTrip').hidden = true;
    return;
  }
  $('planBtn').hidden = false;
  $('btnTrip').hidden = false;
  $('tabs').innerHTML = View.tabsHTML(s);
  const c = View.counts(s, s.ui.store);
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  $('pfill').style.width = pct + '%';
  const storeLabel = (View.STORES.find((x) => x.id === s.ui.store) || View.STORES[0]).label;
  // Always name the list, the default one included. The header is a fixed
  // banner, so without this there is nothing on screen saying WHICH list you
  // are looking at - and the whole point of several lists is telling them
  // apart. It has its own row under the banner now; `.pmeta` keeps the store,
  // which is a different question ("which tab am I on") and belongs beside the
  // progress count rather than above it.
  $('listName').textContent = label;
  $('pleft').textContent = storeLabel;
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

/* ================= edit an added item ================= */

let editId = null;
let editStore = 'sams';
let editCat = false;

function openEdit(id) {
  if (blockedWhileLocked()) return;
  // Read the row as SHOWN, not the override record: a catalogue row that this
  // list has never touched has no record at all, and is being edited for the
  // first time right now.
  const row = View.findItem(store.state, id);
  if (!row) { toast('That item is already gone'); return; }
  const a = store.state.added[id];
  editId = id;
  editCat = View.isCatalogueId(id);
  editStore = a?.store || row.store;
  $('editName').value = row.name || '';
  $('editNote').value = (a ? a.note : '') || '';
  $('editFromCat').hidden = !editCat;
  $('editDelete').textContent = editCat
    ? '\u232b Take off this list'
    : '\u232b Remove from the list';
  $('editStore').innerHTML = View.STORES
    .map((s) => `<button data-editstore="${s.id}" class="${editStore === s.id ? 'on' : ''}">${View.esc(s.short)}</button>`)
    .join('');
  $('editWho').textContent = (!editCat && a?.by) ? `Added by ${a.by}.` : '';
  openSheet('editSheet');
}

function saveEdit() {
  const name = $('editName').value.trim();
  if (!name) { toast('Give it a name first'); return; }
  const was = store.state.added[editId]?.store
    ?? View.findItem(store.state, editId)?.store;
  const moved = was !== editStore;
  if (!store.upsertAdded(editId, {
    name, note: $('editNote').value.trim(), store: editStore, cat: editCat,
  })) {
    toast('That item is already gone');
    closeSheet('editSheet');
    return;
  }
  closeSheet('editSheet');
  // Moving an item to another shop hides it from the tab you are looking at,
  // which reads as the edit having deleted it. Follow it across.
  if (moved && store.state.ui.store !== editStore) store.setUI({ store: editStore });
  toast(moved ? 'Saved \u2014 moved to ' + (View.STORES.find((s) => s.id === editStore) || {}).short : 'Saved');
  sync?.drain();
}

function deleteEdited() {
  const row = View.findItem(store.state, editId);
  if (!row) { closeSheet('editSheet'); return; }
  const msg = editCat
    ? `Take \u201c${row.name}\u201d off this list?\n\nIt stays in the reference catalogue and on every other list. `
      + `You can put it back from the menu.`
    : `Remove \u201c${row.name}\u201d from the list?\n\nIt goes for everybody, on every phone.`;
  if (!confirm(msg)) return;
  store.removeAdded(editId, { cat: editCat, name: row.name, store: editStore });
  closeSheet('editSheet');
  toast(editCat ? 'Taken off this list' : 'Removed');
  sync?.drain();
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

/**
 * The running version, read from the service worker's own cache name rather
 * than from a constant kept in step by hand. `sw.js` names its cache
 * `plate-and-parcel-<VERSION>`, so this cannot drift from what is actually
 * installed - which is the whole point of showing it. Silent when there is no
 * cache yet (first load, or a browser that refuses one): an absent version
 * is better than a wrong one.
 */
async function showVersion() {
  const el = $('menuVersion');
  if (!el) return;
  try {
    const keys = await caches.keys();
    const mine = keys.find((k) => k.startsWith('plate-and-parcel-'));
    if (mine) el.textContent = mine.replace('plate-and-parcel-', '');
  } catch { /* no cache API, or storage denied */ }
}

/**
 * The neutral screen. Names no list, confirms no list exists, and offers the
 * welcome sheet - which explains what the app is without revealing anything
 * about whose list it holds.
 */
/**
 * Called from `repaint`, on EVERY paint, not once from boot.
 *
 * It was a one-shot, and `wireEvents` registers a `pageshow` handler that calls
 * `render()` - and `pageshow` fires on every load. So the neutral screen was
 * painted and then immediately overwritten by the locked view, which is how a
 * bare link still showed "Household / Locked". Exactly the M10 mistake again:
 * the decision lived in one layer while another layer reached the same screen.
 */
function paintNoList() {
  // `.listname` belongs in this list, not behind a separate check: the receipt
  // above is precisely about the neutral screen's decision living in one layer
  // while another layer reached the same screen. A bare link names no list.
  for (const sel of ['#tabs', '.pbar', '.pmeta', '.listname', '#planBtn', '#fabAdd', '#doneBtn', '#btnTrip']) {
    const el = document.querySelector(sel);
    if (el) el.hidden = true;
  }
  document.querySelector('.installbar')?.remove();
  $('syncBadge').textContent = '';
  $('syncBadge').hidden = true;
  listEl.innerHTML = '<div class="empty"><b>Open the link you were sent.</b><br><br>'
    + 'A list only opens from its own link, and that link is not this one. '
    + 'Ask whoever invited you to send it again.<br><br>'
    + '<button class="pxl wide primary" id="noListWhat">What is this?</button></div>';
  $('noListWhat').onclick = openWelcome;
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
  if (blockedWhileLocked()) return;
  $('report').value = View.buildReport(store.state);
  openSheet('tripSheet');
}

async function shareTrip() {
  if (blockedWhileLocked()) return;
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
 * Put the passphrase box back to dots, and say so on the button.
 *
 * `type="password"` is not only visual masking — the browser and the OS
 * keyboard treat that field as a different class of thing. While it is `text`
 * the value is eligible for bfcache session-restore (this app restores through
 * `pageshow` on iOS, so it would come back POPULATED AND REVEALED), for the
 * soft keyboard's learned dictionary — and `promptPass` actively recommends a
 * multi-word passphrase, which is exactly what predictive keyboards retain —
 * and for task-switcher thumbnails, which §0 says are captured constantly
 * because the page is always being backgrounded. So revealing is momentary:
 * masked on open, on the way into a pocket, and on restore.
 *
 * Deliberately NOT on a timer. A timer would re-mask mid-typing for a slow
 * typist, and the slow typist is the person this button exists for.
 */
function maskPass() {
  const el = $('passInput');
  if (!el) return;
  // Flip `type` on the live node. Re-rendering the sheet or replacing the input
  // would drop focus and close the Android keyboard mid-passphrase.
  el.type = 'password';
  const btn = $('passReveal');
  if (btn) { btn.textContent = 'Show'; btn.setAttribute('aria-label', 'Show the passphrase'); }
}

function toggleReveal() {
  const el = $('passInput');
  const btn = $('passReveal');
  if (!el || !btn) return;
  if (el.type === 'password') {
    el.type = 'text';
    btn.textContent = 'Hide';
    btn.setAttribute('aria-label', 'Hide the passphrase');
  } else {
    maskPass();
  }
  // Typing continues where it left off; without this the caret jumps to the
  // start on some engines after a type change.
  const n = el.value.length;
  try { el.focus(); el.setSelectionRange(n, n); } catch { /* not all types allow it */ }
}

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

    // Name the list being unlocked. Somebody who keeps two lists needs to know
    // which passphrase is being asked for, and somebody who mistyped a link
    // needs to see that they have landed somewhere they did not mean to.
    const who = listLabel();
    $('passTitle').textContent = isNew ? `Set the passphrase for ${who}` : `Unlock ${who}`;
    $('passHint').textContent = isNew
      ? `Nobody has opened “${who}” before, so you are setting it up. Pick a passphrase of at least ${MIN_PASS} characters — a few words is easiest — and share it with the others. They type it once on their own phone.`
      : `Ask whoever set “${who}” up. You only have to type it once on this device.`;
    $('passInput').value = '';
    // Every open starts masked. `promptPass` re-runs per boot, so without this
    // a second unlock attempt would open with the passphrase already in plain
    // text — in a shop, over somebody's shoulder.
    maskPass();
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
        // The passphrase has done its job. Leaving it in the live DOM for the
        // rest of the session put it one `.open` class away from being back on
        // screen, and the sheet node is never torn down.
        $('passInput').value = '';
        maskPass();
        $('passGo').disabled = false;
        resolve(sealedCodec);
      } catch {
        $('passErr').textContent = 'Could not reach the list. Check your signal and try again.';
        $('passGo').disabled = false;
      }
    };

    $('passGo').onclick = submit;
    // Guarded because this runs inside the promise executor: a missing node
    // would reject `promptPass`, which `boot()` catches into the "unreachable"
    // dead-end screen — a total boot failure dressed up as a signal problem.
    // Reachable in the mixed-version window (new main.js, cached index.html)
    // that is already documented at the bottom of this file as observed.
    const reveal = $('passReveal');
    if (reveal) reveal.onclick = toggleReveal;
    // The phone keyboard's Go key must work. Without this a user types the
    // passphrase, presses Go, nothing happens, and they conclude it is broken.
    $('passInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  });
}

/* ================= name ================= */

function ensureName() {
  // Not while locked. Both the unreachable and offline paths used to land on a
  // dead-end screen and then ask the visitor's name, which reads as a form to
  // fill in when there is nothing behind it.
  if (locked) return;
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
    const rm = e.target.closest('[data-edit]');
    if (rm) { openEdit(rm.dataset.edit); return; }
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

  $('editSave').onclick = saveEdit;
  $('editDelete').onclick = deleteEdited;
  $('editStore').addEventListener('click', (e) => {
    const b = e.target.closest('[data-editstore]');
    if (!b) return;
    editStore = b.dataset.editstore;
    for (const x of $('editStore').children) x.classList.toggle('on', x === b);
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

  $('planBtn').onclick = () => { if (blockedWhileLocked()) return; planning = !planning; render(); scrollTo({ top: 0 }); };
  $('fabAdd').onclick = () => { if (!blockedWhileLocked()) openAdd(); };
  $('importText').addEventListener('input', previewImport);
  $('importGo').onclick = doImport;
  $('menuImport').onclick = () => { if (!blockedWhileLocked()) openImport(); };
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
  $('btnTrip').onclick = openTrip;   // guarded inside
  $('btnMenu').onclick = () => openSheet('menuSheet');
  $('btnBig').onclick = () => {
    const next = (store.state.ui.text + 1) % TEXT_SIZES.length;
    store.setUI({ text: next });
    applyTextSize();
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

  $('menuTrip').onclick = () => { closeSheet('menuSheet'); openTrip(); };   // guarded inside
  $('menuName').onclick = () => { closeSheet('menuSheet'); $('nameInput').value = store.state.me.name; openSheet('nameSheet'); };
  $('menuClear').onclick = () => {
    if (blockedWhileLocked()) return;
    if (!confirm('Start a new trip?\n\nThis clears EVERYONE\u2019s ticks, and sets the new trip to whatever was bought on this one. You can change it under “Choose what to buy”.')) return;
    // Order matters: the statuses are the only record of what this trip
    // contained, so the plan must be captured before they are cleared.
    const n = store.replanFromLastTrip();
    store.clearAllMarks();
    closeSheet('menuSheet');
    sync?.drain();
    toast(n ? `New trip — ${n} item${n === 1 ? '' : 's'} carried over` : 'Ready for a new trip');
  };
  $('menuRestore').onclick = () => {
    if (blockedWhileLocked()) return;
    const n = store.restoreHidden();
    closeSheet('menuSheet');
    sync?.drain();
    toast(n ? `Put back ${n} item${n === 1 ? '' : 's'}` : 'Nothing was taken off this list');
  };
  $('menuClearPlan').onclick = () => {
    if (blockedWhileLocked()) return;
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

  // `pagehide` is the one the iPhone actually fires when the page is
  // backgrounded — `visibilitychange` is documented just below as not firing on
  // app-switcher resume in several iOS versions, and the task-switcher
  // thumbnail is taken on exactly this transition. Masking only on
  // `visibilitychange` left the leak the reveal button's comment claims to
  // close still open on the handsets §0 names.
  addEventListener('pagehide', () => { maskPass(); store.flushPersist(); });
  // iOS home-screen PWAs restore through pageshow; visibilitychange is documented
  // as not firing on app-switcher resume in several versions. Without this a
  // render discarded while hidden is never re-issued and the user comes back to
  // a stale list, with the stream possibly suspended behind a "Live" badge.
  // `maskPass` here is the restore half of the reveal toggle: a page restored
  // from bfcache brings non-password fields back with their values, so a box
  // left revealed would return holding the passphrase in plain text.
  addEventListener('pageshow', () => { maskPass(); render(); sync?.drain(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Into a pocket. Flush to disk AND push: `keepalive` on the PATCH exists
      // for exactly this moment. Otherwise a note typed at the freezer sits
      // unsent until the phone is next unlocked.
      // Mask first: this is the moment the task-switcher thumbnail is taken.
      maskPass();
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
  applyTextSize();
  applyTheme();
  watchSystemTheme();
  showVersion();
  wireEvents();

  if (NO_LIST) {
    // Deliberately before rememberList: recording this visit would write
    // `pnp.lastList` and quietly turn the bare URL into a working door on the
    // next open, undoing the whole point. repaint() owns the screen from here -
    // it checks NO_LIST first, so later paints cannot overwrite it.
    repaint();
    return;
  }

  View.configure({ catalogue: LIST_ID === DEFAULT_LIST });
  rememberList(LIST_ID);
  $('doneBtn').textContent = store.state.ui.hideDone ? 'Show done' : 'Hide done';
  store.subscribe((d) => {
    setSyncBadge(lastStatus, lastDetail);
    // 'sync' means an ack landed: the only thing on screen that changed is the
    // badge, already handled above. Repainting here doubled the repaint count
    // for the whole trip, landing right as the thumb starts the next scroll.
    if (d && d.type === 'sync') return;
    render();
  });

  // Paint once, unconditionally. `paint()` skips a hidden document on purpose -
  // a phone in a pocket should not rebuild the list for every remote patch -
  // but the FIRST paint is what establishes the locked chrome, and it has to
  // happen whether anybody is looking yet or not. Otherwise a tab opened in the
  // background shows the passphrase box over a page still wearing the tab bar
  // and the Plan button it is supposed to be hiding.
  try { repaint(); } catch { /* the next paint carries the fallback */ }

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
    lockReason = 'unreachable';
    render();
    lastStatus = Status.ERROR;
    setSyncBadge(Status.ERROR, {});
    $('syncBadge').textContent = 'Not syncing';
    toast('Could not open the shared list — taps are saved on this phone only');
    retryBootWhenOnline();
    ensureName();
    return;
  }
  // The view is blind until here. Unblind it and paint immediately: nothing
  // else on the boot path is guaranteed to fire, so without this the screen
  // would sit on "Locked" until some unrelated event happened to repaint.
  if (codec) { locked = false; render(); }
  if (!codec) {
    // Offline with nothing verifiable yet. The comment used to promise
    // local-only "until we reconnect" while nothing ever reconnected.
    lockReason = 'offline';
    render();
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
      // "changes", not "ticks". A clobber is now reported accurately per kind,
      // so this fires for a quantity or a plan entry somebody else changed just
      // as often as for a tick — and being told to go and check your ticks when
      // your ticks are fine is worse than being told nothing.
      if (clobbered.length) {
        toast(clobbered.length === 1
          ? 'Someone else changed one of the things you just updated'
          : `Someone else changed ${clobbered.length} of the things you just updated`);
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
