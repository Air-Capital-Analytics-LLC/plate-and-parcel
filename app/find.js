/**
 * find.js — forgiving item search. Pure, deterministic, no I/O, no state.
 *
 * Borrowed from Quill & Chain's `bookmatch.py` (same author), which is the one
 * place that bot decides whether two titles are the same book. Three things come
 * across unchanged in spirit: FOLD before comparing (accents and case), delete
 * apostrophes rather than spacing them, and judge a typo with difflib's
 * `SequenceMatcher.ratio` against the same "typo's width" line, 0.85.
 *
 * ONE THING DOES NOT COME ACROSS, and it is the difference between the jobs.
 * Quill & Chain compares a FINISHED title against a finished title, so a whole-
 * string ratio is the right question there. Here somebody is typing into a box,
 * one letter at a time: "chick" against "Chicken thighs" scores 0.53 whole-
 * string and would be a miss at every keystroke until the last. So the question
 * is asked WORD BY WORD instead - every word typed must land on some word of the
 * item (the whole-word subset rule Quill & Chain uses for author names), and a
 * word lands if it is the same word, the start of one, part of one, or a typo's
 * width from one.
 *
 * `difflib` is ported rather than approximated, because "the same threshold as
 * Quill & Chain" means nothing if the ratio underneath is a different function.
 * `tests/v39_probe.mjs` holds it to numbers Python's own difflib produced.
 */

/*
 * A typo's width. Quill & Chain's NAME_TYPO: one or two letters wrong in a word
 * of four or more. Measured there on real member input before it was fixed.
 * "chiken" ~ "chicken" 0.92, "brocoli" ~ "broccoli" 0.93, "cofee" ~ "coffee"
 * 0.91 - while "milk" ~ "silk" is 0.75 and stays a miss.
 */
export const TYPO = 0.85;

/*
 * Words shorter than this never match on a typo. Quill & Chain draws the same
 * line at four letters for surnames, for the same reason: at three letters one
 * wrong letter is a third of the word, and "egg" ~ "leg" is not a typo.
 */
const TYPO_MIN = 4;

/* ---------- difflib.SequenceMatcher(None, a, b).ratio(), ported ---------- */

/*
 * CODE POINTS, not UTF-16 units: Python iterates a str by code point, and a
 * name with an emoji in it would otherwise count as two characters here and one
 * there, and the ratio would quietly stop being difflib's.
 */
function chars(s) { return Array.from(s); }

/**
 * `ratio()` = 2*M / (len(a) + len(b)), where M is the total size of the
 * matching blocks difflib's Ratcliff/Obershelp search finds. Ported from
 * CPython's `find_longest_match` and `get_matching_blocks` with `isjunk=None`
 * and `autojunk=True`, which is what `SequenceMatcher(None, a, b)` means.
 */
export function ratio(a, b) {
  const A = chars(a), B = chars(b);
  const la = A.length, lb = B.length;
  if (la + lb === 0) return 1;

  // b2j: where each character of b occurs. "Popular" characters - more than
  // 1% of a b at least 200 long - are dropped, exactly as difflib's autojunk
  // does. Never reached by a shopping-list name; kept so the port is the port.
  const b2j = new Map();
  B.forEach((c, j) => { const l = b2j.get(c); if (l) l.push(j); else b2j.set(c, [j]); });
  if (lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [c, l] of [...b2j]) if (l.length > ntest) b2j.delete(c);
  }

  function longest(alo, ahi, blo, bhi) {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (const j of (b2j.get(A[i]) || [])) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = next;
    }
    // difflib extends the best match across characters autojunk removed from
    // b2j. With isjunk=None nothing is ever "junk", so its second pair of
    // loops (the junk-only extension) can never run and is omitted.
    while (besti > alo && bestj > blo && A[besti - 1] === B[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && A[besti + bestsize] === B[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  let matched = 0;
  const queue = [[0, la, 0, lb]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (!k) continue;
    matched += k;
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  return (2 * matched) / (la + lb);
}

/* ---------- folding ---------- */

/**
 * Accent- and case-folded, punctuation-free, whitespace-collapsed.
 *
 * Quill & Chain's `fold` plus its `apostrophe_key`: apostrophes are DELETED,
 * not turned into spaces, so "Sam's" is "sams" and not "sam s" - otherwise
 * typing "sams" would miss it. `&` reads as "and", so "Mac & cheese" and
 * "mac and cheese" are the same words.
 */
/*
 * BUILT FROM CODE POINTS, and this is a receipt, not a style choice. The first
 * cut wrote these as `\u` escapes inside the regex literals, and the tool that
 * saved the file turned them into the raw characters - an invisible combining
 * accent and three look-alike quotes, in a file that still worked. Invisible
 * in an editor, and one re-encode away from silently matching something else.
 * The rulebook's heredoc rule (§7) is the same lesson: program text must not
 * pass through something that interprets it. Numbers survive every tool.
 */
const ACCENTS = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');
const APOSTROPHES = new RegExp(`['${String.fromCharCode(0x2019, 0x2018, 0x02bc)}]`, 'g');

export function fold(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(ACCENTS, '')                   // the accents NFKD just split off
    .toLowerCase()
    .replace(APOSTROPHES, '')               // every apostrophe a phone keyboard types
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function words(s) { const f = fold(s); return f ? f.split(' ') : []; }

/*
 * Plural to singular, crudely, and only for comparing. Shopping is plural-heavy
 * and a prefix does not cover the "-ies" case: "cherry" is not the start of
 * "cherries", and 0.71 is no typo. Wrong for "glasses" and right for "eggs",
 * "tomatoes" and "berries", which is the trade a grocery list wants.
 */
function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /(?:[sxz]|ch|sh|o)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * How well one typed word lands on one word of an item, 0 for not at all.
 *
 * Ordered by how sure the match is, so the ranking puts "milk" above
 * "buttermilk" above "mlik". The typo test compares against the item word CUT
 * to the typed length, and one longer, as well as whole - because the person is
 * mid-word: "chik" is 0.73 against "chicken" and 0.89 against "chick".
 */
function wordScore(q, w) {
  if (w === q || stem(w) === stem(q)) return 1;
  if (w.startsWith(q)) return 0.9;
  if (q.length >= 3 && w.includes(q)) return 0.7;
  if (q.length < TYPO_MIN) return 0;
  const r = Math.max(ratio(q, w), ratio(q, w.slice(0, q.length)), ratio(q, w.slice(0, q.length + 1)));
  return r >= TYPO ? 0.6 * r : 0;
}

/**
 * A matcher for one query, or null when there is nothing to search for.
 *
 * Built once per paint and asked about every row, so the query is folded once
 * rather than once per row. Returns a score in (0, 1] for a match and 0 for a
 * miss. EVERY typed word must land somewhere - "chicken thighs" does not match
 * "chicken breast" - and a word landing only in the small print (the pack, the
 * note) counts for half, so the name decides the order.
 */
export function matcher(query) {
  const qs = words(query);
  if (!qs.length) return null;
  return (name, extra = '') => {
    const main = words(name);
    const small = words(extra);
    let total = 0;
    for (const q of qs) {
      let best = 0;
      for (const w of main) { const s = wordScore(q, w); if (s > best) best = s; if (best === 1) break; }
      if (best < 1) for (const w of small) { const s = wordScore(q, w) / 2; if (s > best) best = s; }
      if (!best) return 0;
      total += best;
    }
    return total / qs.length;
  };
}
