/**
 * main.js — composition root. Wires Store, Sync and View together and owns all
 * DOM event handling. Every other module stays free of globals.
 */

import { CONFIG } from '../config.js';
import { createStore, TEXT_SIZES } from './store.js';
import * as Store from './store.js';
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
  if (!out[DEFAULT_LIST]) out[DEFAULT_LIST] = { label: prettify(DEFAULT_LIST), at: 0 };
  return out;
}

function prettify(id) {
  return String(id).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function listLabel(id = LIST_ID) {
  const rec = knownLists()[id];
  return (rec && rec.label) || prettify(id);
}

/**
 * "I am looking at this list." Records the visit AND makes it the one the
 * home-screen icon opens.
 */
function noteVisit(id, label) {
  const reg = knownLists();
  reg[id] = { label: label || reg[id]?.label || prettify(id), at: Date.now() };
  writeLocal(LISTS_KEY, reg);
  writeLocal(LAST_KEY, id);
}

/**
 * Change what THIS PHONE calls a list. Deliberately NOT `noteVisit`.
 *
 * The two were one function, and the difference is a defect waiting on the
 * rename feature: `noteVisit` also writes `pnp.lastList`, which is what the
 * bare URL and the home-screen icon resolve to. Renaming "Beach" from inside
 * the Household list would therefore have quietly re-pointed the parents' icon
 * at Beach, with nothing on screen having said so.
 */
function setListLabel(id, label) {
  const reg = knownLists();
  const name = String(label || '').trim().slice(0, 40);
  reg[id] = { ...(reg[id] || {}), label: name || prettify(id), at: reg[id]?.at || 0 };
  writeLocal(LISTS_KEY, reg);
}

/** Has this phone given the list a name of its own, or is it still the one
 *  derived from the link? Drives whether the row needs to show the link. */
function isRenamed(id) {
  const rec = knownLists()[id];
  return !!(rec && rec.label && rec.label !== prettify(id));
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
  // Resolved once: this runs on every paint, and the fallback needs the same
  // list the lookup used or a switched-off shop could name a different one.
  const shops = View.shopsFor(s);
  // Reset BEFORE anything is computed from `ui.store`. Doing it lower down
  // painted one frame of the new store's rows under the old store's progress
  // count. `shopsFor` never returns empty, so `shops[0]` cannot throw and this
  // cannot loop — the id it sets is by construction one of the ones it tested.
  if (!shops.some((x) => x.id === s.ui.store)) store.setUI({ store: shops[0].id });
  const storeLabel = (shops.find((x) => x.id === s.ui.store) || shops[0]).label;
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
  // ITS OWN ROW, not appended to `pright`. At the Largest text setting that
  // line is already near the width of a 320px phone, and a total that wraps
  // into the progress count is unreadable by exactly the people the setting
  // exists for. Hidden entirely while planning - "Choose what to buy" is about
  // what is on the trip, and a cost for a list you are still deciding is noise.
  // The store's own short name, not "here": one fewer convention to learn, and
  // it is already on the tab the reader is looking at. Only when there is more
  // than one shop — on a single-shop list there is nothing to disambiguate.
  const estLine = planning ? '' : View.estimateLine(c, {
    store: shops.length > 1 ? (shops.find((x) => x.id === s.ui.store) || {}).short : '',
  });
  $('pest').textContent = estLine;
  $('pest').hidden = !estLine;
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

function openSheet(id) {
  $(id).classList.add('open');
  // BACK TO THE TOP. `.sheet` scrolls internally, and a sheet reopened after
  // being scrolled presents itself mid-content with its own heading off screen
  // - which reads as the app having lost its place.
  const panel = $(id).querySelector('.sheet');
  if (panel) panel.scrollTop = 0;
}
function closeSheet(id) { $(id).classList.remove('open'); }

/**
 * The app's own "are you sure", in place of `window.confirm` - LEDGER M22.
 *
 * WHY IT EXISTS. An OS dialog is drawn by the system, at the system's text
 * size, and the Text size control cannot reach it. So the six sentences that
 * decide whether somebody clears a shared list were the only text in the app
 * that could not be made bigger - in an app that carries that control because
 * two of its four users need it, and which put it in the header rather than
 * buried in settings for the same reason. v24 made every button scale and
 * these stayed exactly where they were.
 *
 * RESOLVES ON EVERY PATH. Yes gives true; Cancel, the backdrop and Escape all
 * give false. None of them may simply hide the sheet: a sheet that closes while
 * its promise stays pending is the defect the passphrase gate shipped once,
 * where the list looked perfectly healthy and the caller never ran again. That
 * is why the backdrop is handled here as well as by the global handler.
 *
 * The body goes in through `textContent`, never `innerHTML`. Two callers
 * interpolate an item name, and an item name arrives over the wire from a
 * world-writable node, so it is untrusted input (§4).
 *
 * TEXT IN, exactly as `confirm` took it, and the first paragraph becomes the
 * heading. Every one of these messages was already written as a question, a
 * blank line, then the consequences - so the split costs nothing and gives the
 * question the one piece of typography that survives being read at arm's
 * length by someone who has already turned the text up.
 */
let asking = false;
function ask(text, { yes = 'Yes', no = 'Cancel', danger = false } = {}) {
  const cut = String(text).indexOf('\n\n');
  const title = cut > 0 ? String(text).slice(0, cut) : 'Are you sure?';
  const body = cut > 0 ? String(text).slice(cut + 2) : String(text);
  // One question at a time. Without this a second `ask` would open over the
  // first while the first's listeners were still live, and one tap would answer
  // both - including answering a destructive question the user never read.
  if (asking) { toast('One question at a time'); return Promise.resolve(false); }

  // THE LATCH IS SET AFTER EVERY LOOKUP AND EVERY WRITE, not before. Set
  // earlier, a single missing element would throw past the `asking = false` in
  // `finish` and leave the latch stuck true for the life of the page - after
  // which EVERY destructive confirm in the app silently returns false and all
  // of those buttons quietly do nothing. That is §1's worst case reached
  // through a typo. The first verifier pass caught this comment sitting one
  // line ahead of its own code; the two must say the same thing.
  const bg = $('askSheet');
  const yesBtn = $('askYes');
  const noBtn = $('askNo');
  const titleEl = $('askTitle');
  const bodyEl = $('askBody');
  titleEl.textContent = title;
  bodyEl.textContent = body;
  yesBtn.textContent = yes;
  noBtn.textContent = no;
  asking = true;
  // The FILLED button is whichever answer is safe. On a destructive question
  // that is Cancel - so the biggest, brightest target is the one that changes
  // nothing, and the destructive answer is the red-text one the app already
  // uses for "Forget this device". Everywhere else Yes is filled, which is the
  // ordinary sheet convention.
  yesBtn.classList.toggle('danger', !!danger);
  yesBtn.classList.toggle('primary', !danger);
  noBtn.classList.toggle('primary', !!danger);

  openSheet('askSheet');
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      asking = false;
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
      bg.removeEventListener('click', onBg);
      document.removeEventListener('keydown', onKey);
      closeSheet('askSheet');
      resolve(v);
    };
    const onYes = () => finish(true);
    const onNo = () => finish(false);
    const onBg = (e) => { if (e.target === bg) finish(false); };
    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
    bg.addEventListener('click', onBg);
    document.addEventListener('keydown', onKey);
  });
}

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
    `They never have this at ${(View.shopsFor(store.state).find((x) => x.id === storeId) || {}).label || 'this store'}`;

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
/** How many, and what one costs. BOTH OPTIONAL - only the name and the stores
 *  are required, so leaving these alone gives exactly the old behaviour. */
let addQty = 1;
let addByWeight = false;

/** Every shop the new item goes on. `addStore` is the first of these. */
let addShops = new Set(['sams']);
function openAdd() {
  addStore = store.state.ui.store;
  addShops = new Set([addStore]);
  addQty = 1;
  addByWeight = false;
  $('addQtyNum').textContent = '1';
  $('addPrice').value = '';
  $('addByWeight').setAttribute('aria-pressed', 'false');
  $('addPrice').disabled = false;
  $('addName').value = '';
  $('addNote').value = '';
  $('addStore').innerHTML = View.shopsFor(store.state)
    .map((s) => `<button data-addstore="${s.id}" class="${addShops.has(s.id) ? 'on' : ''}">${View.esc(s.short)}</button>`)
    .join('');
  openSheet('addSheet');
  setTimeout(() => $('addName').focus(), 120);
}

