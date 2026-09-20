/**
 * view.js — pure projection of (DATA + state) to markup.
 *
 * Nothing here mutates state or touches the network. `buildGroups` is the one
 * place that decides what a store's list contains, so the tab counts, the list,
 * and the trip report can never disagree about what is on it.
 */

import { DATA } from './data.js';
import { STATUSES, MIN_QTY, MAX_QTY, MAX_PRICE, SHOP_POOL, LEGACY_SHOPS } from './store.js';

export const flagKey = (itemId, storeId) => itemId + '@' + storeId;

/**
 * Which shops THIS list uses, in tab order.
 *
 * A shop is active when it has a record saying `on`. **No records at all means
 * the legacy three** — Sam's, Costco, Custom — so a list that has never chosen
 * does not move under the people using it, and nothing about the household list
 * changes until somebody changes it on purpose.
 *
 * Never returns empty: a list whose every shop was somehow switched off would
 * have no tabs, no place to file anything, and no way back. Falling to the
 * legacy three is the recoverable answer.
 */
/**
 * What this list has CHOSEN — not what it currently shows.
 *
 * `shopsFor` adds back any store that still holds items, so a store can appear
 * as a tab while being switched off. The settings editor must seed itself from
 * this instead: seeding from `shopsFor` made a switched-off store come back
 * looking chosen, and saving again would have silently turned it on again,
 * undoing a decision the person had just made and been warned about.
 */
export function chosenShopIds(state) {
  const recs = state?.shops || {};
  const picked = SHOP_POOL.filter((s) => recs[s.id] && recs[s.id].on === true).map((s) => s.id);
  return picked.length ? picked : [...LEGACY_SHOPS];
}

/**
 * Every shop an added item sits on: its `store`, plus any in `also` (v32).
 *
 * `store` is still the first one and still required, so a v31 phone - which
 * knows nothing about `also` - renders the item on that one tab rather than
 * losing it. Fewer tabs, never none.
 */
