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
/** Exported because `main.js` has to build this key for a list it is NOT
 *  currently in - forgetting one, and counting what it still owes. Hand-copying
 *  the prefix there meant a silent failure the day it moves: the count returns
 *  0 forever and the removal leaves the whole cached list behind while telling
 *  the user it is gone. One owner, no drift. */
export const lsKey = (ns) => `${LS_PREFIX}:${ns}`;

export const STATUSES = ['got', 'swap', 'skip'];

/**
 * Text size steps. The names are shown to the user, so they are words rather
 * than numbers — "Largest" means something to somebody who needs it; "2" does
 * not. The scale itself lives in CSS on `html`, not here.
 */
export const TEXT_SIZES = ['Normal', 'Large', 'Largest'];

/**
 * The synced collections.
 *
 * Each is an independent last-writer-wins register, and that separation is the
 * whole point: merge resolves per RECORD, so if "planned for this trip" or
 * "this store never stocks it" lived on the item record alongside the tick,
 * clearing a tick would silently clobber a flag another shopper had just set.
 *
 * THE ORDER IS THE DRAIN PRIORITY ORDER, and `items` stays first. `drain()`
 * walks this array and STOPS at the first transport failure, so on a flapping
 * link only the first non-empty kind gets attempted per retry. A tick is the
 * write that most needs to survive aisle 7, so it goes first. That is currently
 * true by luck — prepending a kind, or slotting `price` in ahead of `items`,
 * would silently demote every tick on exactly the link where one body per retry
 * is all you get. For the same reason `shops` is LAST: which shops a list uses
 * is configuration, set once, and it must never delay a tick.
 *
 * `ui`, `me` and `outbox` are reserved names in the persisted blob: `load()`
 * and `snapshot()` both iterate this array against that same object.
 */
export const KINDS = ['items', 'added', 'plan', 'flags', 'qty', 'shops'];

/**
 * The shops a list can choose from.
 *
 * Lives HERE, not in `view.js`, because `load()` has to validate `ui.store`
 * against it and `store.js` must never import `view.js` — that is the circular
 * import the rulebook lists under "held under scrutiny". `view.js` imports it
 * the other way, which is the direction that already exists.
 *
 * `short` is the tab face; `label` is the sentence form. A list that renames a
 * shop overrides both with one string, because somebody who types their own
 * name for a shop has already decided how short it should be.
 *
 * ORDER IS TAB ORDER. `custom` stays last: it is the "anywhere else" bucket and
 * it reads as the end of a list, not a peer of the named shops.
 */
export const SHOP_POOL = [
  { id: 'sams', label: "Sam's Club", short: "Sam's" },
  { id: 'costco', label: 'Costco', short: 'Costco' },
  { id: 'target', label: 'Target', short: 'Target' },
  { id: 'walmart', label: 'Walmart', short: 'Walmart' },
  { id: 'aldi', label: 'Aldi', short: 'Aldi' },
  { id: 'dillons', label: 'Dillons', short: 'Dillons' },
  { id: 'custom', label: 'Another store', short: 'Other' },
];

export const SHOP_IDS = SHOP_POOL.map((s) => s.id);

/**
 * What a list shows when it has never chosen: the three it had before shops
 * were selectable. Absence means "unchanged", so the household list does not
 * move under the people using it, and a phone still running an older build
 * keeps showing exactly what it shows today.
 */
export const LEGACY_SHOPS = ['sams', 'costco', 'custom'];

/** A shop name somebody typed. Bounded so it cannot blow the 1024-char
 *  ciphertext cap on this collection, and so it cannot fill a tab face. */
export const MAX_SHOP_LABEL = 24;