/* ================= edit an added item ================= */

let editId = null;
let editStore = 'sams';
/** Every shop the edited item is on. `editStore` is the first of these. */
let editShops = new Set(['sams']);
let editCat = false;
/** Sold by weight, so no per-unit price exists and none may be typed. */
let editByWeight = false;

/**
 * Put the price box and its hint into whatever state `editByWeight` says.
 *
 * ONE FUNCTION, called from both `openEdit` and the toggle, because when they
 * were separate they disagreed - `openEdit` set `disabled` and left the hint
 * from whatever item was open last.
 *
 * DISABLED, NOT CLEARED: turning it off again gives the number back rather than
 * eating what was typed, since somebody may toggle it just to see what it does.
 * `saveEdit` ignores the box while the toggle is on, so a stale value cannot be
 * stored.
 */
function applyByWeight() {
  $('editPrice').disabled = editByWeight;
  $('editPrice').placeholder = editByWeight ? '' : 'e.g. 3.99';
  $('editPriceHint').textContent = editByWeight
    ? 'The till weighs this one, so there is no price to type. It is counted separately, not left out.'
    : 'Adds to the running total for this store.';
}

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
  // EVERY shop this item is on, as a set. `editStore` stays the FIRST one -
  // the record still needs a `store`, and that is what a v31 phone reads.
  // EVERY TAB HOLDING IT, not `findItem`'s first hit - see `shopsHolding`.
  const held = a ? View.shopsOf(a) : View.shopsHolding(store.state, id);
  editShops = new Set(held.length ? held : [row.store]);
  $('editName').value = row.name || '';
  $('editNote').value = (a ? a.note : '') || '';
  // SEEDED FROM THE RECORD, not from the catalogue's `est` string. The roadmap
  // is explicit that a price is never auto-derived: `est` is Sam's-only, so it
  // prices the wrong product on a Costco-only line, and it mixes pack totals
  // with per-lb rates ("$16.72  $2.98/lb", "$5.56/lb") - a parser reading the
  // wrong one of those under-prices the row and nothing looks broken. Suggest,
  // human accepts; and until somebody accepts, this box is empty.
  const p = store.priceOf(id);
  $('editPrice').value = p && !p.w ? (p.v / 100).toFixed(2) : '';
  editByWeight = !!(p && p.w);
  $('editByWeight').setAttribute('aria-pressed', String(editByWeight));
  // THROUGH THE SAME HELPER the toggle uses. This used to set `disabled` here
  // and the hint only in the click handler, so two states were reachable that
  // both lied: a by-weight row opened with a greyed, dead box under a hint
  // saying it feeds the estimate; and toggling it on for one item then opening
  // another left "the till works this one out" beside an empty, editable box.
  // The app was telling the user, in plain words, something false about the
  // item in front of them.
  applyByWeight();
  $('editFromCat').hidden = !editCat;
  $('editDelete').textContent = editCat
    ? '\u232b Take off this list'
    : '\u232b Remove from the list';
  $('editStore').innerHTML = View.shopsFor(store.state)
    .map((s) => `<button data-editstore="${s.id}" class="${editShops.has(s.id) ? 'on' : ''}">${View.esc(s.short)}</button>`)
    .join('');
  $('editWho').textContent = (!editCat && a?.by) ? `Added by ${a.by}.` : '';
  openSheet('editSheet');
}

/**
 * "3.99" / "$3.99" / "3,99" / "3" -> 399 cents. '' -> null (cleared).
 * Anything else -> undefined, which the caller reports rather than guessing.
 *
 * DELIBERATELY STRICT about what it accepts and loud about what it does not.
 * A price that silently becomes something else is the defect this whole feature
 * is most exposed to: §0's ruling is that a wrong total which looks right is
 * worse than no total. "1 2 3" and "3.999" are refused rather than rounded into
 * a number nobody typed.
 */
function parsePrice(raw) {
  const s = String(raw || '').trim().replace(/^\$/, '').replace(',', '.');
  if (!s) return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return undefined;
  const cents = Math.round(Number(s) * 100);
  if (!Number.isFinite(cents) || cents < 0) return undefined;
  // REFUSED HERE, not clamped in the store. The two bounds did not agree: this
  // regex accepts up to $999,999.99 and `setPrice` clamped to MAX_PRICE, so
  // typing 1200.00 for a mattress stored $1,000.00 and said nothing - the row,
  // the sheet and the estimate all read $1,000 while $200 had vanished. Sam's
  // and Costco genuinely sell things over $1,000, and §0's ruling is that a
  // wrong total which looks right is worse than no total. The clamp stays in
  // `setPrice` as the untrusted-input backstop it was always meant to be; this
  // is the path a human watches, and it has to be loud.
  if (cents > Store.MAX_PRICE) return undefined;
  return cents;
}

function saveEdit() {
  const name = $('editName').value.trim();
  if (!name) { toast('Give it a name first'); return; }
  // CHECKED BEFORE ANYTHING IS WRITTEN. `upsertAdded` below is the destructive
  // half of this function; refusing a bad price after it has run would leave
  // the name saved and the price silently dropped.
  const cents = editByWeight ? null : parsePrice($('editPrice').value);
  if (cents === undefined) {
    toast('Write the price like 3.99, up to 1000');
    return;
  }
  // FIRST OF THE SET, and the set travels with it. `store` stays a real single
  // shop because the record still requires one and a v31 phone reads only that.
  const shops = [...editShops];
  editStore = shops.includes(editStore) ? editStore : shops[0];
  // WAS IT ON THIS TAB? Only membership is being asked, so ask `onShop`.
  // `shopsOf` is the list-shaped question and had to be fed a hand-built fake
  // record to answer it - which returned the literal string ["undefined"] when
  // the lookup missed.
  const prev = store.state.added[editId];
  const wasHere = prev
    ? View.onShop(prev, store.state.ui.store)
    : View.findItem(store.state, editId)?.store === store.state.ui.store;
  const moved = wasHere && !editShops.has(store.state.ui.store);
  if (!store.upsertAdded(editId, {
    name, note: $('editNote').value.trim(), store: editStore,
    also: shops.filter((x) => x !== editStore), cat: editCat,
  })) {
    toast('That item is already gone');
    closeSheet('editSheet');
    return;
  }
  // AFTER the row is known to exist, and only when it changed. Its own KIND, so
  // it cannot clobber a `qty` somebody bumped on the other side of the shop -
  // the same argument that gave `qty` its own record.
  // `priceOf` returns null for a cleared price as well as an absent one, so
  // the old `isPriced` + `priceOf` pair re-deriving the same answer is gone.
  const p = store.priceOf(editId);
  const wasWeight = !!(p && p.w);
  const wasCents = p && !p.w ? p.v : null;
  if (editByWeight !== wasWeight || (!editByWeight && cents !== wasCents)) {
    if (editByWeight) store.setPrice(editId, 0, true);
    else store.setPrice(editId, cents, false);
  }
  closeSheet('editSheet');
  // Moving an item to another shop hides it from the tab you are looking at,
  // which reads as the edit having deleted it. Follow it across.
  if (moved && store.state.ui.store !== editStore) store.setUI({ store: editStore });
  toast(moved ? 'Saved \u2014 moved to ' + (View.shopsFor(store.state).find((s) => s.id === editStore) || {}).short : 'Saved');
  sync?.drain();
}

async function deleteEdited() {
  const row = View.findItem(store.state, editId);
  if (!row) { closeSheet('editSheet'); return; }
  const msg = editCat
    // "the reference catalogue" was developer language that survived a rewrite -
    // no parent knows what that is. And "only you typed this one in" was simply
    // false: any of the four can edit any added row, so it misattributed the
    // item and read as a small rebuke besides (\u00a73: never blame the user).
    ? `Take \u201c${row.name}\u201d off this list?\n\nIt stays on your other lists, and on the master list this one was built from. \u201cPut back items that were taken off\u201d in the menu brings it back.`
    : `Remove \u201c${row.name}\u201d from the list?\n\nIt goes for everybody, on every phone, and the menu will NOT bring this one back. Somebody would have to type it in again.`;
  if (!await ask(msg, { yes: editCat ? 'Take it off' : 'Remove it', danger: !editCat })) return;
  store.removeAdded(editId, { cat: editCat, name: row.name, store: editStore });
  closeSheet('editSheet');
  toast(editCat ? 'Taken off this list' : 'Removed');
  sync?.drain();
}