export function shopsOf(rec) {
  if (!rec) return [];
  const out = [String(rec.store)];
  if (Array.isArray(rec.also)) {
    for (const s of rec.also) if (typeof s === 'string' && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Every tab that is currently SHOWING this id, record or no record.
 *
 * `findItem` answers "give me the row" and returns the FIRST tab holding it,
 * which is the right answer to its own question and the wrong seed for a store
 * picker: 44 of the catalogue's 84 rows are listed at both clubs under one id,
 * so standing on Costco and opening one lit up Sam's alone - and saving wrote
 * `store:'sams'` with no `also`, taking the row off the Costco tab. Measured:
 * costco 58 -> 57 on a single price edit, on all four phones, with the sheet
 * saying "Saved". §1, the list is never silently smaller.
 *
 * Only needed when the item has no `added` record yet; once it has one,
 * `shopsOf` is the truth.
 */
export function shopsHolding(state, id) {
  const out = [];
  for (const s of shopsFor(state)) {
    for (const sec of buildGroups(state, s.id)) {
      if (sec.items.some((i) => i.id === id)) { out.push(s.id); break; }
    }
  }
  return out;
}

/** Is this added record on this tab? The single question, asked in one place. */
export function onShop(rec, storeId) {
  if (!rec) return false;
  if (rec.store === storeId) return true;
  return Array.isArray(rec.also) && rec.also.includes(storeId);
}

export function shopsFor(state) {
  const recs = state?.shops || {};
  const chosen = SHOP_POOL.filter((s) => recs[s.id] && recs[s.id].on === true);
  const base = chosen.length
    ? chosen
    : SHOP_POOL.filter((s) => LEGACY_SHOPS.includes(s.id));

  // ANY STORE THAT STILL HOLDS SOMETHING GETS A TAB, chosen or not.
  //
  // Without this an item filed under a store the list no longer uses is
  // invisible on every phone: no tab renders it, `counts` never sees it,
  // `findItem` returns null so the edit sheet reports it "already gone", and
  // `buildReport` leaves it out of the export the threat model calls the last
  // resort. The record is intact and synced the whole time — it is simply
  // unreachable, with no way back short of the Firebase console. §1: the list
  // is never silently smaller. This is the one-line expression of that.
  const have = new Set(base.map((s) => s.id));
  const orphans = [];
  for (const id of Object.keys(state?.added || {})) {
    const a = state.added[id];
    if (!a || a.del) continue;
    // EVERY shop the item is on, not just its first. An item on Sam's AND a
    // switched-off Target must keep the Target tab too, or the half of it
    // filed there goes unreachable - which is the whole reason this block
    // exists, applied to v32's shape.
    for (const sid of shopsOf(a)) {
      if (have.has(sid)) continue;
      have.add(sid);
      const pool = SHOP_POOL.find((s) => s.id === sid);
      if (pool) orphans.push(pool);
    }
  }
  const active = orphans.length
    ? SHOP_POOL.filter((s) => have.has(s.id))   // keep pool order
    : base;

  return active.map((s) => {
    // A name somebody typed replaces BOTH forms. They chose it; they decided
    // how short it should be.
    const own = recs[s.id] && typeof recs[s.id].label === 'string' && recs[s.id].label.trim();
    return own ? { id: s.id, label: own, short: own } : s;
  });
}

const FROZEN_RE = /\s*[—-]\s*MUST BE FROZEN/i;

/*
 * The three status marks, as HTML entities rather than literal glyphs. That
 * buys ONE thing and it is worth being precise about which: it survives a
 * mis-declared charset, an editor that re-encodes on save, and a copy-paste
 * through a tool that does not speak Unicode. It does NOT buy font coverage -
 * a glyph the font lacks is a box whether it arrived as an entity or as bytes.
 *
 * Coverage is a separate question and was checked separately: all three live in
 * Basic Latin punctuation (U+2713, U+2715) and the Arrows block (U+21C4), which
 * Roboto, Noto and the iOS system fonts all carry in full. Arrows is the one
 * worth naming, because Swap is the status with no other cue - it is not dimmed
 * and not struck through - so if its mark ever boxed, Swap would lose the most.
 *
 * CHOSEN FOR SHAPE, NOT FOR MEANING. They have to be told apart at a glance by
 * someone who sees all three as the same colour, so they differ in the
 * direction their strokes run: one leans, one is level, one crosses. The
 * arrows are U+21C4 rather than a two-headed arrow because a swap is a trade,
 * not a range.
 */
const MARK = { got: '&#10003;', swap: '&#8644;', skip: '&#10005;' };

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 52);
}

/* ---------- model ---------- */

/**
 * Item ids are derived from section + name so they are stable across
 * regenerations of data.js and identical on every device. They are the merge
 * key, so they must never depend on array order or local state.
 */
const idCache = new Map();
function itemId(sectionName, itemName) {
  // JSON, not concatenation: two different (section, item) pairs must never
  // collapse to the same cache key and hand back the wrong id.
  const k = JSON.stringify([sectionName, itemName]);
  let v = idCache.get(k);
  if (!v) { v = slug(sectionName) + '--' + slug(itemName); idCache.set(k, v); }
  return v;
}

/**
 * Only the original household list carries the scraped catalogue. A second
 * household's "Hardware" or "Christmas" list opening full of chicken thighs and
 * jasmine rice would be nonsense, and per-list catalogues would mean teaching
 * the Word-document pipeline about lists — a lot of machinery for a list whose
 * owner mostly wants to type things in. New lists start empty and are filled by
 * hand or by pasting.
 */
let useCatalogue = true;
export function configure(opts) {
  if (typeof opts?.catalogue === 'boolean' && opts.catalogue !== useCatalogue) {
    useCatalogue = opts.catalogue;
    groupCache = null;
  }
}

let groupCache = null;
function baseGroups() {
  if (groupCache) return groupCache;
  groupCache = { sams: [], costco: [], custom: [] };
  if (!useCatalogue) return groupCache;

  for (const store of ['sams', 'costco']) {
    const want = store === 'sams' ? ["Sam's", 'Both'] : ['Costco', 'Both'];
    for (const sec of DATA.sections) {
      const items = [];
      for (const i of sec.items) {
        if (!want.includes(i.where)) continue;
        items.push({
          id: itemId(sec.name, i.name),
          name: i.name,
          detail: store === 'sams' ? i.sams : i.costco,
          est: store === 'sams' ? i.est : '',
          other: i.where === 'Both' ? (store === 'sams' ? i.costco : i.sams) : '',
          otherLabel: store === 'sams' ? 'Costco' : "Sam's",
          only: i.where !== 'Both',
        });
      }
      if (items.length) groupCache[store].push({ sec: sec.name, items });
    }
  }

  groupCache.custom.push({
    sec: 'NOT AT EITHER CLUB',
    items: DATA.custom.map((c) => ({
      id: 'custom--' + slug(c.name),
      name: c.name, custom: true, why: c.why, getat: c.where_to_get,
    })),
  });

  return groupCache;
}

/** Visible groups for a store, including that store's live "added by me" rows. */
/** Every catalogue id, for telling an override from an ad-hoc item. */
export function catalogueIds() {
  const ids = new Set();
  const g = baseGroups();
  for (const store of ['sams', 'costco', 'custom']) {
    for (const sec of g[store]) for (const it of sec.items) ids.add(it.id);
  }
  return ids;
}

export function isCatalogueId(id) { return catalogueIds().has(id); }

/** The row as it is actually shown, override applied. Used by the edit sheet,
 *  which is handed an id and has to fill a form from it. */
export function findItem(state, id) {
  // Every shop this list uses, not the catalogue's three. An item filed under
  // Target is invisible to a three-store loop, and the edit sheet is handed an
  // id and told to fill a form from it — so it would have reported the row
  // "already gone" for a row sitting on screen.
  const ids = new Set([...shopsFor(state).map((s) => s.id), 'sams', 'costco', 'custom']);
  for (const store of ids) {
    for (const sec of buildGroups(state, store)) {
      for (const it of sec.items) if (it.id === id) return { ...it, store };
    }
  }
  return null;
}

/**
 * The clock value this list was emptied at, or 0.
 *
 * Read defensively rather than trusted: this arrives from a world-writable node
 * like everything else, and it is the one value that can hide the entire list.
 * `isWellFormed` is the real gate; this is the render path refusing to throw or
 * to blank the list on a value that got past it (§4 - one unreadable record
 * must never blank the list).
 */
export function sweptAt(state) {
  const v = state?.sweep?.all?.at;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Is this row hidden by an "Empty this list for everyone"?
 *
 * The rule is one line and it is the whole feature: a row is emptied away when
 * the sweep is NEWER than the row's own last word about itself. A catalogue row
 * with no record has never said anything, so its last word is 0 and the sweep
 * always wins. Anything added, edited or re-added AFTER the sweep carries a
 * later `t` and survives automatically - no special case, no second marker, and
 * no record written against any row, which is what keeps `data.js` the source
 * of every catalogue name (§4: `data.js` is generated, never hand-edited).
 */
function sweptOut(state, id, at) {
  if (!at) return false;
  const rec = (state.added || {})[id];
  return at > (rec?.t || 0);
}

export function buildGroups(state, storeId) {
  // Never index blind. A corrupt `ui.store` reaching here threw on every paint,
  // which the renderer's catch then turned into a permanent error card offering
  // a recovery that could not work.
  //
  // EMPTY, not `.sams`. The catalogue only knows Sam's, Costco and Custom, so
  // every other shop legitimately has no base groups — and falling back to
  // Sam's would print the entire club catalogue under Target. An unknown id
  // showing nothing is right for both cases: a new shop starts empty, and a
  // corrupt id shows an empty shop instead of somebody else's contents.
  const base = baseGroups()[storeId] || [];
  const added = state.added || {};
  const out = [];
  const baseIds = new Set();
  const at = sweptAt(state);

  // The catalogue is the starting point, not the contents. A record in `added`
  // keyed by a catalogue id sits in front of that row FOR THIS LIST: renaming
  // it, re-noting it, moving it, or taking it off entirely. data.js is never
  // written to and every other list is unaffected.
  for (const sec of base) {
    const items = [];
    for (const it of sec.items) {
      baseIds.add(it.id);
      const o = added[it.id];
      if (o && o.del) continue;                       // removed from this list
      if (sweptOut(state, it.id, at)) continue;       // emptied for everyone
      // ON THIS TAB? A catalogue row moved elsewhere is hidden here — but v32
      // lets it be on several at once, so the question is no longer equality.
      if (o && !onShop(o, storeId)) continue;
      items.push(o
        ? { ...it, name: o.name, detail: o.note || it.detail, edited: true, editable: true }
        : { ...it, editable: true });
    }
    if (items.length) out.push({ sec: sec.sec, items });
  }

  // Ad-hoc items, plus any catalogue row moved INTO this shop from another.
  const mine = [];
  for (const id of Object.keys(added)) {
    const a = added[id];
    if (!a || a.del || !onShop(a, storeId)) continue;
    if (sweptOut(state, id, at)) continue;            // emptied for everyone
    if (baseIds.has(id)) continue;                    // already shown above
    mine.push({ id, name: a.name, detail: a.note || '', mine: !a.cat, edited: !!a.cat, editable: true, by: a.by });
  }
  if (mine.length) {
    mine.sort((x, y) => (added[x.id].t || 0) - (added[y.id].t || 0));
    out.push({ sec: 'ADDED', items: mine });
  }
  return out;
}

/**
 * Is this row on the current trip?
 *
 * Until somebody plans something, everything counts — so a household that never
 * touches planning sees exactly what it saw before the feature existed.
 * Ad-hoc added items are always on the trip: you added them just now.
 */
export function onTrip(state, item, planning) {
  if (planning) return true;
  if (item.mine) return true;
  if (!anyPlanned(state)) return true;
  return !!state.plan[item.id]?.p;
}

export function anyPlanned(state) {
  for (const id of Object.keys(state.plan)) if (state.plan[id]?.p) return true;
  return false;
}

/**
 * What is on this trip, and what it is likely to cost.
 *
 * THE ESTIMATE IS COMPUTED HERE, and the placement is deliberate on both sides.
 *
 * NOT its own subscriber: that would bypass the sync-type early return and the
 * `document.hidden` skip the renderer already has, so a phone in a pocket would
 * re-total the list on every record that arrived over a flapping link.
 *
 * NOT fused into `listHTML`'s walk either, tempting as that is - `listHTML`
 * filters on `hideDone`, so the moment somebody turned that on the total would
 * silently drop to the cost of what was left, and a total that changes when you
 * change a VIEW setting is a total nobody can trust.
 *
 * `counts` already walks exactly the right set: everything on the trip, ticked
 * or not, unaffected by `hideDone`. The estimate rides along for free.
 *
 * PER UNIT, times quantity. "2x milk at $3.99" is $7.98. This is the one thing
 * that would make the number silently 2x wrong, so it is settled and stated in
 * three places: here, on the input's label, and in the ledger.
 */
/**
 * The live price record for a row, or null — the store's `priceOf` for code
 * that only has a plain state object.
 *
 * ONE COPY, in this module. `view.js` cannot reach the store's closure, so it
 * genuinely needs its own; what it does not need is two, which is what `counts`
 * and `itemHTML` each having an inline version would have given, and those are
 * the two that would drift. `on` is the cleared marker — see `setPrice`, which
 * carries the receipt for why it is not `by`.
 */
function livePrice(state, id) {
  const r = (state.price || {})[id];
  if (!r || !r.on) return null;
  if (typeof r.v !== 'number' || !Number.isInteger(r.v)) return null;
  if (r.v < 0 || r.v > MAX_PRICE) return null;
  return r;
}

export function counts(state, storeId) {
  let total = 0, done = 0;
  let cents = 0, priced = 0, unpriced = 0, byWeight = 0;
  for (const g of buildGroups(state, storeId)) {
    for (const i of g.items) {
      if (!onTrip(state, i, false)) continue;
      total++;
      if (state.items[i.id]?.s) done++;

      const p = livePrice(state, i.id);
      if (!p) { unpriced++; continue; }
      if (p.w) { byWeight++; continue; }        // sold by weight: no total exists
      const q = state.qty[i.id]?.q;
      const n = typeof q === 'number' && Number.isInteger(q) && q > 0 ? q : 1;
      cents += p.v * n;
      priced++;
    }
  }
  return { total, done, cents, priced, unpriced, byWeight };
}

/**
 * The estimate as a sentence, or '' when there is nothing honest to say.
 *
 * THE HONESTY LINE IS ALSO THE PERF FIX. A total that hides what it leaves out
 * is what pressures somebody into hand-pricing 76 rows to make the number stop
 * lying - so it always says how many rows it could not include. And it NEVER
 * renders $0.00: a zero total on a list with things in it reads as "this is
 * free", when it means "nobody has said what any of this costs".
 */
export function estimateLine(c, opts = {}) {
  if (!c) return '';

  // THE STORE IS NAMED, not gestured at. `counts` walks ONE tab, so this is
  // what the current store's trolley costs - not the trip - and somebody
  // reading "About $412" on the Sam's tab of a four-shop list has every reason
  // to think otherwise. The first cut said "here", which works only for a
  // reader who has already learned this app's use of the word ("Not stocked
  // here"); as a trailing fragment on a number it attaches to nothing visible.
  // The short names already exist in SHOP_POOL, so naming it costs the same
  // line and needs no learned convention. Omitted on a single-shop list.
  const where = opts.store ? ` at ${opts.store}` : '';

  // "TAP THE PENCIL", not "tap an item". A row does not open on tap - only the
  // pencil at the end of the name does (`[data-edit]`), so "tap an item to add
  // one" sent somebody prodding a row that would never respond. §3 forbids a
  // dead end, and advice the screen cannot satisfy is one.
  const how = 'tap the ✎ on a row to add one';

  // BUILT ONCE, APPENDED TO EVERY PATH THAT SHOWS A FIGURE, and that is the
  // whole point of hoisting it. The first cut assembled this inline on the main
  // branch only, so the under-a-dollar and free branches dropped the by-weight
  // count entirely: twelve weighed rows and one 49c item read "Under $1", and
  // one free sample beside twelve weighed rows read "Free so far". Fixing
  // "About $0" by adding branches created two new lies in the branches, which
  // is what happens when the honesty suffix is a property of one path instead
  // of the function.
  const bits = [];
  if (c.unpriced) bits.push(`${c.unpriced} item${c.unpriced === 1 ? '' : 's'} with no price`);
  if (c.byWeight) bits.push(`${c.byWeight} by weight`);
  const rest = bits.length ? ` · ${bits.join(' · ')}` : '';

  if (!c.priced) {
    // Nothing has a number, so there is no figure to show - only an honest
    // description of why.
    if (!c.byWeight && !c.unpriced) return '';
    // EVERYTHING WEIGHED IS NOT "NO PRICES YET": the household priced these,
    // deliberately, and no action offered could ever clear that message.
    if (c.byWeight && !c.unpriced) return `${c.byWeight} sold by weight${where} — no total to show`;
    // MIXED. "No prices yet" is false the moment one row is marked weighed, and
    // this state is the LIKELY one - ~76 of 84 household rows are unpriced
    // today, so a single weighed row puts the list here rather than in the pure
    // case above. Say what is actually true and still offer the action.
    if (c.byWeight) return `No total yet${where}${rest} — ${how}`;
    return `No prices yet${where} — ${how}`;
  }

  // NEVER "About $0", which this function's contract forbids and its first cut
  // allowed: that guard tested only that SOMETHING was priced, so one 49c item
  // - or one genuinely free one - rendered "About $0 · 20 items with no price",
  // which reads as "this trolley is free" and means the opposite.
  const dollars = Math.round(c.cents / 100);
  if (c.cents === 0) return `Nothing to pay so far${where}${rest}`;
  if (dollars < 1) return `Under $1${where}${rest}`;
  return `About $${dollars.toLocaleString('en-US')}${where}${rest}`;
}

/* ---------- markup ---------- */

export function tabsHTML(state) {
  return shopsFor(state).map((s) => {
    const c = counts(state, s.id);
    // `.face` so a name somebody typed truncates instead of wrapping the strip
    // onto a second line — the tab row's height is load-bearing for the sticky
    // header. `title` gives the full name back on a device that can show one.
    return `<button class="pxl tab${state.ui.store === s.id ? ' on' : ''}" data-store="${s.id}" title="${esc(s.label)}">`
      + `<span class="face">${esc(s.short)}</span><span class="n">${c.done}/${c.total}</span></button>`;
  }).join('');
}

/** `name` can arrive from the database, where it is not guaranteed to be a
 *  string. `RegExp.test` coerces; `String.replace` does not, and the resulting
 *  TypeError used to escape `paint()` and blank the page on every device that
 *  merged the record — permanently, because it was persisted. */
function splitFrozen(name) {
  const s = typeof name === 'string' ? name : String(name ?? '');
  if (FROZEN_RE.test(s)) return { text: s.replace(FROZEN_RE, ''), frozen: true };
  return { text: s, frozen: false };
}

export function itemHTML(item, state, opts = {}) {
  const planning = !!opts.planning;
  const storeId = opts.storeId || state.ui.store;
  const rec = state.items[item.id];
  // Whitelisted, not escaped: this is interpolated into a class attribute, and
  // a status string that breaks out of it executes on every device that merged
  // the record. The passphrase lives in localStorage by design, so script
  // execution here converts straight into permanent read access to the list.
  const st = STATUSES.includes(rec?.s) ? rec.s : '';
  const note = rec?.n || '';
  const by = rec?.by || '';
  const { text, frozen } = splitFrozen(item.name);

  let body;
  if (item.custom) {
    body = `<div class="why">${esc(item.why)}</div>`
         + `<div class="getat">&rarr; ${esc(item.getat)}</div>`;
  } else {
    const det = item.detail
      ? `<div class="det">${esc(item.detail)}${item.est ? ` <span class="price">${esc(item.est)}</span>` : ''}</div>`
      : (item.mine ? '' : `<div class="det">No listed pack &mdash; check the shelf.</div>`);
    const alt = item.other
      ? `<div class="alt">${esc(item.otherLabel)}: ${esc(item.other)}</div>`
      : (item.only ? `<div class="alt">Only at this club.</div>` : '');
    body = det + alt;
  }

  // How many. Shown as a badge on the name only when it is not 1, so the row
  // stays quiet by default, and always as a stepper so it can be changed in the
  // aisle without hunting for a menu.
  const q = state.qty[item.id]?.q;
  // VALIDATED THE SAME WAY `counts` VALIDATES IT. `counts` requires an integer
  // above zero; this used to accept any number, and the price tag multiplies by
  // it - so a float `qty` in state would render "$9.97 each $3.99" on the row
  // while the header total counted 399. Not reachable today (`isWellFormed`
  // gates `qty` on both the wire and the load path), but two gates that are
  // supposed to agree and do not is precisely the drift `store.js` warns about.
  const qty = typeof q === 'number' && Number.isInteger(q) && q > 0 ? q : MIN_QTY;
  const qtyBadge = qty > MIN_QTY ? `<span class="qtybadge">&times;${qty}</span>` : '';
  const stepper = `<span class="qty" role="group" aria-label="How many">`
    + `<button class="qminus" data-qty="${esc(item.id)}" data-delta="-1"`
    + `${qty <= MIN_QTY ? ' disabled' : ''} aria-label="One fewer">&minus;</button>`
    + `<span class="qnum" aria-live="polite">${qty}</span>`
    + `<button class="qplus" data-qty="${esc(item.id)}" data-delta="1"`
    + `${qty >= MAX_QTY ? ' disabled' : ''} aria-label="One more">+</button></span>`;

  // WHAT IT COSTS, on the row. Quiet by default: a row with no price says
  // nothing rather than showing a placeholder, because 18 of the 71 catalogue
  // lines have never had one and a screen of "—" teaches people to ignore the
  // column. Shown as the LINE cost when there is more than one, with the
  // per-unit price beside it, so "2 × $3.99" and "$7.98" are both on screen -
  // the estimate multiplies by quantity, and a shopper checking the total
  // against the trolley needs to see that happen rather than trust it.
  // `.pricetag`, NOT `.price`: `.price` has been the CATALOGUE's estimate
  // string since long before this feature (`<span class="price">$16.72
  // $2.98/lb</span>` inside `.det`), styled by the scoped `.det .price`, which
  // deliberately sets no font-size. A bare `.price` rule here shrank every
  // catalogue estimate on every row and made it unbreakable - and put two
  // differently-meaning figures on one line under one class name, one per-unit
  // and feeding the total, one a pack price that does not.
  const pr = livePrice(state, item.id);
  let priceTag = '';
  if (pr && pr.w) {
    priceTag = `<span class="pricetag by-weight">by weight</span>`;
  } else if (pr) {
    const each = `$${(pr.v / 100).toFixed(2)}`;
    // The QUANTITY IS NOT RESTATED. At qty 2 the row already carries `×2` on
    // the name and `2` in the stepper; a third copy inside the price was the
    // smallest type on screen carrying the figure that most needs to be
    // unmistakable. The line total leads, the unit price follows.
    priceTag = qty > MIN_QTY
      ? `<span class="pricetag">$${((pr.v * qty) / 100).toFixed(2)}<span class="each">each ${each}</span></span>`
      : `<span class="pricetag">${each}</span>`;
  }

  const whoTag = st && by ? `<span class="who">${esc(by)}</span>` : '';
  const noteRow = (st === 'swap' || st === 'skip') && note
    ? `<div class="noteline" data-note="${esc(item.id)}">`
      + `<b>${st === 'swap' ? 'Bought instead' : 'Reason'}:</b> ${esc(note)} <span class="pencil">&#9998;</span></div>`
    : '';
  // Edit rather than a bare x. Deletion lives inside it, which is how it becomes
  // findable: reported as "there is no removal at all" when the x had been there
  // the whole time - 26px, muted, unlabelled, at the end of a name.
  // On every row now. `mine` still means "somebody typed this", which planning
  // and the missing-pack hint below both rely on; `editable` is the separate
  // question of whether this list may change it, and the answer is always yes.
  const removeBtn = item.editable
    ? `<button class="rm" data-edit="${esc(item.id)}" aria-label="Edit or remove ${esc(text)}">&#9998;</button>` : '';

  // A persistent correction to the list, not a trip outcome. It survives
  // "Start a new trip", says who reported it, and the row is never removed —
  // one shopper failing to find something is not proof the store never has it.
  const flagged = !!state.flags[flagKey(item.id, storeId)]?.f;
  const flagBy = state.flags[flagKey(item.id, storeId)]?.by || '';
  // The "try somewhere else" bucket, resolved against THIS list. It used to be
  // the words "Custom shop" hardcoded — which names a tab that may have been
  // renamed, or that this list may not have at all, and §3 forbids a dead end.
  // Hoisted: this was two `shopsFor(state)` calls per row, each scanning
  // `state.added`, so 116 per 58-row render instead of 58. Immaterial at §0's
  // scale; free while the file is open.
  const shops = shopsFor(state);
  const otherBucket = shops.find((s) => s.id === 'custom');

  // EVERY OTHER SHOP THIS LIST HAS, not one hardcoded peer (LEDGER M24). This
  // was `storeId === 'sams' ? 'costco' : 'sams'`, so any tab that was not Sam's
  // resolved to Sam's: on a list of Costco and Target, standing on Costco, the
  // hint asked whether the item was flagged at a store that list does not have.
  // The answer is always no, so the hint NEVER appeared, however many shops the
  // item was flagged at. Defensible while the store set was frozen at three;
  // v28 made it editable per list, which is what made it wrong.
  //
  // The `custom` bucket is excluded because it is what the hint SUGGESTS moving
  // to - counting it would mean "it is missing everywhere including the place I
  // am about to send you", which is advice the app should not give. With two
  // shops this returns exactly what the old line did; with four it is the only
  // correct answer.
  const elsewhere = shops.filter((s) => s.id !== storeId && s.id !== 'custom');
  const flaggedEverywhere = flagged
    // NOT WHILE STANDING ON THE BUCKET ITSELF. `!item.custom` below does not
    // cover this: `custom: true` is set only on DATA.custom CATALOGUE rows, so
    // a hand-typed item filed under this shop - or a catalogue row moved into
    // it - has `custom === false`, and the hint told you to move it to the tab
    // you were already looking at. The rewrite excluded `custom` from the COUNT
    // and forgot the tab, which is the same omission twice.
    && storeId !== 'custom'
    && elsewhere.length > 0
    && elsewhere.every((s) => !!state.flags[flagKey(item.id, s.id)]?.f);
  const flagRow = flagged
    ? `<div class="flagline" data-unflag="${esc(item.id)}">`
      + `<b>Not stocked here</b>${flagBy ? ' &middot; ' + esc(flagBy) : ''}`
      + (flaggedEverywhere && !item.custom && otherBucket
        ? ` &mdash; nobody can find it at ${elsewhere.length === 1 ? 'either store' : 'any of your stores'}, try moving it to ${esc(otherBucket.short)}` : '')
      + ` <span class="pencil">&#10005;</span></div>`
    : '';

  if (planning) {
    const on = !!state.plan[item.id]?.p;
    return `<div class="item plan${on ? ' picked' : ''}" data-id="${esc(item.id)}">`
      + `<div class="nm"><span class="tickbox" aria-hidden="true">${on ? '&#10003;' : ''}</span>`
      + `${esc(text)}${frozen ? '<span class="frozen">FROZEN</span>' : ''}${qtyBadge}${stepper}</div>`
      + body + flagRow
      + `<button class="planbtn" data-plan="${esc(item.id)}" aria-pressed="${on}">`
      + `${on ? 'On this trip' : 'Add to trip'}</button></div>`;
  }

  // The status mark, repeated on the row. Colour alone cannot carry Got from
  // Swap from Skip - even after v33 re-cut all four palettes the closest pair
  // under deuteranopia is still under 2:1, which `tests/v33_probe.mjs` measures
  // and prints - so the shape says it too. aria-hidden because the button below
  // already announces the state through aria-pressed, and a screen reader
  // reading "check Chicken thighs check Got" is worse than silence.
  const rowMark = st
    ? `<span class="mk mk-${st}" aria-hidden="true">${MARK[st]}</span>`
    : '';

  return `<div class="item${item.custom ? ' cust' : ''}${st ? ' ' + st : ''}${flagged ? ' flagged' : ''}" data-id="${esc(item.id)}">`
    + `<div class="nm">${rowMark}<span class="nmt">${esc(text)}</span>`
    + `${frozen ? '<span class="frozen">FROZEN</span>' : ''}${qtyBadge}${priceTag}${whoTag}${stepper}${removeBtn}</div>`
    + body + flagRow
    + `<div class="acts" role="group" aria-label="${esc(text)}">`
    + `<button class="pxl ${st === 'got' ? 'on-got' : ''}" data-act="got" aria-pressed="${st === 'got'}"><span class="mk" aria-hidden="true">${MARK.got}</span> Got</button>`
    + `<button class="pxl ${st === 'swap' ? 'on-swap' : ''}" data-act="swap" aria-pressed="${st === 'swap'}"><span class="mk" aria-hidden="true">${MARK.swap}</span> Swap</button>`
    + `<button class="pxl ${st === 'skip' ? 'on-skip' : ''}" data-act="skip" aria-pressed="${st === 'skip'}"><span class="mk" aria-hidden="true">${MARK.skip}</span> Skip</button>`
    + `</div>${noteRow}</div>`;
}

export function listHTML(state, opts = {}) {
  const planning = !!opts.planning;
  const storeId = state.ui.store;
  const groups = buildGroups(state, storeId);
  let html = '';
  let shown = 0;

  for (const g of groups) {
    const onList = g.items.filter((i) => onTrip(state, i, planning));
    const visible = planning
      ? onList
      : onList.filter((i) => !(state.ui.hideDone && state.items[i.id]?.s));
    if (!visible.length) continue;

    const done = planning
      ? onList.reduce((n, i) => n + (state.plan[i.id]?.p ? 1 : 0), 0)
      : onList.reduce((n, i) => n + (state.items[i.id]?.s ? 1 : 0), 0);
    html += `<div class="sec"><b>${esc(g.sec)}</b><span>${done} of ${onList.length}</span></div>`;
    for (const i of visible) { html += itemHTML(i, state, { planning, storeId }); shown++; }
  }

  if (!shown) {
    if (planning) {
      html = `<div class="empty">Nothing to plan for this store.</div>`;
    } else {
      const c = counts(state, storeId);
      // AN EMPTIED LIST SAYS SO, and says how to undo it. This is the screen
      // all four phones render, so it is the only thing the OTHER three ever
      // see: without it a sweep arriving over the wire takes 58 rows away with
      // no toast, no banner and no explanation, and the generic message below
      // points at the wrong remedy - "Tap + to add something" reads as "type it
      // all in again" to the person who did not tap Empty. §1, the list is
      // never silently smaller, read from the receiving end.
      html = c.total === 0 && sweptAt(state)
        ? `<div class="empty">This list was emptied for everyone.<br><br>Tap <b>&#8943;</b> then <b>Put back items that were taken off</b> to bring it all back.</div>`
        : c.total === 0
        ? (anyPlanned(state)
          ? `<div class="empty">Nothing from this store is on this trip.<br><br>Tap <b>Plan</b> to add things, or <b>+</b> for a one-off.</div>`
          : (useCatalogue
            ? `<div class="empty">Nothing on the list for this store.<br>Tap <b>+</b> to add something.</div>`
            : `<div class="empty">This list is empty.<br><br>Tap <b>+</b> to add one thing, or <b>&#8943;</b> then <b>Paste a list</b> to add several at once.</div>`))
        : `<div class="empty">&#9989; Everything here is handled.<br><br>Tap <b>Show done</b> to see it again.</div>`;
    }
  }
  return html;
}

/* ---------- trip report ---------- */

export function buildReport(state) {
  const d = new Date();
  const L = [`SHOPPING TRIP — ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, ''];
  const nm = (i) => splitFrozen(i.name).text + (splitFrozen(i.name).frozen ? ' (FROZEN)' : '');

  for (const s of shopsFor(state)) {
    const flat = buildGroups(state, s.id)
      .flatMap((g) => g.items)
      .filter((i) => onTrip(state, i, false));
    if (!flat.length) continue;
    const bucket = { got: [], swap: [], skip: [], none: [] };
    for (const i of flat) bucket[state.items[i.id]?.s || 'none'].push(i);
    L.push(`=== ${s.label.toUpperCase()} — ${flat.length - bucket.none.length}/${flat.length} handled ===`);
    const who = (i) => { const b = state.items[i.id]?.by; return b ? `  (${b})` : ''; };
    const notHere = (i) => (state.flags[flagKey(i.id, s.id)]?.f ? '  [NOT STOCKED HERE]' : '');
    if (bucket.got.length) { L.push(`GOT (${bucket.got.length}):`); bucket.got.forEach((i) => L.push('  + ' + nm(i) + who(i))); }
    if (bucket.swap.length) { L.push(`SWAPPED (${bucket.swap.length}):`); bucket.swap.forEach((i) => L.push(`  ~ ${nm(i)} -> ${state.items[i.id]?.n || '(no note)'}${who(i)}`)); }
    if (bucket.skip.length) { L.push(`SKIPPED (${bucket.skip.length}):`); bucket.skip.forEach((i) => L.push(`  x ${nm(i)}${state.items[i.id]?.n ? ' — ' + state.items[i.id].n : ''}${who(i)}`)); }
    if (bucket.none.length) { L.push(`STILL NEEDED (${bucket.none.length}):`); bucket.none.forEach((i) => L.push('  . ' + nm(i) + notHere(i))); }
    L.push('');
  }
  return L.join('\n');
}
