/**
 * sync.js — Repository seam over Firebase Realtime Database.
 *
 * Deliberately uses RTDB's REST + SSE surface rather than the Firebase SDK:
 *
 *  - No CDN dependency, so a dead network cannot leave the page half-built.
 *  - The SDK's web build keeps its pending-write queue in memory only; it does
 *    not survive the tab being killed. In a store that is exactly when writes
 *    get lost, so the durable outbox lives in the store and this module is a
 *    dumb pipe over it.
 *
 * Nothing here knows about encryption. `codec` is injected, so the transport
 * can be swapped (Supabase, a Worker, a mock in tests) without touching it.
 * The codec is handed the slot each record belongs to so it can bind a seal to
 * its position and reject one that has been moved.
 */

import { KINDS } from './store.js';

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;
const WRITE_TIMEOUT = 12000;

/** A read on the boot path. Short, because nothing is blocked waiting for it
 *  except a user staring at a list that has not appeared yet. */
const READ_TIMEOUT = 4000;

/** How long a stream must survive before we believe it. See `connect`. */
const STABLE_AFTER = 15000;

/** No traffic for this long, on a stream that still claims to be open, means
 *  the socket died silently while the phone was in a pocket. */
const STALE_AFTER = 45000;

/** How long to wait for a simultaneous identity claim before settling one.
 *  Paid once, on the first-ever open of a list, and never again. */
const CLAIM_SETTLE_MS = 1500;

export const Status = {
  OFFLINE: 'offline',
  CONNECTING: 'connecting',
  LIVE: 'live',
  ERROR: 'error',
};

/**
 * @param {object}  o
 * @param {string}  o.dbUrl    e.g. https://xyz-default-rtdb.firebaseio.com
 * @param {string}  o.listId
 * @param {{encode(rec,slot):Promise<any>, decode(wire,slot):Promise<any>}} o.codec
 * @param {(remote:{items?:object,added?:object})=>void} o.onRemote
 * @param {()=>void} [o.onEmptySnapshot] the shared list holds nothing
 * @param {()=>void} [o.onBeforeDrain]   last chance to touch queued work
 * @param {(status:string, detail?:object)=>void} o.onStatus
 */