function saveAdd() {
  const name = $('addName').value.trim();
  if (!name) { toast('Give it a name first'); return; }
  // A BAD price is refused; an EMPTY one is not. `parsePrice` returns null for
  // empty (meaning "no price") and undefined only for something malformed, so
  // the Add button is never blocked by a field the person chose not to fill.
  const cents = addByWeight ? null : parsePrice($('addPrice').value);
  if (cents === undefined) { toast('Write the price like 3.99, up to 1000'); return; }
  const shops = [...addShops];
  addStore = shops.includes(addStore) ? addStore : shops[0];
  const newId = store.addItem({
    name, note: $('addNote').value.trim(), store: addStore,
    also: shops.filter((x) => x !== addStore),
  });
  // Written only when they are not the default - same rule the paste path
  // follows, so a quiet add still costs exactly one record.
  if (newId && addQty > 1) store.setQty(newId, addQty);
  if (newId && addByWeight) store.setPrice(newId, 0, true);
  else if (newId && cents !== null) store.setPrice(newId, cents, false);
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
    // The link is shown ONLY when this phone has renamed the list. On an
    // untouched list the row would read "Household" with "household" beneath
    // it - the same word twice, which reads as a fault to somebody who
    // struggles with phones and generates the exact question the line exists
    // to answer. Shown, it is what lets two phones calling the same list
    // different things work out that it IS the same list.
    const renamed = isRenamed(id);
    // The link line is a SIBLING of the row button, not a child of it.
    //
    // Inside the button it could never render underneath: `.listrow` is
    // `display:flex; align-items:center` with no wrap, so a `width:100%` block
    // became a squeezed third item on the same line - a mono fragment mid-row
    // that reads as corruption. Putting `flex-wrap` on the WRAPPER did not help
    // either, because that governs the wrapper's own children, not the button's.
    // Out here the wrapper's `flex-wrap` is the rule that actually applies.
    // LEDGER M3 is the receipt for measuring this rather than asserting it -
    // which this line has now been guilty of twice.
    return `<div class="listrowwrap">`
      + `<button class="wide listrow${here ? ' on' : ''}" data-switch="${View.esc(id)}">`
      + `<span class="lname">${View.esc(reg[id].label || id)}</span>`
      + (here ? '<span class="tag">you are here</span>' : '')
      + (id === DEFAULT_LIST ? '<span class="tag dim">shopping list</span>' : '')
      + `</button>`
      + `<button class="pxl listcog" data-listcog="${View.esc(id)}"`
      + ` aria-label="Settings for ${View.esc(reg[id].label || id)}">Settings</button>`
      + (renamed ? `<span class="linkid">in the link: ${View.esc(id)}</span>` : '')
      + `</div>`;
  }).join('');
}

/* ---- one list's settings: its name here, its stores, and forgetting it ---- */

let editListId = null;
let editListPick = new Set();

/**
 * Stores that currently hold something on this list, and whether what they
 * hold is rescuable.
 *
 * Counts what the TAB ACTUALLY RENDERS, not `added` records. Scanning `added`
 * was blind to the catalogue - which is the whole household list - so turning
 * Sam's off there fired no warning at all and took ~58 rows out of the tabs,
 * the counts and the trip export, behind a warning box built to promise that
 * could not happen.
 *
 * Returns BOTH halves separately, because they are not exclusive and treating
 * them as such defers a silent loss. `shopsFor` gives a tab back to a store
 * holding live `added` records; it cannot do that for catalogue rows. One
 * edited or added row on Sam's is enough to make "rescued" true - and a single
 * boolean then printed only the reassuring sentence and swallowed the fact that
 * 58 catalogue rows were about to vanish. Worse, the loss then lands LATER and
 * unannounced: delete that one added row weeks afterwards, `shopsFor` stops
 * rescuing the store, and the tab and every catalogue row on it disappear from
 * four phones with no connection to anything anybody just did.
 */
function storesHolding() {
  const out = new Map();
  for (const s of Store.SHOP_POOL) {
    const rows = View.buildGroups(store.state, s.id).reduce((n, g) => n + g.items.length, 0);
    if (!rows) continue;
    const added = Object.keys(store.state.added)
      .filter((id) => { const a = store.state.added[id]; return a && !a.del && View.onShop(a, s.id); }).length;
    // What survives being switched off, and what does not.
    out.set(s.id, { rows, added, catalogue: Math.max(0, rows - added) });
  }
  return out;
}

function renderListEditShops() {
  const held = storesHolding();
  // The list's OWN names, not the pool defaults. A list that called its custom
  // store "Bait shop" showed a tab reading Bait shop and a chip reading Other,
  // which is the one rule `shopsFor` states outright: a name somebody typed
  // replaces both forms.
  const named = new Map(View.shopsFor(store.state).map((x) => [x.id, x.short]));
  $('listEditShops').innerHTML = Store.SHOP_POOL.map((sh) => {
    const on = editListPick.has(sh.id);
    return `<button type="button" data-lshop="${View.esc(sh.id)}" class="pxl${on ? ' on' : ''}">`
      + `${View.esc(named.get(sh.id) || sh.short)}</button>`;
  }).join('');

  const n = editListPick.size;
  // One hint, both facts. A bare middle dot on the chip was the first attempt
  // and it is this app's SEPARATOR everywhere else ("12 of 40 handled · 30%"),
  // so on a chip it read as dangling punctuation rather than a badge - and a
  // screen reader says "middle dot" or nothing at all.
  const busy = [...held.keys()].map((id) => named.get(id) || id);
  const count = n === 0
    ? 'Pick at least one store.'
    : n < MAX_SHOPS
      ? `${n} store${n === 1 ? '' : 's'} — one tab each.`
      : `${MAX_SHOPS} stores — that is all that fits across the top.`;
  // "a, b and c", not "a and b and c".
  const list = busy.length > 1
    ? busy.slice(0, -1).join(', ') + ' and ' + busy[busy.length - 1]
    : busy[0];
  $('listEditShopHint').textContent = busy.length
    ? `${count} ${list} ${busy.length === 1 ? 'has' : 'have'} things on ${busy.length === 1 ? 'it' : 'them'} right now.`
    : count;
  $('listEditCustomWrap').hidden = !editListPick.has('custom');

  // Name what turning a store off would actually do, before they tap Save.
  const losing = [...held.keys()].filter((id) => !editListPick.has(id));
  const box = $('listEditOrphan');
  if (!losing.length) { box.hidden = true; box.textContent = ''; return; }
  const parts = losing.map((id) => {
    const label = named.get(id) || id;
    const info = held.get(id);
    const bits = [];
    // BOTH sentences when both apply. "Ticked off" is deliberately not said:
    // `shopsFor` keys the rescue on the record not being deleted, and ticking a
    // row Got leaves the record exactly where it was. The tab goes when the
    // thing is removed or moved, which is what this now promises.
    if (info.added) {
      bits.push(`<b>${View.esc(label)}</b> still has `
        + `${info.added} thing${info.added === 1 ? '' : 's'} you added, so its tab stays `
        + `until ${info.added === 1 ? 'it is' : 'they are'} removed or moved to another store.`);
    }
    if (info.catalogue) {
      bits.push(`${info.added ? 'It also has' : `<b>${View.esc(label)}</b> has`} `
        + `<b>${info.catalogue}</b> thing${info.catalogue === 1 ? '' : 's'} built into the list, `
        + `and ${info.catalogue === 1 ? 'that' : 'those'} <b>disappear from view</b> `
        + `until you turn it back on.`);
    }
    return bits.join(' ');
  });
  box.hidden = false;
  box.innerHTML = parts.join(' ') + ' Nothing is deleted either way, and nothing moves on its own.';
}

