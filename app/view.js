/**
 * view.js — pure projection of (DATA + state) to markup.
 *
 * Nothing here mutates state or touches the network. `buildGroups` is the one
 * place that decides what a store's list contains, so the tab counts, the list,
 * and the trip report can never disagree about what is on it.
 */

import { DATA } from './data.js';
import { STATUSES, MIN_QTY, MAX_QTY, SHOP_POOL, LEGACY_SHOPS } from './store.js';

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
    if (!a || a.del || have.has(a.store)) continue;
    have.add(a.store);
    const pool = SHOP_POOL.find((s) => s.id === a.store);
    if (pool) orphans.push(pool);
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
      if (o && o.store !== storeId) continue;         // moved to another shop
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
    if (!a || a.del || a.store !== storeId) continue;
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

export function counts(state, storeId) {
  let total = 0, done = 0;
  for (const g of buildGroups(state, storeId)) {
    for (const i of g.items) {
      if (!onTrip(state, i, false)) continue;
      total++;
      if (state.items[i.id]?.s) done++;
    }
  }
  return { total, done };
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
  const qty = typeof q === 'number' ? q : MIN_QTY;
  const qtyBadge = qty > MIN_QTY ? `<span class="qtybadge">&times;${qty}</span>` : '';
  const stepper = `<span class="qty" role="group" aria-label="How many">`
    + `<button class="qminus" data-qty="${esc(item.id)}" data-delta="-1"`
    + `${qty <= MIN_QTY ? ' disabled' : ''} aria-label="One fewer">&minus;</button>`
    + `<span class="qnum" aria-live="polite">${qty}</span>`
    + `<button class="qplus" data-qty="${esc(item.id)}" data-delta="1"`
    + `${qty >= MAX_QTY ? ' disabled' : ''} aria-label="One more">+</button></span>`;

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
  const otherStore = storeId === 'sams' ? 'costco' : 'sams';
  const flaggedBoth = flagged && !!state.flags[flagKey(item.id, otherStore)]?.f;
  // The "try somewhere else" bucket, resolved against THIS list. It used to be
  // the words "Custom shop" hardcoded — which names a tab that may have been
  // renamed, or that this list may not have at all, and §3 forbids a dead end.
  const otherBucket = shopsFor(state).find((s) => s.id === 'custom');
  const flagRow = flagged
    ? `<div class="flagline" data-unflag="${esc(item.id)}">`
      + `<b>Not stocked here</b>${flagBy ? ' &middot; ' + esc(flagBy) : ''}`
      + (flaggedBoth && !item.custom && otherBucket
        ? ` &mdash; nobody can find it at either store, try moving it to ${esc(otherBucket.short)}` : '')
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

  return `<div class="item${item.custom ? ' cust' : ''}${st ? ' ' + st : ''}${flagged ? ' flagged' : ''}" data-id="${esc(item.id)}">`
    + `<div class="nm">${esc(text)}${frozen ? '<span class="frozen">FROZEN</span>' : ''}${qtyBadge}${whoTag}${stepper}${removeBtn}</div>`
    + body + flagRow
    + `<div class="acts" role="group" aria-label="${esc(text)}">`
    + `<button class="pxl ${st === 'got' ? 'on-got' : ''}" data-act="got" aria-pressed="${st === 'got'}">Got</button>`
    + `<button class="pxl ${st === 'swap' ? 'on-swap' : ''}" data-act="swap" aria-pressed="${st === 'swap'}">Swap</button>`
    + `<button class="pxl ${st === 'skip' ? 'on-skip' : ''}" data-act="skip" aria-pressed="${st === 'skip'}">Skip</button>`
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
