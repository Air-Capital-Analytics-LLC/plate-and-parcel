/**
 * store.js — local-first state with a last-writer-wins merge.
 *
 * Every shared record carries a hybrid logical clock (`t`) and the writing
 * client's id (`c`). Merge takes the higher `t`; ties break on `c` compared as
 * a string. That makes merge commutative, associative and idempotent, so peers
 * converge no matter what order updates arrive in and re-delivering a record is
 * always safe. No transactions, no locks, no coordinator.
 *
 * Records arriving from the database are UNTRUSTED. The node is world-writable
 * by design, so everything crossing `mergeRemote` is shape-checked first. One
 * malformed row used to poison localStorage and blank the app on every
 * subsequent paint, recoverable only by wiping the device.
 */

/**
 * Storage is namespaced per list from day one.
 *
 * Only one list exists today, but several families will each want their own,
 * and a device may hold more than one. Scoping the key now costs nothing;
 * retrofitting it later would mean migrating live state off a phone belonging
 * to someone who does not know what a migration is.
 */
const LS_PREFIX = 'pnp.v1';
const lsKey = (ns) => `${LS_PREFIX}:${ns}`;

export const STATUSES = ['got', 'swap', 'skip'];

/**
 * Text size steps. The names are shown to the user, so they are words rather
 * than numbers — "Largest" means something to somebody who needs it; "2" does
 * not. The scale itself lives in CSS on `html`, not here.
 */
export const TEXT_SIZES = ['Normal', 'Large', 'Largest'];

/**
 * The four synced collections.
 *
 * Each is an independent last-writer-wins register, and that separation is the
 * whole point: merge resolves per RECORD, so if "planned for this trip" or
 * "this store never stocks it" lived on the item record alongside the tick,
 * clearing a tick would silently clobber a flag another shopper had just set.
 */
export const KINDS = ['items', 'added', 'plan', 'flags', 'qty'];

/** A `t` further ahead than this is not a clock, it is a poisoning attempt. */
const MAX_SKEW_MS = 24 * 60 * 60 * 1000;

/** How many of a thing. 1 is the default and is never stored, so the feature
 *  costs nothing for a household that ignores it. */
export const MIN_QTY = 1;
export const MAX_QTY = 99;

/** Deleted ad-hoc items are hard-collected after this long. See `prune`. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* ---------- pure merge ---------- */

/** @returns {boolean} true when `incoming` should replace `current`. */
export function wins(incoming, current) {
  if (!current) return true;
  if (!incoming) return false;
  const ti = incoming.t || 0;
  const tc = current.t || 0;
  if (ti !== tc) return ti > tc;
  return String(incoming.c || '') > String(current.c || '');
}

const isStr = (v) => v === undefined || v === null || typeof v === 'string';

/**
 * Shape gate for anything crossing the wire.
 *
 * Rejects rather than repairs: a record we cannot trust is one we drop, and
 * the peer that wrote it still holds the truth. `s` is checked against the
 * STATUSES whitelist because it is interpolated into a class attribute, and a
 * string that escapes that attribute executes on every device that merges it.
 */
export function isWellFormed(rec, kind) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (typeof rec.t !== 'number' || !Number.isFinite(rec.t) || rec.t < 0) return false;
  // NOTE: no wall-clock skew test here, deliberately. Judging a record by the
  // RECEIVING device's clock means a phone running three days slow rejects
  // every record its correctly-set family writes — silently, badge reading
  // Live — and, applied on the load() path, throws away its OWN persisted list
  // the next time the clock moves backwards. The poisoning risk lives in the
  // logical clock, not in the record, so the clamp belongs in observeClock.
  if (!isStr(rec.c)) return false;
  // A client id is an opaque local token. Bounding it stops an insider picking
  // a high-sorting value and winning every LWW tie forever.
  if (rec.c !== undefined && rec.c !== null && !/^[A-Za-z0-9_-]{1,24}$/.test(rec.c)) return false;
  if (kind === 'items') {
    if (!(rec.s === null || rec.s === undefined || STATUSES.includes(rec.s))) return false;
    if (!isStr(rec.n) || !isStr(rec.by)) return false;
  } else if (kind === 'plan') {
    if (typeof rec.p !== 'boolean') return false;
  } else if (kind === 'flags') {
    if (typeof rec.f !== 'boolean') return false;
    if (!isStr(rec.by)) return false;
  } else if (kind === 'qty') {
    if (typeof rec.q !== 'number' || !Number.isInteger(rec.q)) return false;
    if (rec.q < MIN_QTY || rec.q > MAX_QTY) return false;
  } else {
    if (typeof rec.name !== 'string') return false;
    if (!isStr(rec.note) || !isStr(rec.store) || !isStr(rec.by)) return false;
    if (rec.del !== undefined && typeof rec.del !== 'boolean') return false;
  }
  return true;
}