/**
 * The outbox key. `kind:id`, never a bare id — see LEDGER M15.
 *
 * Receipt: the outbox was one map keyed by item id, so `items`, `plan` and
 * `qty` shared a key space and the second write to a row silently untracked the
 * first. No race was needed. Tick a row, then change its quantity, while
 * offline — `drain()` returns early when the browser reports no connection, so
 * nothing clears in between — and the TICK NEVER LEAVES THE PHONE, while your
 * own screen shows it done. §1's "a tap that appears to work and does not", in
 * §0's dominant failure mode, with no recovery: `requeueAll` re-arms only
 * `items` and `added`, and `restampPending` iterates the outbox, so neither can
 * see a record the outbox has stopped pointing at.
 *
 * The VALUE stays the kind, and that is load-bearing for one reason only: it is
 * the migration's sole source of truth for re-keying a pre-M15 bare id. (An
 * earlier draft of this comment claimed the value is what lets an id contain a
 * colon. That is wrong and was worth correcting: no KIND contains a colon, so
 * splitting on the FIRST colon would be equally exact. `obId` slices a known
 * length because it is handed the kind anyway, not because it has to be.)
 *
 * `obKey` is injective — no two (kind, id) pairs can collide — BUT that is a
 * property of the current KINDS values, not of the scheme: no kind is a prefix
 * of another. Adding `price` is safe. Adding a kind such that some existing
 * kind + ':' could prefix it would not be. Check that before adding one.
 */
const obKey = (kind, id) => `${kind}:${id}`;
const obId = (key, kind) => key.slice(kind.length + 1);

/**
 * What a client id may be. Named, and shared by `isWellFormed`'s `c` check and
 * `load()`'s `me.id` gate, so the two can never drift — `me.id` BECOMES the `c`
 * on every record this device writes, and a device whose own id fails this test
 * has its every write discarded by everyone including itself.
 */
const CLIENT_ID = /^[A-Za-z0-9_-]{1,24}$/;

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
  if (rec.c !== undefined && rec.c !== null && !CLIENT_ID.test(rec.c)) return false;
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
  } else if (kind === 'shops') {
    // One record per shop, so two people choosing different shops at the same
    // time both get their way — the same reason `qty` is its own register.
    if (typeof rec.on !== 'boolean') return false;
    if (!isStr(rec.label)) return false;
    if (typeof rec.label === 'string' && rec.label.length > MAX_SHOP_LABEL) return false;
  } else if (kind === 'added') {
    if (typeof rec.name !== 'string') return false;
    if (!isStr(rec.note) || !isStr(rec.store) || !isStr(rec.by)) return false;
    if (rec.del !== undefined && typeof rec.del !== 'boolean') return false;
  } else {
    // An UNKNOWN kind fails, totally and obviously, rather than falling through
    // to whatever the last branch happened to check. This used to be a bare
    // `else` holding the `added` shape, which meant a kind added to KINDS but
    // not here was silently validated against `added`: every one of its records
    // would be rejected for having no `name` — working in memory, gone on
    // reload, never arriving from a peer, with nothing on screen. And in the
    // other direction a record that happened to carry a `name` string would
    // pass this gate without one of its own fields being looked at. This is the
    // untrusted-input boundary (§4); it does not get to guess.
    return false;
  }
  return true;
}

/* ---------- store ---------- */

