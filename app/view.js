/**
 * view.js — pure projection of (DATA + state) to markup.
 *
 * Nothing here mutates state or touches the network. `buildGroups` is the one
 * place that decides what a store's list contains, so the tab counts, the list,
 * and the trip report can never disagree about what is on it.
 */

import { DATA } from './data.js';
import { STATUSES, MIN_QTY, MAX_QTY } from './store.js';

export const flagKey = (itemId, storeId) => itemId + '@' + storeId;

export const STORES = [
  { id: 'sams', label: "Sam's Club", short: "Sam's" },
  { id: 'costco', label: 'Costco', short: 'Costco' },
  { id: 'custom', label: 'Custom shop', short: 'Custom' },
];

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
export function buildGroups(state, storeId) {
  // Never index blind. A corrupt `ui.store` reaching here threw on every paint,
  // which the renderer's catch then turned into a permanent error card offering
  // a recovery that could not work.
  const base = baseGroups()[storeId] || baseGroups().sams;
  const out = base.slice();
  const mine = [];
  for (const id of Object.keys(state.added)) {
    const a = state.added[id];
    if (!a || a.del || a.store !== storeId) continue;
    mine.push({ id, name: a.name, detail: a.note || '', mine: true, by: a.by });
  }
  if (mine.length) {
    mine.sort((x, y) => (state.added[x.id].t || 0) - (state.added[y.id].t || 0));
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
  return STORES.map((s) => {
    const c = counts(state, s.id);
    return `<button class="pxl tab${state.ui.store === s.id ? ' on' : ''}" data-store="${s.id}">`
      + `${esc(s.short)}<span class="n">${c.done}/${c.total}</span></button>`;
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
  const removeBtn = item.mine
    ? `<button class="rm" data-edit="${esc(item.id)}" aria-label="Edit or remove ${esc(text)}">&#9998;</button>` : '';

  // A persistent correction to the list, not a trip outcome. It survives
  // "Start a new trip", says who reported it, and the row is never removed —
  // one shopper failing to find something is not proof the store never has it.
  const flagged = !!state.flags[flagKey(item.id, storeId)]?.f;
  const flagBy = state.flags[flagKey(item.id, storeId)]?.by || '';
  const otherStore = storeId === 'sams' ? 'costco' : 'sams';
  const flaggedBoth = flagged && !!state.flags[flagKey(item.id, otherStore)]?.f;
  const flagRow = flagged
    ? `<div class="flagline" data-unflag="${esc(item.id)}">`
      + `<b>Not stocked here</b>${flagBy ? ' &middot; ' + esc(flagBy) : ''}`
      + (flaggedBoth && !item.custom ? ' &mdash; flagged at both clubs, consider moving it to Custom shop' : '')
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
      html = c.total === 0
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

  for (const s of STORES) {
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