/* ---------- store ---------- */

export function createStore({ ns = 'household' } = {}) {
  const LS_KEY = lsKey(ns);
  const listeners = new Set();
  let clock = 0;
  let persistBroken = false;

  const state = {
    items: Object.create(null),   // itemId -> {s, n, by, t, c}  (s null = cleared)
    added: Object.create(null),   // addedId -> {name, note, store, by, del, t, c}
    plan:  Object.create(null),   // itemId -> {p, t, c}        on this trip?
    qty:   Object.create(null),   // itemId -> {q, t, c}        how many (1 = unset)
    flags: Object.create(null),   // "<itemId>@<store>" -> {f, by, t, c}  not stocked here
    outbox: Object.create(null),  // id -> kind                 durable dirty set
    ui: { store: 'sams', hideDone: false, text: 0 },
    me: { id: '', name: '' },
  };

  /* ---- persistence ---- */

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch { /* private mode */ }
    if (raw) {
      try {
        const o = JSON.parse(raw);
        // Locally persisted records went through the same gate on the way in,
        // but a previous version's data (or a hand-edited store) has not.
        for (const [id, rec] of Object.entries(o.items || {})) {
          if (isWellFormed(rec, 'items')) state.items[id] = rec;
        }
        for (const [id, rec] of Object.entries(o.added || {})) {
          if (isWellFormed(rec, 'added')) state.added[id] = rec;
        }
        for (const [id, rec] of Object.entries(o.plan || {})) {
          if (isWellFormed(rec, 'plan')) state.plan[id] = rec;
        }
        for (const [id, rec] of Object.entries(o.qty || {})) {
          if (isWellFormed(rec, 'qty')) state.qty[id] = rec;
        }
        for (const [id, rec] of Object.entries(o.flags || {})) {
          if (isWellFormed(rec, 'flags')) state.flags[id] = rec;
        }
        Object.assign(state.outbox, o.outbox || {});
        Object.assign(state.ui, o.ui || {});
        // A corrupt ui.store used to reach buildGroups and throw on every paint.
        if (!['sams', 'costco', 'custom'].includes(state.ui.store)) state.ui.store = 'sams';
        state.ui.hideDone = !!state.ui.hideDone;
        // Up to v7 this was a boolean `big`. It never actually worked — the
        // scale was applied to `body`, while every rule in the sheet sizes in
        // `rem`, which resolves against `html` — but it persisted, so a device
        // can arrive holding `big:true` set by somebody who wanted bigger text
        // and never got it. Honour that as one step up rather than dropping it
        // on the floor, then retire the field.
        if (typeof state.ui.text !== 'number') state.ui.text = state.ui.big ? 1 : 0;
        delete state.ui.big;
        const t = Math.round(state.ui.text);
        state.ui.text = Number.isFinite(t) ? Math.min(TEXT_SIZES.length - 1, Math.max(0, t)) : 0;
        Object.assign(state.me, o.me || {});
      } catch { /* corrupt: start clean rather than crash */ }
    }
    if (!state.me.id) state.me.id = 'c' + Math.random().toString(36).slice(2, 10);
    if (typeof state.me.name !== 'string') state.me.name = '';
    prune();
    for (const k of KINDS) for (const r of Object.values(state[k])) observeClock(r.t || 0);
  }

  /**
   * Hard-collect ad-hoc items deleted long ago, and outbox entries pointing at
   * records that no longer exist.
   *
   * DELIBERATE TRADE: hard-deleting from an LWW set can resurrect a row if a
   * peer has been offline since before the deletion. With four phones and a
   * 30-day threshold that is effectively impossible, and the failure is
   * cosmetic — one stale row, deleted again. Taken knowingly because `added`
   * is the only unbounded thing in the system, and list import can create
   * dozens of rows at a time.
   */
  function prune() {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    for (const id of Object.keys(state.added)) {
      const r = state.added[id];
      // A `cat` tombstone is not a dead ad-hoc item - it is the only thing
      // holding a catalogue row off this list. Hard-collecting it after 30 days
      // would make every row somebody removed quietly reappear, a month later,
      // with nothing to explain it. These are bounded by the catalogue's size,
      // so they can be kept forever.
      if (r && r.del && !r.cat && (r.t || 0) < cutoff) {
        delete state.added[id];
        delete state.outbox[id];
      }
    }
    for (const id of Object.keys(state.outbox)) {
      const map = state[state.outbox[id]];
      if (!map || !map[id]) delete state.outbox[id];
    }
  }

  function snapshot() {
    return JSON.stringify({
      items: state.items, added: state.added, plan: state.plan,
      flags: state.flags, qty: state.qty,
      outbox: state.outbox, ui: state.ui, me: state.me,
    });
  }

  function writeThrough() {
    try {
      localStorage.setItem(LS_KEY, snapshot());
      if (persistBroken) { persistBroken = false; emit({ type: 'persist' }); }
      return true;
    } catch {
      // The menu promises taps are saved and sent later. Under a quota error or
      // iOS storage eviction that promise is false, and silence would make the
      // app lie to the user. Surface it.
      if (!persistBroken) { persistBroken = true; emit({ type: 'persist' }); }
      return false;
    }
  }

  let persistTimer = null;
  function persist() {
    // Coalesced: a burst of ticks costs one write, and the store stays
    // responsive on the slow flash in an older phone.
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; writeThrough(); }, 120);
  }

  function flushPersist() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    writeThrough();
  }

  function isPersistBroken() { return persistBroken; }

  /* ---- observer ---- */

  function emit(detail) { for (const fn of listeners) fn(detail); }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* ---- clock ---- */

  function tick() { clock = Math.max(Date.now(), clock + 1); return clock; }

  /**
   * `clock` only ever rises, and it is rebuilt from persisted records on every
   * load, so a single implausible `t` would pin every device's clock to the
   * year 33658 permanently. Past that point `Date.now()` never exceeds it,
   * `tick()` degenerates to a bare counter incremented independently on each
   * device, ties become routine, and the device whose random client id sorts
   * lowest silently loses every contested write forever.
   */
  function observeClock(t) {
    if (typeof t !== 'number' || !Number.isFinite(t)) return;
    if (t > Date.now() + MAX_SKEW_MS) return;
    if (t > clock) clock = t;
  }

  /* ---- local writes ---- */

  function stamp(rec) { return { ...rec, t: tick(), c: state.me.id }; }

  function setStatus(itemId, status, note) {
    const prev = state.items[itemId];
    const rec = stamp({
      s: status || null,
      n: status ? String(note ?? prev?.n ?? '') : '',
      by: status ? state.me.name : '',
    });
    state.items[itemId] = rec;
    state.outbox[itemId] = 'items';
    persist();
    emit({ type: 'item', id: itemId });
    return rec;
  }

  function addItem({ name, note, store }) {
    const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.added[id] = stamp({
      name: String(name), note: String(note || ''), store: String(store),
      del: false, by: state.me.name,
    });
    state.outbox[id] = 'added';
    persist();
    emit({ type: 'added' });
    return id;
  }

  /**
   * Change an added item in place, keeping its id.
   *
   * Keeping the id is the whole point: the quantity, the tick, the plan entry
   * and any not-stocked flag are all keyed to it. Delete-and-re-add would look
   * the same on screen and silently drop every one of them, and on another
   * phone it would read as one item vanishing and an unrelated one appearing.
   * A restamp is an ordinary edit that merges the same way any other does.
   */
  /**
   * Create or update this list's own version of an item.
   *
   * The id decides what the record MEANS, and that is the whole design:
   *
   *   'a1b2c3...'                 something somebody added. Nothing else has
   *                               that id, so the record is the item.
   *   'protein--chicken-thighs'   a CATALOGUE id. The catalogue row still
   *                               exists and is untouched; this record sits in
   *                               front of it for this list only. Every other
   *                               list, and the source document, are unaffected.
   *
   * No sixth collection: overrides sync, merge and encrypt exactly like any
   * other added item, because that is what they are. And because the id is the
   * catalogue's own id, the tick, the quantity, the plan entry and any
   * not-stocked flag already keyed to that row keep working across the edit.
   *
   * `cat` marks the second kind. It is load-bearing in prune() - see there.
   */
  function upsertAdded(id, patch) {
    const cur = state.added[id];
    const name = String(patch.name ?? cur?.name ?? '').trim();
    if (!name) return false;
    state.added[id] = stamp({
      ...(cur || {}),
      name,
      note: String(patch.note ?? cur?.note ?? ''),
      store: String(patch.store ?? cur?.store ?? 'sams'),
      del: false,
      by: cur?.by || state.me.name,
      ...(patch.cat ? { cat: 1 } : {}),
    });
    state.outbox[id] = 'added';
    persist();
    emit({ type: 'added' });
    return true;
  }

  /** Kept for the old call sites: an edit of something that already exists. */
  function editAdded(id, patch) {
    const cur = state.added[id];
    if (!cur || cur.del) return false;
    return upsertAdded(id, patch);
  }

  /**
   * Put back every catalogue row this list has hidden.
   *
   * Hiding is a tombstone, and a tombstone is invisible - so without this,
   * taking a row off the list would be one-way with nothing on screen to undo
   * it. Renames are left alone: this restores what is SHOWN, not what things
   * are called.
   */
  function restoreHidden() {
    let n = 0;
    for (const id of Object.keys(state.added)) {
      const r = state.added[id];
      if (!r || !r.cat || !r.del) continue;
      state.added[id] = stamp({ ...r, del: false });
      state.outbox[id] = 'added';
      n++;
    }
    if (n) { persist(); emit({ type: 'added' }); }
    return n;
  }

  function hiddenCount() {
    let n = 0;
    for (const r of Object.values(state.added)) if (r && r.cat && r.del) n++;
    return n;
  }

  /**
   * Take an item off this list.
   *
   * For a catalogue row there may be no record yet - hiding it is the first
   * thing this list has ever said about that row - so one is written. The
   * catalogue itself is never touched.
   */
  function removeAdded(id, opts = {}) {
    const cur = state.added[id];
    if (!cur && !opts.cat) return;
    state.added[id] = stamp({
      ...(cur || { name: String(opts.name || ''), note: '', store: String(opts.store || 'sams'), by: state.me.name }),
      del: true,
      ...(opts.cat || cur?.cat ? { cat: 1 } : {}),
    });
    state.outbox[id] = 'added';
    persist();
    emit({ type: 'added' });
  }

  /* ---- re-shop: planning which items are on THIS trip ---- */

  const flagKey = (itemId, storeId) => `${itemId}@${storeId}`;

  /** True once anyone has planned anything. Until then the list shows
   *  everything, so the feature stays invisible to someone who never uses it. */
  function hasPlan() {
    for (const id of Object.keys(state.plan)) if (state.plan[id]?.p) return true;
    return false;
  }

  function isPlanned(itemId) { return !!state.plan[itemId]?.p; }

  function setPlanned(itemId, on) {
    state.plan[itemId] = stamp({ p: !!on });
    state.outbox[itemId] = 'plan';
    persist();
    emit({ type: 'plan', id: itemId });
  }

  function clearPlan() {
    for (const id of Object.keys(state.plan)) {
      if (!state.plan[id]?.p) continue;
      state.plan[id] = stamp({ p: false });
      state.outbox[id] = 'plan';
    }
    persist();
    emit({ type: 'bulk' });
  }

  /* ---- how many ---- */

  function getQty(itemId) {
    const q = state.qty[itemId]?.q;
    return typeof q === 'number' ? q : MIN_QTY;
  }

  /**
   * Clamped, never stored below the default. A quantity is a shared decision
   * like everything else here, so it gets its own record rather than riding on
   * the item: otherwise ticking Got would clobber a number somebody had just
   * changed on the other side of the shop.
   */
  function setQty(itemId, n) {
    const q = Math.max(MIN_QTY, Math.min(MAX_QTY, Math.round(Number(n) || MIN_QTY)));
    if (q === getQty(itemId)) return q;
    state.qty[itemId] = stamp({ q });
    state.outbox[itemId] = 'qty';
    persist();
    emit({ type: 'qty', id: itemId });
    return q;
  }

  function bumpQty(itemId, delta) { return setQty(itemId, getQty(itemId) + delta); }

  /* ---- not stocked here: a correction to the list, not a trip outcome ---- */

  function isFlagged(itemId, storeId) { return !!state.flags[flagKey(itemId, storeId)]?.f; }
  function flagInfo(itemId, storeId) { return state.flags[flagKey(itemId, storeId)] || null; }

  /**
   * Distinct from Skip on purpose. Skip means "not getting it today" and dies
   * with the trip; this means "the list is wrong, this store does not carry it"
   * and survives until someone clears it. The item is never removed — only
   * marked — because a shopper being unable to find something is not proof the
   * store never has it.
   */
  function setFlag(itemId, storeId, on) {
    const k = flagKey(itemId, storeId);
    state.flags[k] = stamp({ f: !!on, by: on ? state.me.name : '' });
    state.outbox[k] = 'flags';
    persist();
    emit({ type: 'flags', id: k });
  }

  function clearAllMarks() {
    for (const id of Object.keys(state.items)) {
      if (!state.items[id] || state.items[id].s == null) continue;
      state.items[id] = stamp({ s: null, n: '', by: '' });
      state.outbox[id] = 'items';
    }
    prune();
    persist();
    emit({ type: 'bulk' });
  }

  /**
   * Start the next trip from what was actually bought on this one.
   *
   * Captures the plan BEFORE clearing, because the statuses are the only record
   * of what the trip contained. Anything engaged with — got, swapped or skipped
   * — carries over: a skip usually means "they were out", which is the clearest
   * possible signal that it is still needed.
   */
  function replanFromLastTrip() {
    const keep = [];
    for (const id of Object.keys(state.items)) {
      if (state.items[id]?.s) keep.push(id);
    }
    for (const id of Object.keys(state.plan)) {
      const want = keep.includes(id);
      if (!!state.plan[id]?.p === want) continue;
      state.plan[id] = stamp({ p: want });
      state.outbox[id] = 'plan';
    }
    for (const id of keep) {
      if (state.plan[id]?.p) continue;
      state.plan[id] = stamp({ p: true });
      state.outbox[id] = 'plan';
    }
    return keep.length;
  }

  /* ---- import ---- */

  /**
   * Turn pasted text into ad-hoc items. Accepts whatever a phone note, a text
   * message or a recipe actually looks like: bullets, numbering, checkboxes,
   * stray blank lines.
   */
  function parseList(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      let line = raw.trim();
      if (!line) continue;
      line = line.replace(/^[-*•–—+>]+\s*/, '');       // bullets
      line = line.replace(/^\[\s*[xX✓]?\s*\]\s*/, '');           // [ ] and [x]
      line = line.replace(/^\d+\s*[.)\]]\s*/, '');                    // 1. 1) 1]
      line = line.replace(/\s+/g, ' ').trim();
      if (!line || line.length > 120) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  }

  function importItems(names, storeId) {
    let n = 0;
    for (const name of names) { addItem({ name, note: '', store: storeId }); n++; }
    return n;
  }

  function setUI(patch) { Object.assign(state.ui, patch); persist(); emit({ type: 'ui' }); }
  function setName(name) { state.me.name = String(name); persist(); emit({ type: 'ui' }); }

  /* ---- remote merge ---- */

  /**
   * @param {{items?:object, added?:object}} remote already-decrypted records
   * @returns {{changed:boolean, clobbered:string[]}} `clobbered` lists ids where
   *   a remote record displaced one of OUR still-pending writes — the caller
   *   tells the user rather than letting their tap vanish in front of them.
   */
  function mergeRemote(remote) {
    let changed = false;
    const clobbered = [];

    for (const kind of KINDS) {
      const incoming = remote[kind];
      if (!incoming) continue;
      const into = state[kind];
      for (const id of Object.keys(incoming)) {
        const rec = incoming[id];
        if (!isWellFormed(rec, kind)) continue;
        observeClock(rec.t);
        const cur = into[id];
        if (!wins(rec, cur)) continue;
        if (cur && cur.c === state.me.id && state.outbox[id]) clobbered.push(id);
        into[id] = rec;
        changed = true;
      }
    }
    if (changed) { persist(); emit({ type: 'remote' }); }
    return { changed, clobbered };
  }

  /* ---- outbox ---- */

  function pendingOps() {
    const ops = [];
    for (const id of Object.keys(state.outbox)) {
      const kind = state.outbox[id];
      const rec = state[kind] && state[kind][id];
      if (rec) ops.push({ id, kind, rec });
    }
    return ops;
  }

  /**
   * Clear only the ops whose record is byte-identical to what was sent. A tick
   * made while the request was in flight leaves a newer record behind, and
   * that one must survive to be sent on the next drain.
   */
  function ackOps(ops) {
    let cleared = 0;
    for (const op of ops) {
      const live = state[op.kind] && state[op.kind][op.id];
      if (live && live.t === op.rec.t && live.c === op.rec.c) {
        delete state.outbox[op.id];
        cleared++;
      }
    }
    if (cleared) { persist(); emit({ type: 'sync' }); }
    return cleared;
  }

  function pendingCount() { return Object.keys(state.outbox).length; }

  /**
   * Re-stamp queued work so it is ordered after everything that happened during
   * the outage. Called once the reconnect snapshot has been observed.
   *
   * Without this, a device whose system clock runs slow loses all of its
   * offline work the instant it reconnects: its ticks carry a lower `t` than
   * writes made by phones that had signal, so they lose the merge and vanish
   * from its own screen with no explanation. The person least able to diagnose
   * that is exactly the person it happens to.
   *
   * TRADE: a device offline for days will now bulldoze newer remote writes for
   * the items it touched. For "did I put this in the trolley", the more recent
   * real-world action should win, and `mergeRemote` reports any of our pending
   * writes that lose so the user is told rather than surprised.
   */
  function restampPending() {
    let n = 0;
    for (const id of Object.keys(state.outbox)) {
      const map = state[state.outbox[id]];
      if (!map || !map[id]) continue;
      map[id] = { ...map[id], t: tick(), c: state.me.id };
      n++;
    }
    if (n) persist();
    return n;
  }

  /**
   * Re-arm the outbox with everything this device knows — INCLUDING tombstones.
   *
   * Acked ops are dropped and never re-sent, so if the shared list is wiped no
   * peer would put it back. Filtering out cleared ticks and deleted items here
   * was a bug: the server would be restored holding only the positive
   * assertions, so a deleted item and an un-ticked row would silently
   * resurrect for anyone who joined fresh afterwards, while the phones that
   * did the restoring showed something different. LWW makes the unconditional
   * version safe — a peer holding newer data keeps it.
   */
  function requeueAll() {
    let n = 0;
    for (const id of Object.keys(state.items)) { if (state.items[id]) { state.outbox[id] = 'items'; n++; } }
    for (const id of Object.keys(state.added)) { if (state.added[id]) { state.outbox[id] = 'added'; n++; } }
    if (n) { persist(); emit({ type: 'sync' }); }
    return n;
  }

  function reset() {
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  }

  load();

  return {
    state, subscribe, emit,
    setStatus, addItem, editAdded, upsertAdded, removeAdded, restoreHidden, hiddenCount, clearAllMarks, setUI, setName,
    hasPlan, isPlanned, setPlanned, clearPlan, replanFromLastTrip,
    getQty, setQty, bumpQty,
    isFlagged, flagInfo, setFlag, parseList, importItems,
    mergeRemote, pendingOps, ackOps, pendingCount, requeueAll, restampPending,
    flushPersist, isPersistBroken, reset, wins, isWellFormed,
  };
}