export function createStore({ ns = 'household' } = {}) {
  const LS_KEY = lsKey(ns);
  const listeners = new Set();
  let clock = 0;
  let persistBroken = false;
  /** ROWS whose not-yet-sent work was lost because `load()` rejected what was
   *  behind it. A Set so one row counts once however many kinds it held. Read
   *  once, by the boot path, to tell the user something went. */
  const droppedRows = new Set();

  const state = {
    items: Object.create(null),   // itemId -> {s, n, by, t, c}  (s null = cleared)
    added: Object.create(null),   // addedId -> {name, note, store, by, del, t, c}
    plan:  Object.create(null),   // itemId -> {p, t, c}        on this trip?
    qty:   Object.create(null),   // itemId -> {q, t, c}        how many (1 = unset)
    flags: Object.create(null),   // "<itemId>@<store>" -> {f, by, t, c}  not stocked here
    shops: Object.create(null),   // shopId -> {on, label, t, c}  which shops this list uses
    outbox: Object.create(null),  // "<kind>:<id>" -> kind      durable dirty set
    ui: { store: 'sams', hideDone: false, text: 0 },
    me: { id: '', name: '' },
  };
  // KINDS is the AUTHORITY, not merely the driver. `load()`, `snapshot()`,
  // `prune()` and `mergeRemote()` all iterate it now, so a kind listed there
  // with no map here makes `load()` throw on the first persisted record of it —
  // INSIDE the try whose catch is "corrupt: start clean rather than crash".
  // That discards the whole blob, the outbox with it: every pending offline
  // write on the phone, gone, behind a Live badge. Before those loops were
  // KINDS-driven the same slip cost only "that kind does not load"; the refactor
  // made it catastrophic, so it has to carry its own backstop. The literal above
  // stays because its comments document each record's shape.
  for (const k of KINDS) if (!state[k]) state[k] = Object.create(null);

  /* ---- persistence ---- */

  function load() {
    let raw = null;
    let migrated = false;
    /** Records this gate threw away on the way in. See the count below. */
    const rejected = [];
    try { raw = localStorage.getItem(LS_KEY); } catch { /* private mode */ }
    if (raw) {
      try {
        const o = JSON.parse(raw);
        // Locally persisted records went through the same gate on the way in,
        // but a previous version's data (or a hand-edited store) has not.
        // Driven by KINDS rather than five hand-written loops. The old version
        // named each collection twice — here and in `snapshot()` — so adding a
        // sixth kind and forgetting one of them would mean records that never
        // persist: invisible while online, total loss offline, which is §0's
        // dominant failure mode. The price KIND is the next one along.
        for (const kind of KINDS) {
          for (const [id, rec] of Object.entries(o[kind] || {})) {
            // The same key gate `mergeRemote` applies. A junk shop id cannot
            // get into the blob through either writer today, but a blob written
            // by a build with a different pool — or a hand-edited one — would
            // survive a reload, and from there `requeueAll` arms it and the
            // phone re-uploads an immortal phantom forever. The two gates must
            // not drift, which is the argument `CLIENT_ID` already won above.
            if (kind === 'shops' && !SHOP_IDS.includes(id)) continue;
            if (isWellFormed(rec, kind)) state[kind][id] = rec;
            // Keep the author with the key. The count below has to ask "was
            // this OUR work", and by then the record is gone — and `state.me`
            // has not been read from the blob yet at this point either, so the
            // comparison cannot happen here.
            else rejected.push({ key: obKey(kind, id), id, c: rec && rec.c });
          }
        }
        // MIGRATION, and the first gate this map has ever had. Entries written
        // before M15 are keyed by bare id; the value has always been the kind,
        // so it carries everything needed to re-key them. Dropping them instead
        // would lose exactly the pending writes this change exists to protect.
        // A value that is not a known kind is discarded — `o.outbox` is parsed
        // from localStorage and was previously copied in wholesale, which is
        // also how a persisted value of `constructor` could wedge the whole
        // write path: `sync.js` built its per-kind buckets as plain objects, so
        // such a value made the bucket truthy and `.push` throw on every drain,
        // forever, badge stuck on Retrying with taps piling up behind it.
        //
        // The `startsWith` below IS a colon-based structural test, unlike
        // `obId`. It is only unambiguous because a locally-generated id cannot
        // contain a colon — `slug()` collapses everything but `[a-z0-9]` to `-`,
        // ad-hoc ids are base36, and a flag key is `<id>@<store>` over a
        // whitelisted store — and because a record planted at a chosen remote id
        // cannot decrypt: the AES-GCM AAD binds each seal to `list/kind/id`, so
        // a forged record at `items:whatever` is dropped before it is ever seen.
        // Neither of those facts is local to this line, hence this note.
        for (const [k, kind] of Object.entries(o.outbox || {})) {
          if (typeof kind !== 'string' || !KINDS.includes(kind)) {
            // THIS gate drops a pending write without ever looking at its
            // record, and it is the one a KIND change actually fires: ship
            // `price`, write some `price:` entries, then run an older bundle
            // for any reason and every one of them is discarded here. Counting
            // only the `isWellFormed` rejections below would have reported
            // zero for exactly the case M16 exists to cover. The row id cannot
            // be recovered (the kind that would tell us where the prefix ends
            // is the thing we just rejected), so it counts as its own row.
            if (typeof k === 'string' && k) droppedRows.add(`?:${k}`);
            continue;
          }
          if (!k.startsWith(`${kind}:`)) migrated = true;
          state.outbox[k.startsWith(`${kind}:`) ? k : obKey(kind, k)] = kind;
        }
        Object.assign(state.ui, o.ui || {});
        // A corrupt ui.store used to reach buildGroups and throw on every paint.
        // Structural check only: is this a shop id at all. WHETHER it is one
        // this list currently uses is a view question, answered at render, and
        // asking it here would need view.js — the circular import that is not
        // allowed. A valid id pointing at a switched-off shop simply falls back
        // to the first active tab when it is painted.
        if (!SHOP_IDS.includes(state.ui.store)) state.ui.store = 'sams';
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
    // `me.id` gets the SAME gate every record's `c` field gets, because it
    // becomes that field. `stamp()` writes it into everything this device
    // creates, and `isWellFormed` hard-rejects a `c` that fails CLIENT_ID.
    // A persisted id that does not match — corrupt, hand-edited, half-migrated —
    // therefore makes every write this phone produces silently discarded by the
    // whole family, while its own badge reads Live and its own screen shows the
    // ticks; then on the next boot `load()`'s own gate rejects its own records
    // and the list blanks on the phone that made it. It was the last field here
    // with no gate, and the one with the worst consequence.
    // Captured BEFORE the regeneration below, because the count that follows
    // asks "did this phone write the rejected record", and in M16's own
    // originating case the answer is yes *under the malformed id*. Comparing
    // against the fresh id would match nothing and report zero on exactly the
    // failure this exists for — which is what the first cut of it did.
    const persistedMeId = state.me.id;
    if (!CLIENT_ID.test(state.me.id || '')) {
      state.me.id = 'c' + Math.random().toString(36).slice(2, 10);
    }
    if (typeof state.me.name !== 'string') state.me.name = '';
    // COUNT WHAT THE GATE ATE, before `prune()` sweeps the evidence.
    //
    // A record rejected on the way in never reaches `state[kind]`, so `prune()`
    // then finds nothing behind its outbox entry and deletes that too. The
    // record is recoverable — the server still has it, or it was junk — but the
    // PENDING WRITE behind it is not: it is work this phone did and had not
    // sent yet, and it disappears with no event of any kind. The badge reads
    // Live throughout.
    //
    // This is the general shape, not one bug: it fires every time the gate
    // TIGHTENS. Adding a KIND tightens it. Narrowing a bound tightens it. A
    // malformed `me.id` used to trigger it across every record at once, which
    // is what surfaced it (M16) — that specific door is now shut by the
    // `CLIENT_ID` check below, but the corridor it opened onto is this one.
    for (const r of rejected) {
      if (!state.outbox[r.key]) continue;
      // OUR work only. `requeueAll` arms every record of every kind regardless
      // of author — correct for a loss restore — so after one has run the
      // outbox is the whole store, peers' records included. Without this test
      // the next tightening of the gate would tell somebody "85 changes saved
      // on this phone were lost" about work three other people did, which the
      // server still holds. In M16's own originating case the comparison still
      // matches: the records carry the malformed id and `state.me.id` has not
      // been regenerated yet.
      if (r.c !== persistedMeId) continue;
      // ROWS, not records. One row can hold a tick and a quantity and a plan
      // entry, and this number goes in front of a person beside a badge that
      // has counted rows all trip. The ledger records this exact unit question
      // as already decided (M15, LOSS RECORDED) and counting writes here was
      // re-introducing the losing side of it.
      droppedRows.add(r.id);
    }
    prune();
    for (const k of KINDS) for (const r of Object.values(state[k])) observeClock(r.t || 0);
    // ONE-SHOT RECOVERY, on the upgrade boot only.
    //
    // The migration above re-keys what the old outbox still POINTED AT. It
    // cannot recover what the M15 bug had already untracked — and that is the
    // entire population this fix exists for. A pre-v25 store holding
    // `{"protein--chicken": "qty"}` also holds a dirty `items` record for that
    // row that nothing points at, and re-keying does not start pointing at it.
    // Every phone in the family is likely carrying some right now, and without
    // this they only ever sync if somebody happens to touch that row again.
    //
    // Safe because merge is idempotent: these go out with their EXISTING `t`
    // and `c`, so a peer already holding them rejects them in `wins()` and
    // nothing cascades. That safety depends on `restampPending` leaving
    // peer-authored records alone — see the `c !== state.me.id` guard there.
    // This costs one full upload per device, once, ever.
    if (migrated) requeueAll();
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
        delete state.outbox[obKey('added', id)];
      }
    }
    for (const key of Object.keys(state.outbox)) {
      const kind = state.outbox[key];
      const map = state[kind];
      if (!map || !map[obId(key, kind)]) delete state.outbox[key];
    }
  }

  function snapshot() {
    // KINDS-driven, for the same reason `load()` is: these two named the five
    // collections independently, and a sixth added to one and missed in the
    // other persists nothing.
    const out = { outbox: state.outbox, ui: state.ui, me: state.me };
    for (const kind of KINDS) out[kind] = state[kind];
    return JSON.stringify(out);
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

  /**
   * How many not-yet-sent changes were lost when this device's saved data was
   * read back. Reported once, on boot, and then cleared: it describes a past
   * event, so a permanent badge would be wrong — but saying nothing at all
   * would mean work vanishing with no signal, which §1 puts above every other
   * failure.
   */
  function takeDroppedWork() { const n = droppedRows.size; droppedRows.clear(); return n; }

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
    state.outbox[obKey('items', itemId)] = 'items';
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
    state.outbox[obKey('added', id)] = 'added';
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
    state.outbox[obKey('added', id)] = 'added';
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
      state.outbox[obKey('added', id)] = 'added';
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
    state.outbox[obKey('added', id)] = 'added';
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
    state.outbox[obKey('plan', itemId)] = 'plan';
    persist();
    emit({ type: 'plan', id: itemId });
  }

  function clearPlan() {
    for (const id of Object.keys(state.plan)) {
      if (!state.plan[id]?.p) continue;
      state.plan[id] = stamp({ p: false });
      state.outbox[obKey('plan', id)] = 'plan';
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
    state.outbox[obKey('qty', itemId)] = 'qty';
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
    state.outbox[obKey('flags', k)] = 'flags';
    persist();
    emit({ type: 'flags', id: k });
  }

  /**
   * Turn a shop on or off for this list, and/or name it.
   *
   * One record per shop rather than one record holding the set, so two people
   * choosing different shops at the same moment both get their way instead of
   * one silently overwriting the other. Same argument as `qty`.
   */
  function setShop(shopId, patch) {
    if (!SHOP_IDS.includes(shopId)) return false;
    const cur = state.shops[shopId];
    const label = patch.label === undefined
      ? String(cur?.label ?? '')
      : String(patch.label ?? '').trim().slice(0, MAX_SHOP_LABEL);
    const on = patch.on === undefined ? !!cur?.on : !!patch.on;
    state.shops[shopId] = stamp({ on, label });
    state.outbox[obKey('shops', shopId)] = 'shops';
    persist();
    emit({ type: 'shops', id: shopId });
    return true;
  }

  function clearAllMarks() {
    for (const id of Object.keys(state.items)) {
      if (!state.items[id] || state.items[id].s == null) continue;
      state.items[id] = stamp({ s: null, n: '', by: '' });
      state.outbox[obKey('items', id)] = 'items';
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
      state.outbox[obKey('plan', id)] = 'plan';
    }
    for (const id of keep) {
      if (state.plan[id]?.p) continue;
      state.plan[id] = stamp({ p: true });
      state.outbox[obKey('plan', id)] = 'plan';
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
    // A SET, because the same id can now lose once per kind. Ticking a row and
    // bumping its quantity offline leaves two pending writes — that is the M15
    // fix working — so one remote row beating both would have told the user
    // "2 of your ticks were changed on another phone" about one item and one
    // other person's single action.
    const clobbered = new Set();

    for (const kind of KINDS) {
      const incoming = remote[kind];
      if (!incoming) continue;
      const into = state[kind];
      for (const id of Object.keys(incoming)) {
        const rec = incoming[id];
        if (!isWellFormed(rec, kind)) continue;
        // `isWellFormed` is handed a record, never an id, so it cannot judge
        // one. A `shops` key that is not a real store would otherwise merge,
        // get armed by `requeueAll`, counted on the badge, and re-uploaded by
        // the family's own phones forever — nothing prunes it and the rules
        // forbid deleting it. It never reaches the DOM (`shopsFor` filters
        // against the pool), but §1 says the badge is not decoration, and a
        // badge that counts an immortal phantom is a badge that lies.
        if (kind === 'shops' && !SHOP_IDS.includes(id)) continue;
        observeClock(rec.t);
        const cur = into[id];
        if (!wins(rec, cur)) continue;
        // Scoped to THIS kind. Against the old shared key space this asked
        // "is anything pending for this id", so an incoming `qty` could report
        // a clobbered `items` write, or miss a genuinely clobbered one because
        // a different kind's entry had overwritten the key.
        if (cur && cur.c === state.me.id && state.outbox[obKey(kind, id)]) clobbered.add(id);
        into[id] = rec;
        changed = true;
      }
    }
    if (changed) { persist(); emit({ type: 'remote' }); }
    return { changed, clobbered: [...clobbered] };
  }

  /* ---- outbox ---- */

  function pendingOps() {
    const ops = [];
    for (const key of Object.keys(state.outbox)) {
      const kind = state.outbox[key];
      const id = obId(key, kind);
      const rec = state[kind] && state[kind][id];
      // The op carries the KEY it came from, so `ackOps` deletes the entry it
      // was handed rather than rebuilding one. Recomposing was only sound while
      // every key's prefix matched its value, and nothing enforces that.
      if (rec) ops.push({ key, id, kind, rec });
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
        delete state.outbox[op.key || obKey(op.kind, op.id)];
        cleared++;
      }
    }
    if (cleared) { persist(); emit({ type: 'sync' }); }
    return cleared;
  }

  /**
   * How many THINGS are waiting, not how many records.
   *
   * This is the number on the badge (`↑ 12`), read by somebody in an aisle with
   * no signal, and there is no legend anywhere explaining it. Counting outbox
   * entries made it 2-3x higher for identical activity the moment one row could
   * hold a tick AND a quantity AND a plan entry: plan 30 rows, tick them, bump
   * 8 quantities and it read `Offline ↑68`. The old `↑ 30` was only "right"
   * because it was silently dropping the other 38 writes.
   *
   * The two reviews split on this. Correctness called the raw count truthful —
   * it is, as a count of pending WRITES. The performance pass called it a
   * §8 failure, and that argument wins: the number exists for a person deciding
   * whether their taps are safe, and "things of mine still to send" is what
   * they can check against their own screen. An internal record count they
   * cannot reconcile with anything is a number that sends them back to paper.
   */
  function pendingCount() {
    const rows = new Set();
    for (const key of Object.keys(state.outbox)) rows.add(obId(key, state.outbox[key]));
    return rows.size;
  }

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
   *
   * That trade is EVERY KIND WIDE now, not two. It was written when the outbox
   * effectively held one entry per row, so it bulldozed the last thing you did
   * to a row; it now covers that row's tick, its plan entry, its quantity and
   * its not-stocked flags together. That is the intended behaviour — they are
   * all "what this phone last knew" — but it is five times more than the
   * sentence above used to describe.
   */
  function restampPending() {
    let n = 0;
    for (const key of Object.keys(state.outbox)) {
      const kind = state.outbox[key];
      const map = state[kind];
      const id = obId(key, kind);
      if (!map || !map[id]) continue;
      // OUR OWN WORK ONLY. After `requeueAll` the outbox is the entire local
      // store, including records the other three phones wrote — and re-stamping
      // those would make this device the author of record for the whole list,
      // timestamped ahead of every peer, bulldozing anything they did in the
      // last few seconds and winning every future LWW tie. §4 calls the
      // empty-snapshot restore "safe because merge is idempotent", and that is
      // only true while the re-armed records go back out UNCHANGED. This `if`
      // is what makes that sentence true again. The slow-clock problem below
      // only ever concerned work this device did itself.
      if (map[id].c !== state.me.id) continue;
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
   *
   * ALL FIVE KINDS, not two. This listed `items` and `added` by hand and left
   * `plan`, `qty` and `flags` behind, which broke §4's "an empty root snapshot
   * while holding local state means loss, not a fresh list" in the quietest
   * possible way: the node is emptied, every phone re-uploads its ticks and its
   * ad-hoc items, the toast says "Restoring 58 from this phone", and the trip
   * plan, every quantity and every not-stocked flag are gone from the shared
   * list forever. Nobody sees it, because each phone still renders its own
   * local copy — until one loses its storage (iOS evicts a PWA's localStorage
   * after 7 days; `writeThrough` already has a handler for exactly that) or a
   * fresh device opens the link, at which point the plan is simply missing with
   * no event to explain it. The argument above for re-arming unconditionally
   * covers every kind unchanged.
   */
  function requeueAll() {
    // Counts NEWLY-ARMED ROWS, not records, and both halves of that matter.
    //
    // "Newly armed": root emptiness is judged on `items` and `added` only (see
    // sync.js) AND the caller now also checks this device holds something, so a
    // brand-new list where the family has planned a trip but
    // nobody has ticked anything yet looks empty on every reconnect. While this
    // counted `items` + `added` the count was 0 there and nothing happened;
    // counting all five would have made a flapping link re-upload the whole
    // store and toast at the user over and over, during the two non-technical
    // users' first hour with the app.
    //
    // "Rows": the caller puts this number in front of a person — "Restoring 12
    // from this phone" — and one row can contribute five records. Same unit as
    // `pendingCount`, so the toast and the badge can never disagree.
    const rows = new Set();
    for (const kind of KINDS) {
      for (const id of Object.keys(state[kind])) {
        if (!state[kind][id]) continue;
        const key = obKey(kind, id);
        if (state.outbox[key] === kind) continue;   // already queued
        state.outbox[key] = kind;
        rows.add(id);
      }
    }
    if (rows.size) { persist(); emit({ type: 'sync' }); }
    return rows.size;
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
    isFlagged, flagInfo, setFlag, setShop, parseList, importItems,
    mergeRemote, pendingOps, ackOps, pendingCount, requeueAll, restampPending,
    flushPersist, isPersistBroken, takeDroppedWork, reset, wins, isWellFormed,
  };
}