export function createSync({ dbUrl, listId, codec, onRemote, onStatus, onEmptySnapshot, onBeforeDrain }) {
  const base = String(dbUrl).replace(/\/+$/, '');
  const root = `${base}/lists/${encodeURIComponent(listId)}`;

  let es = null;
  let stopped = true;
  let attempt = 0;
  let reconnectTimer = null;
  let stableTimer = null;
  let writeRetryTimer = null;
  let draining = false;
  let drainAgain = false;
  let lastMessageAt = 0;
  let sawFirstSnapshot = false;

  const setStatus = (s, d) => { try { onStatus(s, d); } catch { /* never let a listener break sync */ } };
  const slotFor = (kind, id) => `${listId}/${kind}/${id}`;

  /* ---------- inbound ---------- */

  async function decodeMap(wireMap, kind) {
    const out = Object.create(null);
    if (!wireMap || typeof wireMap !== 'object') return out;
    const ids = Object.keys(wireMap);
    const decoded = await Promise.all(ids.map((id) => codec.decode(wireMap[id], slotFor(kind, id))));
    for (let i = 0; i < ids.length; i++) {
      const rec = decoded[i];
      // A record we cannot read (wrong passphrase, older format, junk write,
      // or a seal lifted from another slot) is skipped rather than thrown: one
      // bad row must not stop the sync.
      if (rec && typeof rec === 'object') out[ids[i]] = rec;
    }
    return out;
  }

  /**
   * RTDB SSE delivers {path, data}. `path` is relative to the stream root, so
   * we normalise every shape into {items, added} before handing it upward.
   */
  async function applyEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const path = typeof payload.path === 'string' ? payload.path : '/';
    const data = payload.data;
    const segs = path.split('/').filter(Boolean);

    if (segs.length === 0) {
      // A root snapshot is the only moment we can tell "the shared list holds
      // nothing" from "we have not heard yet", so it is the only safe place to
      // detect loss. Emptiness is judged on the collections that represent real
      // shared work; `plan` and `flags` alone are not evidence the list exists.
      const noItems = !data || !data.items || !Object.keys(data.items).length;
      const noAdded = !data || !data.added || !Object.keys(data.added).length;
      if (data == null || (noItems && noAdded)) { onEmptySnapshot?.(); return; }

      // Only consumed once real data has actually arrived, and re-armed per
      // connection. Setting it above the empty-return burned the flag on a
      // snapshot that carried nothing, so the post-outage restamp this exists
      // to trigger never ran after a reconnect — its entire purpose.
      const first = !sawFirstSnapshot;
      sawFirstSnapshot = true;

      const remote = {};
      for (const k of KINDS) remote[k] = await decodeMap(data[k], k);
      onRemote(remote, { first });
      return;
    }

    const [kind, id] = segs;
    if (!KINDS.includes(kind)) return;   // meta/, or anything else

    if (segs.length === 1) {
      // `data == null` here is RTDB saying this whole subtree was deleted.
      // Merging an empty map would be a silent no-op and every connected phone
      // would keep rendering a list the server no longer has.
      if (data == null) { onEmptySnapshot?.(); return; }
      onRemote({ [kind]: await decodeMap(data, kind) }, {});
      return;
    }

    if (data == null) return;   // single-record delete: LWW tombstones carry state
    const rec = await codec.decode(data, slotFor(kind, id));
    if (rec && typeof rec === 'object') onRemote({ [kind]: { [id]: rec } }, {});
  }

  /* ---------- stream ---------- */

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    // Full jitter. With four clients there is no thundering herd to avoid, but
    // it stops a flapping tower producing a tight reconnect loop.
    const ceiling = Math.min(RECONNECT_MAX, RECONNECT_MIN * 2 ** attempt);
    const delay = Math.random() * ceiling;
    attempt = Math.min(attempt + 1, 6);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  function connect() {
    if (stopped) return;
    closeStream();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus(Status.OFFLINE);
      return;
    }
    setStatus(Status.CONNECTING);
    try {
      es = new EventSource(`${root}.json`);
    } catch {
      setStatus(Status.ERROR);
      scheduleReconnect();
      return;
    }

    const mine = es;
    lastMessageAt = Date.now();
    sawFirstSnapshot = false;   // the next root snapshot is "first" for this connection

    es.addEventListener('open', () => {
      setStatus(Status.LIVE);
      drain();
      // `open` fires when response HEADERS arrive, not when the stream proves
      // it can stay up. Resetting the backoff here meant a link that connects
      // and drops every few seconds could never leave attempt 0 — roughly 800
      // reconnects and ~17MB of cellular per trip, each one re-downloading the
      // whole list. Only believe the stream once it has survived a while.
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => { if (es === mine) attempt = 0; }, STABLE_AFTER);
    });

    const onData = (e) => {
      lastMessageAt = Date.now();
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      applyEvent(payload).catch(() => { /* a malformed record must not kill the stream */ });
    };
    es.addEventListener('put', onData);
    es.addEventListener('patch', onData);
    es.addEventListener('keep-alive', () => { lastMessageAt = Date.now(); });

    es.addEventListener('cancel', () => { setStatus(Status.ERROR, { reason: 'rules' }); });
    es.addEventListener('auth_revoked', () => { setStatus(Status.ERROR, { reason: 'auth' }); });

    es.addEventListener('error', () => {
      // EventSource retries on its own, but RTDB closes idle streams and the
      // native backoff is too eager; take it over.
      closeStream();
      setStatus(navigator.onLine === false ? Status.OFFLINE : Status.CONNECTING);
      scheduleReconnect();
    });
  }

  function closeStream() {
    clearTimeout(stableTimer);
    if (es) { try { es.close(); } catch { /* ignore */ } es = null; }
  }

  /* ---------- outbound ---------- */

  async function request(path, init, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      // `no-store`, always. These reads decide the list's identity and carry
      // live shared state; a cached answer is worse than no answer. A device
      // was observed adopting a stale `meta` — and a successful repair looking
      // like it had not happened — purely because the browser answered from
      // its own cache. Never depend on the server sending the right headers.
      const res = await fetch(path, { ...init, cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  function patch(kind, body) {
    return request(`${root}/${kind}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Genuinely used: the app drains on `visibilitychange -> hidden`, which is
      // exactly the unload-adjacent moment this flag exists for.
      keepalive: true,
    }, WRITE_TIMEOUT);
  }

  /**
   * Statuses that mean "the server read THIS body and refused it", so the other
   * collections are unaffected and still go.
   *
   * Deliberately NOT every 4xx. `429` means *back off*, and answering a rate
   * limit by immediately firing the remaining four kinds is the opposite of
   * what it asks for; `408` is a timeout wearing a status code. `403` is left
   * out too, because §0's warehouse wifi is exactly where a captive portal or a
   * corporate proxy serves a 403 that Firebase never saw — and a global refusal
   * misread as per-body turns one failed request into five. RTDB's real
   * per-record refusals are 400 (validation), 401 (rules) and 413 (too large).
   * Anything else — a timeout, a dropped socket, a 5xx — is the transport, and
   * on a dead link every remaining kind fails the same way.
   */
  const BODY_REJECTED = new Set([400, 401, 413]);

  function isBodyRejection(err) {
    const m = err && err.message ? String(err.message) : '';
    if (!m.startsWith('HTTP ')) return false;
    return BODY_REJECTED.has(Number(m.slice(5)));
  }

  let getOps = () => [];
  let ack = () => {};
  function bindOutbox(get, acknowledge) { getOps = get; ack = acknowledge; }

  /**
   * The WRITE path's own backoff counter. It deliberately does not share the
   * stream's `attempt`: that one is pinned back to 0 fifteen seconds after the
   * stream proves durable, and nothing on the write path ever raised it — so a
   * write that fails every single time retried at `random() * 1000`, averaging
   * half a second, for the whole trip, with no escalation. §4 requires backoff
   * to escalate on the failure mode that actually happens, and now that a
   * permanently-refused collection is a SUPPORTED state (see `drain`), that
   * failure mode is a designed one rather than a coincidence.
   */
  let writeAttempt = 0;

  function scheduleWriteRetry() {
    if (stopped || writeRetryTimer) return;
    const ceiling = Math.min(RECONNECT_MAX, RECONNECT_MIN * 2 ** writeAttempt);
    writeRetryTimer = setTimeout(() => { writeRetryTimer = null; drain(); }, Math.random() * ceiling);
  }

  async function drain() {
    if (stopped || draining) { drainAgain = true; return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    draining = true;
    try {
      onBeforeDrain?.();
      const ops = getOps();
      if (!ops.length) return;

      const byKind = {};
      const opsByKind = {};
      for (const k of KINDS) { byKind[k] = {}; opsByKind[k] = []; }
      const encoded = await Promise.all(ops.map((op) => codec.encode(op.rec, slotFor(op.kind, op.id))));
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        if (byKind[op.kind]) { byKind[op.kind][op.id] = encoded[i]; opsByKind[op.kind].push(op); }
      }

      // Ack each collection AS IT LANDS, never all of them at the end.
      //
      // Receipt: `ack(ops)` sat after this loop, so one refused collection left
      // the outbox still holding the ops for every collection that HAD been
      // written. Nothing ever cleared them, so the whole list was re-encrypted
      // and re-sent on every retry, for the rest of the trip — the same
      // cellular-burn shape as the ~800-reconnect receipt in §0. It was dormant
      // only because every kind here has a rules node; the first kind added
      // without one detonates it.
      let failed = null;
      for (const kind of KINDS) {
        const body = byKind[kind];
        if (!Object.keys(body).length) continue;
        try {
          await patch(kind, body);
        } catch (err) {
          failed = err;
          // A 4xx means the server read THIS body and refused it — a rules node
          // that was never deployed, or a record the rules reject. The other
          // collections are unaffected, so they still go. Anything else is the
          // transport, and on a dead link every remaining kind fails the same
          // way: stop asking rather than burn five more 12s timeouts in a
          // warehouse. Either way the ops stay queued and the badge says so —
          // a refused write is never silently dropped.
          if (isBodyRejection(err)) continue;
          break;
        }
        ack(opsByKind[kind]);
      }
      if (failed) throw failed;
      writeAttempt = 0;
      setStatus(Status.LIVE);
    } catch (err) {
      // Ops stay in the outbox. Retry on our OWN timer — a failed write must
      // never tear down a healthy read stream. Reads routinely survive
      // conditions that stall a fresh request, and rebuilding the stream costs
      // a full root snapshot and a full decrypt pass.
      //
      // `reason: 'rules'` matters: the badge reads `Retrying` for anything else,
      // and SETUP.md tells the household in those words that `Blocked` means the
      // database rules are rejecting writes. Without this, the one failure this
      // function was rewritten to survive sent them to the wrong page of their
      // own runbook.
      writeAttempt = Math.min(writeAttempt + 1, 5);
      setStatus(
        navigator.onLine === false ? Status.OFFLINE : Status.ERROR,
        isBodyRejection(err) ? { reason: 'rules' } : undefined,
      );
      scheduleWriteRetry();
    } finally {
      draining = false;
      if (drainAgain) { drainAgain = false; setTimeout(drain, 250); }
    }
  }

  /* ---------- meta (salt / passphrase check) ---------- */

  /**
   * @returns {Promise<{ok:boolean, meta:object|null}>}
   *
   * `ok` distinguishes "the list has no identity yet" from "we could not ask".
   * Collapsing those into a single `null` was the worst defect in this file: a
   * timeout on one person's first open looked identical to a brand-new list,
   * so they were invited to SET a passphrase, a fresh salt replaced the real
   * one, and every existing record became underivable. Nobody saw an error —
   * their own check verified, because they had typed the right passphrase.
   */
  async function readMeta() {
    try {
      const res = await request(`${root}/meta.json`, {}, READ_TIMEOUT);
      return { ok: true, meta: await res.json() };
    } catch {
      return { ok: false, meta: null };
    }
  }

  /**
   * Claim the list identity, or adopt whoever claimed it first.
   *
   * Throws rather than guessing when the list cannot be reached, and demands
   * both halves of an identity. A salt without a check is not an identity: it
   * cannot be verified, so adopting one lets anyone who can write to the node
   * silently re-key the whole list.
   */
  async function writeMetaIfAbsent(meta, clientId) {
    if (!meta || !meta.salt || !meta.check) throw new Error('meta needs salt and check');
    const before = await readMeta();
    if (!before.ok) throw new Error('unreachable');
    if (before.meta && before.meta.salt && before.meta.check) return before.meta;
    // A salt with no canary is a HALF-WRITTEN or tampered identity, not an
    // absent one. Treating it as absent let anyone delete just `check` and have
    // the next fresh device cheerfully claim a new salt, making every existing
    // record underivable.
    if (before.meta && before.meta.salt) throw new Error('tampered');

    /*
     * Claim, settle, publish — rather than write-then-hope.
     *
     * A plain write-then-reread is a TOCTOU: two people opening a brand-new
     * list within one round-trip of each other both read "absent", both write,
     * and each re-read can complete before the other's write lands. Both then
     * believe they won, seal records under different keys, and afterwards heal
     * the server in opposite directions forever. That is not a rare race here —
     * "set it up and text the link to the family" is the designed onboarding.
     *
     * Instead every device writes its claim under its own id and then everyone
     * adopts the lexicographically smallest claim. Each device computes the same
     * winner from the same set, so publishing it is idempotent and convergent
     * with no compare-and-swap, which RTDB's REST PATCH cannot give us.
     */
    const id = String(clientId || 'c' + Math.random().toString(36).slice(2, 10));
    await patch('meta/claims', { [id]: { salt: meta.salt, check: meta.check } });

    // Let a simultaneous claim land before settling.
    await new Promise((r) => setTimeout(r, CLAIM_SETTLE_MS));

    let claims = null;
    try {
      const res = await request(`${root}/meta/claims.json`, {}, READ_TIMEOUT);
      claims = await res.json();
    } catch { /* fall through to our own claim */ }

    let chosen = meta;
    if (claims && typeof claims === 'object') {
      const winner = Object.keys(claims).sort()[0];
      const c = winner && claims[winner];
      if (c && c.salt && c.check) chosen = { salt: c.salt, check: c.check };
    }

    await patch('meta', chosen).catch(() => {});
    const after = await readMeta();
    if (after.ok && after.meta && after.meta.salt && after.meta.check) return after.meta;
    return chosen;
  }

  /* ---------- lifecycle ---------- */

  const onlineHandler = () => { attempt = 0; connect(); drain(); };
  const offlineHandler = () => { closeStream(); setStatus(Status.OFFLINE); };
  const visibilityHandler = () => {
    if (document.visibilityState !== 'visible') return;
    if (!es && !reconnectTimer) { connect(); return; }
    // A backgrounded PWA's socket is routinely suspended without ever firing
    // `error`, so `es` stays non-null and readyState stays OPEN while nothing
    // arrives. The badge would keep saying Live for the rest of the trip.
    if (es && Date.now() - lastMessageAt > STALE_AFTER) { attempt = 0; connect(); }
  };

  function start() {
    if (!stopped) return;
    stopped = false;
    addEventListener('online', onlineHandler);
    addEventListener('offline', offlineHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
    connect();
  }

  function stop() {
    stopped = true;
    removeEventListener('online', onlineHandler);
    removeEventListener('offline', offlineHandler);
    document.removeEventListener('visibilitychange', visibilityHandler);
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearTimeout(writeRetryTimer); writeRetryTimer = null;
    closeStream();
  }

  /**
   * Overwrite the list identity unconditionally.
   *
   * Only ever called by a device that has just decrypted the canary with its
   * own cached identity — i.e. one that has PROVEN it holds the real one. A
   * `meta` nobody can verify is not an identity worth preserving, and leaving
   * it in place locks out every phone that joins afterwards while the devices
   * already unlocked carry on none the wiser.
   */
  async function forceWriteMeta(meta) {
    if (!meta || !meta.salt || !meta.check) throw new Error('meta needs salt and check');
    await patch('meta', meta);
    return meta;
  }

  return { start, stop, drain, bindOutbox, readMeta, writeMetaIfAbsent, forceWriteMeta, Status };
}