function openListEdit(id) {
  // A cached older index.html against this main.js has no settings sheet, and
  // `renderLists` emits the button regardless because `listsBody` is old. Bail
  // rather than throw inside the click handler and do nothing at all. LEDGER V8.
  // FIRST, because "Reopen the app to use this" is actionable and the lock
  // message below is not.
  if (!$('listEditSheet')) { toast('Reopen the app to use this'); return; }
  // Guard the BRANCH THAT NEEDS THE KEY, not the sheet. M21's ruling - a guard
  // on the escape hatch is a trap - applies one door along from where it was
  // written: for another list this sheet only renames it or takes it off this
  // phone, both pure localStorage, neither reading a byte of sealed data. A
  // phone stranded offline on a list it has never unlocked could otherwise
  // reach My lists (correctly open) and then be told "Enter the passphrase
  // first" when it tries to tidy that very list away. There is no passphrase
  // box on that screen. Only the store editor touches sealed content, and it
  // is the `mine` branch below.
  if (id === LIST_ID && blockedWhileLocked()) return;
  editListId = id;
  const reg = knownLists();
  $('listEditName').value = reg[id]?.label || prettify(id);
  $('listEditLink').textContent = id;

  // Stores are synced per list, so they can only be edited for the list this
  // device actually has unlocked — another list's records are not in memory.
  const mine = id === LIST_ID;
  // The block STAYS, with words in it. Hiding it outright meant the sheet for
  // another list was a name box and a red button, with no hint that stores are
  // a thing at all - while the forget button, hidden in the mirror case, gets a
  // full sentence explaining itself. Two opposite conventions in one sheet, and
  // the silent one is §1's "never silently do nothing".
  $('listEditShopsWrap').hidden = false;
  $('listEditShops').hidden = !mine;
  $('listEditShopsOther').hidden = mine;
  $('listEditCustomWrap').hidden = true;
  $('listEditOrphan').hidden = true;
  if (mine) {
    // The CHOICE, not the effective tab list. `shopsFor` adds back stores that
    // still hold items, so seeding from it showed a switched-off store as
    // chosen — and the next Save would have turned it back on, silently
    // reversing a decision the person had just been warned about and made.
    // If the creation-time pick has not landed yet - a dead link means the
    // empty snapshot that applies it never arrived - seed from the PARK, not
    // from the legacy fallback. Otherwise the sheet shows Sam's/Costco/Other
    // ticked for a list somebody chose Target and Aldi for ten minutes ago,
    // and tapping Save writes that lie in and silently discards the choice.
    const parked = readLocal(NEWSHOPS_KEY(id), null);
    editListPick = (!Object.keys(store.state.shops).length && parked && Array.isArray(parked.ids) && parked.ids.length)
      ? new Set(parked.ids.filter((x) => Store.SHOP_IDS.includes(x)))
      : new Set(View.chosenShopIds(store.state));
    const custom = store.state.shops.custom;
    const parkedName = (!custom && parked && parked.customName) ? String(parked.customName) : '';
    $('listEditCustomName').value = (custom && custom.label) || parkedName;
    renderListEditShops();
  }

  // The list you are standing in cannot be taken off this phone from inside
  // itself: it would be re-added by the next paint and read as the app
  // ignoring the tap. The household list is the one the bare link resolves to.
  const forgettable = !mine && id !== DEFAULT_LIST;
  $('listEditForget').hidden = !forgettable;
  $('listEditForgetWhy').textContent = forgettable
    ? 'Nothing is deleted. The list stays where it is and the link still works — open the link again to get it back. The other phones do not notice.'
    : mine
      ? 'You are in this list, so it cannot be taken off this phone from here. Switch to another list first.'
      : 'The shopping list always stays on this phone.';
  $('listEditForgetWhy').hidden = false;

  closeSheet('listsSheet');
  openSheet('listEditSheet');
  setTimeout(() => $('listEditName').focus(), 150);
}

function toggleListShop(id) {
  if (editListPick.has(id)) { editListPick.delete(id); renderListEditShops(); return; }
  if (editListPick.size >= MAX_SHOPS) {
    renderListEditShops();
    $('listEditShopHint').textContent =
      `${MAX_SHOPS} is the most that fits across the top. Turn one off to pick another.`;
    return;
  }
  editListPick.add(id);
  renderListEditShops();
}

function saveListEdit() {
  const id = editListId;
  if (!id) return;
  const mine = id === LIST_ID;
  let touchedShops = false;
  if (mine && !editListPick.size) {
    $('listEditShopHint').textContent = 'Pick at least one store.';
    return;
  }
  setListLabel(id, $('listEditName').value);

  if (mine) {
    // Write every store in the pool, on or off, so turning one OFF is a real
    // record that reaches the other phones rather than an absence they cannot
    // tell from "never chose".
    const customName = $('listEditCustomName').value.trim().slice(0, Store.MAX_SHOP_LABEL);
    for (const s of Store.SHOP_POOL) {
      const on = editListPick.has(s.id);
      const cur = store.state.shops[s.id];
      const label = s.id === 'custom' ? customName : (cur?.label || '');
      if (cur && !!cur.on === on && String(cur.label || '') === label) continue;  // unchanged
      store.setShop(s.id, { on, label });
      touchedShops = true;
    }
    sync?.drain();
  }

  editListId = null;
  closeSheet('listEditSheet');
  render();
  renderLists();
  openSheet('listsSheet');
  // The name is this phone's; the stores are everybody's. One tap can commit
  // both, so the toast has to say which one just reached other people - §1,
  // anything beyond the tapping device says so, in those words.
  toast(touchedShops ? `Saved — the tabs change on everybody's phone` : 'Saved');
}

/** Every per-list key, derived in ONE place. `keyFor` builds these for the
 *  current list only, so forgetting another list needs the same list by id -
 *  and a hand-copied duplicate is how the two drift. */
function perListKeys(id) {
  // `lsKey` comes from store.js, which owns that prefix. Copying the literal
  // here is how the two drift, and the drift is silent.
  return [`pnp.pass:${id}`, `pnp.salt:${id}`, `pnp.check:${id}`,
          `pnp.installed:${id}`, `pnp.newshops:${id}`, Store.lsKey(id)];
}

/** How much work on that list has not reached the other phones yet. Read
 *  straight off the persisted blob, because that list's store is not in
 *  memory - only the one this document is. */
function unsentCountFor(id) {
  try {
    const blob = JSON.parse(localStorage.getItem(Store.lsKey(id)) || '{}');
    const ob = blob && blob.outbox;
    if (!ob || typeof ob !== 'object') return 0;
    const meId = blob.me && blob.me.id;
    // ROWS, and only THIS DEVICE'S OWN - both halves, and the second is the one
    // the ledger has already ruled on twice (M16). After `requeueAll` fires on
    // a list, its outbox is the entire local store including every record the
    // other three phones wrote, which the server already holds and which their
    // peers reject on arrival. Counting those would tell somebody "137 things
    // you did have NOT reached the other phones" about work that is not theirs
    // and is not lost - a number they cannot reconcile with anything on screen,
    // attached to a button that destroys things.
    const rows = new Set();
    for (const k of Object.keys(ob)) {
      const kind = ob[k];
      if (typeof kind !== 'string') continue;
      const rowId = k.startsWith(kind + ':') ? k.slice(kind.length + 1) : k;
      const rec = blob[kind] && blob[kind][rowId];
      if (!rec || (meId && rec.c !== meId)) continue;
      rows.add(rowId);
    }
    return rows.size;
  } catch { return 0; }
}

async function forgetListFromPhone() {
  const id = editListId;
  if (!id || id === LIST_ID || id === DEFAULT_LIST) return;
  const label = knownLists()[id]?.label || prettify(id);

  // `pnp.v1:<id>` is the whole persisted store for that list - AND ITS OUTBOX.
  // Removing it destroys every queued offline write on it: shop a list in a
  // warehouse, drive home, tidy up by forgetting it, and twenty ticks nobody
  // else has ever seen are gone. The old confirm text promised the exact
  // opposite ("the list is untouched", "the other phones do not notice"), which
  // is true only when there is nothing waiting. So count first, and say so.
  const unsent = unsentCountFor(id);
  const one = unsent === 1;
  const warn = unsent
    ? `\n\n${unsent} thing${one ? '' : 's'} you did on this list ${one ? 'has' : 'have'} NOT `
      + `reached the other phones yet. Taking it off now loses ${one ? 'it' : 'them'}. `
      + `Open the list with signal first if you want ${one ? 'it' : 'them'} to go.`
    : '';

  if (!await ask(`Take “${label}” off this phone?${warn}\n\n`
    + 'Only this phone forgets it. Nothing is deleted and nobody else notices.\n\n'
    + 'To get back in you will need the link and the passphrase again. If you have not '
    + 'got the link, tap Cancel and use “Share this list” first.',
  { yes: 'Take it off', danger: true })) return;

  // A REAL removal. Dropping the registry entry alone left the passphrase, the
  // salt, the check and the whole cached list in localStorage - so "off my
  // phone" was not true, and the plaintext passphrase was still sitting there.
  const reg = knownLists();
  delete reg[id];
  writeLocal(LISTS_KEY, reg);
  for (const k of perListKeys(id)) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
  editListId = null;
  closeSheet('listEditSheet');
  renderLists();
  openSheet('listsSheet');
  toast('Off this phone — the list itself is untouched');
}

function openLists() {
  // NOT guarded, deliberately, and this was tried the other way round first.
  //
  // Guarding here strands a phone. Tap a list link in a warehouse with no
  // signal and the locked screen shows NO passphrase box - only "Try again" -
  // so "Enter the passphrase first" is both impossible to act on and not the
  // problem. My lists is the one route back to a list this phone already holds
  // cached and CAN open. Blocking it makes the household list unreachable for
  // the whole session, in exactly the failure mode §0 says to design for.
  //
  // Nothing is lost by leaving it open: every destructive thing behind this
  // sheet - rename, stores, taking a list off this phone - is guarded at
  // `openListEdit`. What remains is sharing a link the person already has, and
  // starting an unrelated list.
  closeSheet('menuSheet');
  renderLists();
  openSheet('listsSheet');
}

/* ---- which shops a new list will use ---- */

/**
 * The choice is made here but CANNOT be written here: a list does not exist on
 * the server until somebody sets its passphrase, and there is no key to encrypt
 * with until then. So it is parked under the new list's id and applied on that
 * list's first unlock. Parked locally and unencrypted, which is fine — it is
 * the names of some shops, on the device of the person who just typed them, and
 * it is deleted the moment it is used.
 */
const NEWSHOPS_KEY = (id) => `pnp.newshops:${id}`;
let newListPick = new Set(Store.LEGACY_SHOPS);

function renderShopPick() {
  $('newListShops').innerHTML = Store.SHOP_POOL.map((s) => {
    const on = newListPick.has(s.id);
    return `<button type="button" data-shoppick="${View.esc(s.id)}" class="pxl${on ? ' on' : ''}">`
      + `${View.esc(s.short)}</button>`;
  }).join('');
  const n = newListPick.size;
  $('newListShopHint').textContent = n === 0
    ? 'Pick at least one store.'
    : n < MAX_SHOPS
      ? `${n} store${n === 1 ? '' : 's'} — one tab each.`
      : `${MAX_SHOPS} stores — that is all that fits across the top.`;
  $('newListCustomWrap').hidden = !newListPick.has('custom');
}

/**
 * A cap on what you can PICK, not a guarantee about the strip.
 *
 * A store that still holds items keeps its tab whether or not it was chosen
 * (see `shopsFor`), so the strip can exceed this — a phone on an older build
 * filing items under the legacy three is the realistic way. That trade is
 * deliberate: reachable beats tidy. What the cap prevents is somebody choosing
 * eight stores on day one with no idea what a tab strip looks like.
 *
 * The tab strip is one row and does not scroll. Measured at 320px: three tabs
 * give each face about eight characters, seven give about two — and at the
 * Largest text setting, which exists for the two people this app is built
 * around, seven gives under two. A warning that lets you do it anyway is an
 * anxiety with no action, issued at the moment somebody has least idea what a
 * tab strip even looks like. (The original wording also leaned on the choice
 * being unrevisitable, which v28's settings sheet made untrue - the cap stands
 * on the measurement alone.)
 *
 * The refusal is spoken, not silent: a chip that does nothing when tapped is
 * §1's "never silently do nothing". The tap lands, and the hint says why.
 */
const MAX_SHOPS = 4;

function toggleShopPick(id) {
  if (newListPick.has(id)) {
    newListPick.delete(id);
    renderShopPick();
    return;
  }
  if (newListPick.size >= MAX_SHOPS) {
    renderShopPick();
    $('newListShopHint').textContent =
      `${MAX_SHOPS} is the most that fits across the top. Turn one off to pick another.`;
    return;
  }
  newListPick.add(id);
  renderShopPick();
}

function openNewList() {
  closeSheet('listsSheet');
  $('newListName').value = '';
  $('newListErr').textContent = '';
  $('newListPreview').textContent = '';
  newListPick = new Set(Store.LEGACY_SHOPS);
  $('newListCustomName').value = '';
  renderShopPick();
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
  if (!newListPick.size) {
    // Both slots: the hint sits up in the stores field and can be off-screen
    // at the Largest text setting, and `newListErr` is the line directly
    // above Create where the other two refusals already speak.
    $('newListShopHint').textContent = 'Pick at least one store.';
    $('newListErr').textContent = 'Pick at least one store.';
    return;
  }
  // Park the shop choice for this list's first unlock to apply. See NEWSHOPS_KEY.
  const customName = $('newListCustomName').value.trim().slice(0, Store.MAX_SHOP_LABEL);
  writeLocal(NEWSHOPS_KEY(id), { ids: [...newListPick], customName });
  // Nothing is created server-side here. A list exists the moment someone opens
  // it and sets a passphrase, which is the same path the household list took.
  noteVisit(id, label);
  location.href = linkFor(id);
}

async function shareThisList() {
  const url = linkFor(LIST_ID);
  if (navigator.share) {
    // `prettify(LIST_ID)`, NOT `listLabel()`. A rename is local to this phone,
    // so sharing the local name texts everybody a name for the list that only
    // this device uses - the app itself spreading a name it did not change.
    // The link's own name is the one every phone agrees on.
    try { await navigator.share({ title: `Plate & Parcel — ${prettify(LIST_ID)}`, url }); return; }
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
/** Every shop a paste will land on. Seeded from the tab you were on. */
let importShops = new Set();

function paintImportShops() {
  $('importStore').innerHTML = View.shopsFor(store.state)
    .map((s) => `<button data-importstore="${s.id}" class="${importShops.has(s.id) ? 'on' : ''}">${View.esc(s.short)}</button>`)
    .join('');
}

/**
 * How many preview rows are drawn before it says "and N more".
 *
 * 60, NOT 8. The box is 34vh with its own scroll, which already shows about
 * six rows at the Largest text setting - so a cap of 8 removed nothing from
 * the first screenful and did exactly one thing: make rows 9 onwards
 * unreachable by scrolling. The box looked scrollable and then stopped.
 *
 * That matters because THERE IS NO UNDO FOR AN IMPORT. "Put back items that
 * were taken off" undoes an Empty and single removals; nothing undoes an add.
 * So this preview IS the acceptance, and truncating it means a 40-line paste
 * gets agreed to on the strength of eight verified rows and a count. §0 also
 * cuts the other way here: the real list renders 58 rows, so drawing 40
 * preview rows is nothing, and avoiding them is the bloat §0 says to reject.
 */
const PREVIEW_ROWS = 60;

function openImport() {
  closeSheet('menuSheet');
  $('importText').value = '';
  importParsed = [];
  // NAMES THE LIST. This sheet covers the banner, so without it the only clue
  // to which list you are pasting into is memory - and somebody got that wrong
  // in front of its author. Says what to do about it, too, rather than just
  // stating a fact (§3, never a dead end).
  $('importWhere').innerHTML = `Adding to <b>${View.esc(listLabel())}</b>.`
    + ' Wrong list? Close this, then <b>Menu → My lists</b>.';
  importShops = new Set([store.state.ui.store]);
  paintImportShops();
  $('importPreview').hidden = true;
  $('importEmpty').textContent = 'Nothing to add yet — paste a list above, one item per line.';
  $('importEmpty').hidden = false;
  $('importRows').innerHTML = '';
  $('importGo').disabled = true;
  openSheet('importSheet');
  setTimeout(() => $('importText').focus(), 150);
}

/**
 * Draw what "Add them" would actually add.
 *
 * THIS IS THE ACCEPTANCE, not a nicety. The parser guesses quantities and
 * prices from text somebody wrote for a human, and §1 says the app may SUGGEST
 * a correction while a human accepts it. Showing the parse is what makes the
 * guess safe to make at all - and it is the whole instruction manual, because
 * somebody who edits the text and watches this change learns the rules without
 * being taught any.
 *
 * Laid out like the real list rows - quantity left, price right - so it is
 * recognisable as a shopping list rather than as output.
 */
function previewImport() {
  const raw = $('importText').value;
  importParsed = store.parseList(raw);
  const n = importParsed.length;
  $('importPreview').hidden = !n;
  $('importEmpty').hidden = !!n;
  $('importGo').disabled = !n;
  if (!n) {
    $('importRows').innerHTML = '';
    // TWO DIFFERENT NOTHINGS. `n` is zero both when the box is empty and when
    // it is FULL of their text and none of it parsed - a pasted paragraph (every
    // line over 120 characters is dropped), or lines that are only bullets.
    // Telling somebody who has just pasted to "paste a list above" is a dead
    // end, and it reads as being told they did it wrong.
    $('importEmpty').textContent = raw.trim()
      ? 'Nothing here looks like a list yet. Try putting each thing on its own line.'
      : 'Nothing to add yet — paste a list above, one item per line.';
    return;
  }

  const shown = importParsed.slice(0, PREVIEW_ROWS);
  // `esc` on every piece: this is the user's own text rather than a record off
  // the wire, but it is still text reaching innerHTML, and the boundary is the
  // boundary (§4).
  let html = shown.map((p) => {
    const q = p.qty > 1 ? `${p.qty} ×` : '';
    // "Weighed at the till", word for word what the Edit sheet's toggle says,
    // so the preview and the editor teach the same phrase. "weighed at till"
    // is not idiomatic in any register and read as a database label.
    const price = p.byWeight
      ? '<span class="pp byw">Weighed at the till</span>'
      : (p.price !== null ? `<span class="pp">$${(p.price / 100).toFixed(2)}</span>` : '');
    return `<div class="pr"><span class="pq">${View.esc(q)}</span>`
      + `<span class="pn">${View.esc(p.name)}</span>${price}</div>`;
  }).join('');
  if (n > PREVIEW_ROWS) {
    // Says the truncation is COSMETIC. "…and 32 more" alone is ambiguous about
    // whether those 32 are being added or dropped, which is the last thing this
    // box should be vague about.
    const more = n - PREVIEW_ROWS;
    html += `<div class="more">…and ${more} more. All ${n} will be added.</div>`;
  }
  $('importRows').innerHTML = html;

  // NAMES THE DESTINATION, in a sentence, above the rows. The import follows
  // whichever tab you were on, and this sheet covers the tabs - so without this
  // a paste can land somewhere the user did not intend, and there is no undo.
  const storeLabel = importStoreLabel();
  // NOT "...on your Sam's and Costco list". Ungrammatical once more than one
  // shop is picked, and it overloads "list" six inches under a warnbox where
  // "list" means the household - on the one sheet added because somebody
  // confused which list they were in.
  $('importHead').textContent = storeLabel
    ? `This is what you will get, on ${storeLabel}:`
    : 'This is what you will get:';
}

/** The shops an import will land on, named as they are on screen. */
function importStoreLabel() {
  const picked = View.shopsFor(store.state).filter((x) => importShops.has(x.id)).map((x) => x.short);
  if (!picked.length) return '';
  if (picked.length === 1) return picked[0];
  // Read aloud - "Sam's and Costco" - rather than joined with commas and left
  // hanging, because this sentence is the last thing before an action with no
  // undo.
  return picked.slice(0, -1).join(', ') + ' and ' + picked[picked.length - 1];
}

function doImport() {
  if (!importParsed.length) return;
  // READ BEFORE THE SHEET CLOSES, and named in the toast. `closeSheet` reveals
  // the tabs only as the toast is already fading, so if the import went to a
  // tab the user did not mean, this sentence is the one chance to notice -
  // there is no undo for an add.
  const where = importStoreLabel();
  const shops = [...importShops];
  const n = store.importItems(importParsed, shops[0], shops.slice(1));
  closeSheet('importSheet');
  toast(where ? `Added ${n} item${n === 1 ? '' : 's'} to ${where}` : `Added ${n} item${n === 1 ? '' : 's'}`);
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
      // CAPTURED BEFORE THE QUESTION, and this is new with the in-app sheet.
      // `confirm()` blocked the thread, so `ui.store` could not move between
      // the tap and the answer. `ask()` does not block: the sheet can sit open
      // while a `shops` record arrives and switches the tab underneath it, and
      // the flag would then be cleared on whichever store the user happens to
      // be looking at when they answer - not the one whose note they tapped.
      // A flag is per item-and-store, so that is the wrong record entirely.
      const storeId = store.state.ui.store;
      ask('Clear the “not stocked here” note?\n\nIt goes for everyone on this list, not just you. The item itself stays exactly where it is.',
        { yes: 'Clear the note' }).then((ok) => {
        if (!ok) return;
        store.setFlag(id, storeId, false);
        sync?.drain();
      });
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
  // MULTI-SELECT, and it cannot be emptied. An item on no shop at all is on no
  // tab at all - unreachable, with the record intact and synced the whole time,
  // which is the failure `shopsFor`'s orphan block exists to prevent. Tapping
  // the last one left is refused and says why rather than doing nothing.
  const toggleShop = (set, id, refresh) => {
    if (set.has(id)) {
      if (set.size === 1) { toast('Tap another store on first, then you can turn this one off'); return; }
      set.delete(id);
    } else {
      set.add(id);
    }
    refresh();
  };
  $('editStore').addEventListener('click', (e) => {
    const b = e.target.closest('[data-editstore]');
    if (!b) return;
    toggleShop(editShops, b.dataset.editstore, () => {
      for (const x of $('editStore').children) x.classList.toggle('on', editShops.has(x.dataset.editstore));
    });
  });
  $('editByWeight').onclick = () => {
    editByWeight = !editByWeight;
    $('editByWeight').setAttribute('aria-pressed', String(editByWeight));
    applyByWeight();
  };
  $('importStore').addEventListener('click', (e) => {
    const b = e.target.closest('[data-importstore]');
    if (!b) return;
    toggleShop(importShops, b.dataset.importstore, () => {
      paintImportShops();
      previewImport();          // the heading names the shops, so it must redraw
    });
  });
  $('addQty').addEventListener('click', (e) => {
    const b = e.target.closest('[data-addqty]');
    if (!b) return;
    addQty = Math.max(1, Math.min(Store.MAX_QTY, addQty + Number(b.dataset.addqty)));
    $('addQtyNum').textContent = String(addQty);
  });
  $('addByWeight').onclick = () => {
    addByWeight = !addByWeight;
    $('addByWeight').setAttribute('aria-pressed', String(addByWeight));
    // Disabled, not cleared - turning it off again gives the number back.
    $('addPrice').disabled = addByWeight;
    $('addPrice').placeholder = addByWeight ? '' : 'e.g. 3.99';
  };
  $('addStore').addEventListener('click', (e) => {
    const b = e.target.closest('[data-addstore]');
    if (!b) return;
    toggleShop(addShops, b.dataset.addstore, () => {
      [...$('addStore').children].forEach((x) => x.classList.toggle('on', addShops.has(x.dataset.addstore)));
    });
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
  // Delegated: the chips are rebuilt on every toggle, so per-button handlers
  // would be re-bound constantly and leak the stale ones.
  // `?.` because this runs on the BOOT path, before the first paint, and the
  // node is new in v27. LEDGER V8 records the graph that makes this fatal and
  // says it was reproduced live: GitHub Pages hands back a cached older
  // index.html alongside the fresh main.js, the lookup is null, `wireEvents`
  // throws, `boot()` rejects unhandled — and the phone shows a header over an
  // empty list with no passphrase box and nothing to tap. `passReveal` two
  // hundred lines up already carries this guard for the same reason.
  $('newListShops')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-shoppick]');
    if (b) toggleShopPick(b.getAttribute('data-shoppick'));
  });
  $('listsNew').onclick = openNewList;
  // Delegated, and optional-chained: `listsBody` is rebuilt on every open, and
  // these ids are new in v28 — a cached older index.html against this file
  // would otherwise throw here, on the boot path, and blank the app. That is
  // LEDGER V8 and it is exactly what the v27 verifier caught.
  $('listsBody')?.addEventListener('click', (e) => {
    // ONE listener for both controls on a row. The settings button is a
    // SIBLING of the switch button, not inside it, so `closest` cannot match
    // both — but checking it first makes that independent of the markup.
    const cog = e.target.closest('[data-listcog]');
    if (cog) { openListEdit(cog.getAttribute('data-listcog')); return; }
    const b = e.target.closest('[data-switch]');
    if (b) switchTo(b.dataset.switch);
  });
  $('listEditShops')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lshop]');
    if (b) toggleListShop(b.getAttribute('data-lshop'));
  });
  const lSave = $('listEditSave'); if (lSave) lSave.onclick = saveListEdit;
  const lForget = $('listEditForget'); if (lForget) lForget.onclick = forgetListFromPhone;
  $('listsShare').onclick = shareThisList;
  $('newListName').addEventListener('input', previewNewList);
  $('newListName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createList(); }
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
  $('menuClear').onclick = async () => {
    if (blockedWhileLocked()) return;
    // NAMES THE LIST, because "EVERYONE's ticks" answers WHO and leaves WHERE
    // wide open - read on 2026-09-20 it does not say whether it reaches your
    // other lists. It does not: the store is `createStore({ns: LIST_ID})` and
    // sync writes under `lists/<listId>`, so every write here is scoped to the
    // list on screen. The second line says the other lists are untouched
    // rather than leaving that to be inferred from silence.
    if (!await ask(`Start a new trip on “${listLabel()}”?\n\nThis clears EVERYONE\u2019s ticks on this list — yours and the other phones’. Your other lists are not touched.\n\nThe new trip starts with whatever was bought, swapped or missing on this one. You can change it under “Choose what to buy”.`, { yes: 'Start a new trip', danger: true })) return;
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
    // TWO DIFFERENT HIDINGS, one button, because to the person tapping it they
    // are one idea: "put back what went". `unemptyList` undoes an Empty (no
    // records were written, so this is one value); `restoreHidden` puts back
    // catalogue rows taken off one at a time. Order does not matter - they
    // touch different things - but the message does, so they are counted
    // separately and reported separately rather than summed into one number
    // that would describe neither.
    const unswept = store.unemptyList();
    const n = store.restoreHidden();
    closeSheet('menuSheet');
    sync?.drain();
    if (unswept && n) toast(`The list is back, and ${n} other item${n === 1 ? '' : 's'} with it`);
    else if (unswept) toast('The list is back');
    else if (n) toast(`Put back ${n} item${n === 1 ? '' : 's'}`);
    else toast('Nothing was taken off this list');
  };
  $('menuEmpty').onclick = async () => {
    if (blockedWhileLocked()) return;
    // COUNTED BY DISTINCT ID, not by rows on screen. A catalogue item whose
    // section says "Both" is listed under Sam's AND Costco, so counting rows
    // said "all 124 items" on a list holding 80 - a wrong number in the one
    // sentence §1 requires a shared destructive action to get right.
    const seen = new Set();
    for (const shop of View.shopsFor(store.state)) {
      for (const sec of View.buildGroups(store.state, shop.id)) {
        for (const it of sec.items) seen.add(it.id);
      }
    }
    const n = seen.size;
    // NOTHING TO EMPTY IS ITS OWN ANSWER. The old guard also asked whether
    // anything was hidden, which is large exactly AFTER an empty - so emptying
    // twice produced a red danger sheet reading "This takes all 0 items off
    // this list", then a toast saying it was already empty. Opening the menu
    // again to check the first one worked is the likely path to it.
    if (!n) {
      closeSheet('menuSheet');
      toast(store.sweptAt()
        ? 'Already empty — “Put back items that were taken off” brings it back'
        : 'This list is already empty');
      return;
    }
    if (!await ask(`Empty “${listLabel()}” for everyone?\n\n`
      + `This takes ${n === 1 ? 'the 1 item' : `all ${n} items`} off this list, on everyone’s phone — not just yours. Your other lists are not touched.\n\n`
      + 'Nothing is deleted, and nothing is lost. “Put back items that were taken off” in this menu brings all of it back.',
    { yes: 'Empty the list', danger: true })) return;
    store.emptyList();
    closeSheet('menuSheet');
    sync?.drain();
    toast(`Emptied — Menu → “Put back items that were taken off” returns all ${n}`);
  };
  $('menuClearPlan').onclick = async () => {
    if (blockedWhileLocked()) return;
    // NOTHING TO UNDO IS ITS OWN ANSWER (§1, never silently do nothing). Until
    // somebody uses "Choose what to buy" there is no shortlist, so this asked a
    // frightening shared-blast-radius question and then changed nothing
    // observable - the whole list was already showing. The row is always
    // visible, so this path is the common one on a list nobody plans on.
    if (!store.hasPlan()) {
      closeSheet('menuSheet');
      toast('The whole list is already showing');
      return;
    }
    if (!await ask(`Show the whole list again on “${listLabel()}”?\n\nThis undoes “Choose what to buy” on everyone’s phone, not just yours. Your other lists are not touched, and nothing is deleted.`, { yes: 'Show everything' })) return;
    store.clearPlan(); closeSheet('menuSheet'); sync?.drain(); toast('The whole list is showing again');
  };
  $('menuForget').onclick = async () => {
    if (!await ask('Forget this list on this phone?\n\n'
      + 'Only this phone forgets it. The shared list itself is untouched, nothing is deleted, and nobody else notices.\n\n'
      + 'To get back in you will need the link and the passphrase again.',
    { yes: 'Forget it', danger: true })) return;
    store.reset();
    // Through `perListKeys`, not a hand-written trio. This function is the one
    // `perListKeys` was written to stop drifting from, and it was drifting
    // already: it left `pnp.installed:<id>` and `pnp.newshops:<id>` behind, so
    // "Forget this device" was LESS thorough than taking a list off the phone.
    // LEDGER V7 records this same function shipping this same shape of defect.
    try { perListKeys(LIST_ID).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
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
  // NOT on the bare-URL screen. The store is module-scoped and namespaced to
  // the resolved list, so a visit with no `?list=` has already loaded, gated
  // and PRUNED the real list's saved data — and `boot()` returns before
  // anything can report what that pruning dropped. Flushing here would write
  // the pruned copy back and erase the only evidence, so the next real boot
  // would report nothing: M16's silent loss, restored, through a side door.
  // Nothing on that screen can change state, so there is nothing to lose by
  // not writing.
  addEventListener('pagehide', () => { maskPass(); if (!NO_LIST) store.flushPersist(); });
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
      if (!NO_LIST) store.flushPersist();   // see the `pagehide` note above
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

/**
 * Tell the person that work of theirs did not survive being read back.
 *
 * Called at the ONE moment the list is genuinely on screen — right after the
 * lock lifts — not on a timer. A boot-relative delay was tried and was wrong:
 * on a locked boot `deriveKey` runs 210,000 PBKDF2 iterations and an
 * unreachable list waits out a 4-second read, so a 900ms timer landed on the
 * passphrase box, over the Unlock button, on exactly the boot where this
 * matters most. And on the dead-network screen it burned the only report of
 * lost work on a screen that shows no list.
 *
 * A BAR, not a toast. `toast()` holds 2100ms, is `pointer-events:none`, wears
 * the same gold as "Saved" and "Link copied", and is a single slot that
 * "Restoring N from this phone" or the clobber notice can overwrite inside
 * that window. This is the only message in the app about work that is gone for
 * good; it waits, it can be re-read, and it goes away when a human says so.
 */
function reportDroppedWork() {
  // ASKED FIRST, and it is a DIFFERENT sentence (LEDGER M19). When the whole
  // persisted blob fails to parse, `load()` discards it and the count below is
  // computed from an outbox that was never read — so it is zero, and the most
  // total loss this app can suffer used to be the one case it said nothing
  // about. A count cannot describe it: nothing was countable. §3 says say what
  // happened and what to do, so it says what actually happened.
  const unreadable = store.takeBlobUnreadable();
  if (unreadable) {
    store.flushPersist();
    const bar = document.createElement('div');
    bar.className = 'warnbox lostbar';
    // TRUE AT THE MOMENT IT PAINTS. The first draft said the list had "started
    // fresh from what the other phones have" - but this runs at the unlock, and
    // `createSync` is constructed BELOW that call, so nothing has been asked of
    // the database yet and the list underneath this bar is empty. In a dead
    // zone it stays empty for the whole trip, so that sentence would have been
    // a false reassurance, read by somebody standing in a shop.
    //
    // No "tap it again" either: that advice belongs to the counted bar below,
    // where the list is intact and a few rows are stale. Here there is nothing
    // to tap, and borrowed advice the screen cannot satisfy is the dead end §3
    // forbids.
    //
    // The loss is stated agentlessly - "the other phones never got it", like
    // the bar below - because nothing here is sent by a person (§3, never blame
    // the user).
    bar.innerHTML = '<span>This phone’s copy of the list was damaged, so it was cleared. '
      + 'Anything you changed here that the other phones never got is gone. '
      + 'The list comes back when you have signal.</span>'
      + '<button class="pxl" id="lostOk">OK</button>';
    listEl.parentNode.insertBefore(bar, listEl);
    $('lostOk').onclick = () => bar.remove();
    // Same reasoning as the counted branch: one bar at a time. This one outranks
    // a convenience nag by more than that one does, and it was the branch that
    // left the nag standing.
    document.querySelector('.installbar')?.remove();
    return;
  }
  // BELOW the return, not above it. Consuming the count on a path that never
  // reports it throws it away; the two cannot both be set today, but that is a
  // property of where `droppedRows` is filled, not of this function.
  const n = store.takeDroppedWork();
  if (!n) return;
  // Make the loss final on disk in the same turn it is announced. `load()`
  // pruned the orphaned entries in memory only, and nothing on a quiet boot
  // persists — so without this the next launch re-reads the same blob, counts
  // the same loss and says it again. In a dead zone, every single reopen.
  store.flushPersist();
  const bar = document.createElement('div');
  bar.className = 'warnbox lostbar';
  bar.innerHTML = `<span>${n === 1
    ? 'One thing you changed did not go through, so the other phones never got it.'
    : `${View.esc(String(n))} things you changed did not go through, so the other phones never got them.`
  } If something on the list looks wrong, tap it again.</span>`
    + '<button class="pxl" id="lostOk">OK</button>';
  listEl.parentNode.insertBefore(bar, listEl);
  $('lostOk').onclick = () => bar.remove();
  // One bar at a time, and this one outranks a convenience nag.
  document.querySelector('.installbar')?.remove();
}

/**
 * Write the shop choice that `createList` parked, on this list's first unlock.
 *
 * Guarded on the list having NO shop records yet, so it can only ever run once
 * and can never overwrite a choice somebody else already made — two people
 * opening the same new link at the same time is a real sequence, and the second
 * one must not reset the first one's shops.
 */
/** Armed at unlock, fired once the server has answered. Before that the guard
 *  inside would be reading an empty local store and could not see a choice or
 *  content that already exists on the list. */
let parkedPending = false;
/** This phone is the one that just made this list, so the import offer is for
 *  it and not for the next person to open the link. */
let justCreated = false;
function runParkedShops() {
  if (!parkedPending) return;
  parkedPending = false;
  // READ BEFORE `applyParkedShops` SPENDS IT. `createList` writes this park on
  // the phone that made the list and nowhere else, so it is already exactly the
  // signal "this phone just created this list" - no second key needed, and it
  // cannot fire for the next person to open the link.
  justCreated = !!readLocal(NEWSHOPS_KEY(LIST_ID), null);
  applyParkedShops();
  offerImportOnNewList();
  sync?.drain();
}

/**
 * Offer to paste a list, ONCE, on a list that has just been made.
 *
 * "Paste a list" lives in the menu, behind a button somebody has to know to
 * look for - so a brand new list opens empty and the fastest way to fill it is
 * the least discoverable thing in the app. Asked for 2026-09-20: offer it at
 * the moment it is obviously useful rather than only referring to it.
 *
 * ONLY ON A LIST WITH NOTHING IN IT, and only while this phone still holds the
 * park from `createList` - so it never appears on the household list, never on
 * a list somebody else has already filled, and never twice. The park is cleared
 * by `applyParkedShops` above, which runs first.
 */
function offerImportOnNewList() {
  if (LIST_ID === DEFAULT_LIST) return;
  if (!justCreated) return;
  justCreated = false;
  if (Object.keys(store.state.added).length || Object.keys(store.state.items).length) return;
  // Guarded on the loss bar's own BUTTON, not on `.lostbar` - the offer used
  // to wear that class itself, so the selector would have started answering
  // yes about the offer.
  if ($('lostOk')) return;                            // real news outranks an offer

  const bar = document.createElement('div');
  // NOT `.lostbar` - that class means "work that is gone for good" and waits
  // for a human instead of timing out. Amber that sometimes means a lost trip
  // and sometimes means "fancy pasting something?" stops meaning anything.
  bar.className = 'warnbox offerbar';
  bar.innerHTML = '<span><b>Nothing on this list yet.</b> If you already have one written'
    + ' somewhere, paste the whole thing in at once &mdash; or later, from'
    + ' <b>Menu → Paste a list</b>.</span>'
    + '<button class="pxl" id="newImportGo">Paste a list</button>'
    // "Later", not "Not now": this bar appears exactly once ever, so "Not now"
    // would promise a return it never makes - and the install bar already uses
    // "Not now" to mean "ask me again".
    + '<button class="pxl" id="newImportNo">Later</button>';
  listEl.parentNode.insertBefore(bar, listEl);
  $('newImportGo').onclick = () => { bar.remove(); openImport(); };
  $('newImportNo').onclick = () => bar.remove();
  document.querySelector('.installbar')?.remove();
}

function applyParkedShops() {
  const parked = readLocal(NEWSHOPS_KEY(LIST_ID), null);
  if (!parked || !Array.isArray(parked.ids) || !parked.ids.length) return;

  // NOT "has anybody chosen" — "has anybody USED this list". The old guard
  // asked the first question and the difference loses work: create a list and
  // pick its stores, send the link BEFORE opening it yourself (which is exactly
  // what `NEW LIST.txt` tells people to do), and somebody else sets the
  // passphrase and adds nine things — filed under the default store, because no
  // choice has arrived. Then you open it, your parked pick applies, and their
  // nine items are behind a store this list no longer uses. Nothing said a word.
  const used = Object.keys(store.state.added).length || Object.keys(store.state.items).length;
  if (Object.keys(store.state.shops).length || used) {
    // Leave the park alone on a list that already has shops — it is spent. But
    // do not silently eat it on a list that merely has content: the creator can
    // still apply it deliberately once the editor exists.
    if (Object.keys(store.state.shops).length) {
      try { localStorage.removeItem(NEWSHOPS_KEY(LIST_ID)); } catch { /* ignore */ }
      return;
    }
    // Skipped because the list was already in use. Say so — §1, never silently
    // do nothing. Without this the creator's choice simply evaporated, and the
    // comment consoling itself that "they can apply it once the editor exists"
    // was describing an editor that does not exist yet.
    toast('This list was already in use, so the stores you picked were not applied.');
    return;
  }

  for (const id of parked.ids) {
    store.setShop(id, {
      on: true,
      label: id === 'custom' ? String(parked.customName || '') : '',
    });
  }
  // Cleared only once the write has actually happened. Removing it above the
  // guard meant a choice could be consumed and discarded with no second chance.
  try { localStorage.removeItem(NEWSHOPS_KEY(LIST_ID)); } catch { /* ignore */ }
  render();
}

async function boot() {
  applyTextSize();
  applyTheme();
  watchSystemTheme();
  showVersion();
  wireEvents();

  if (NO_LIST) {
    // Deliberately before noteVisit: recording this visit would write
    // `pnp.lastList` and quietly turn the bare URL into a working door on the
    // next open, undoing the whole point. repaint() owns the screen from here -
    // it checks NO_LIST first, so later paints cannot overwrite it.
    repaint();
    return;
  }

  View.configure({ catalogue: LIST_ID === DEFAULT_LIST });
  noteVisit(LIST_ID);
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
  if (codec) { locked = false; render(); reportDroppedWork(); parkedPending = true; }
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
      if (meta && meta.first) runParkedShops();
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
      // A brand-new list's first snapshot is the EMPTY one, so this is the path
      // the creator actually takes — hooking the park to `meta.first` alone
      // would mean it never ran for the person who made the choice.
      runParkedShops();
      // "...WHILE HOLDING LOCAL STATE." §4 words the invariant that way and the
      // second half is load-bearing: an empty server plus an empty phone is a
      // new list, not a loss, and treating it as one made every brand-new list
      // re-upload its store settings and announce "Restoring 3 from this phone"
      // on every reconnect through its first hour — in front of the two users
      // least able to read past it.
      //
      // `shops` is deliberately NOT counted as something to restore: a device
      // that holds only configuration is the creator on a list nobody has used
      // yet, which is the case this guard exists to stay quiet about. The test
      // lives here rather than in `sync.js` because only this side knows what
      // the device is holding.
      const holds = ['items', 'added', 'plan', 'qty', 'flags']
        .some((k) => Object.keys(store.state[k] || {}).length);
      if (!holds) return;
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
