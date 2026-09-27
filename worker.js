// Classic (non-module) worker: no imports, self-contained, for maximum
// browser/extension compatibility. Keep buildDigits in sync with lib.js.
function buildDigits(L) {
  const N = Math.pow(10, L);
  const digits = new Uint8Array(N * L);
  for (let code = 0; code < N; code++) {
    let rem = code;
    for (let p = L - 1; p >= 0; p--) {
      digits[code * L + p] = rem % 10;
      rem = Math.floor(rem / 10);
    }
  }
  return digits;
}

// Both the 3- and 4-number games run on this one engine; the chosen length
// just means only candidates of that length are alive.
// Secrets are unified ids 0..10999 (0..999 = length-3, padded with NA_DIGIT
// in slot 4; 1000..10999 = length-4). Guesses are base-11 codes over 4
// slots (0 = not sent, 1-10 = a value) since guesses can be shorter than 4
// cards. Outcomes are bucketed by PERCENTAGE (relative to each candidate's
// own true length), not raw match count, since that's what the real result
// is. Cost tracking uses actual cards spent per guess (not a fixed L),
// since guess length now varies as a real strategic choice.
const UNIFIED_N3 = 1000;
const NA_DIGIT = 255;
const PCT3 = [0, 33, 67, 100];
const PCT4 = [0, 25, 50, 75, 100];
const UNIFIED_DEPTH_CAP = 40;

function buildUnifiedDigits() {
  const d3 = buildDigits(3);
  const d4 = buildDigits(4);
  const n4 = 10000;
  const unified = new Uint8Array((UNIFIED_N3 + n4) * 4);
  for (let c = 0; c < UNIFIED_N3; c++) {
    const base = c * 4;
    unified[base] = d3[c * 3];
    unified[base + 1] = d3[c * 3 + 1];
    unified[base + 2] = d3[c * 3 + 2];
    unified[base + 3] = NA_DIGIT;
  }
  for (let c = 0; c < n4; c++) {
    const base = (UNIFIED_N3 + c) * 4;
    unified[base] = d4[c * 4];
    unified[base + 1] = d4[c * 4 + 1];
    unified[base + 2] = d4[c * 4 + 2];
    unified[base + 3] = d4[c * 4 + 3];
  }
  return unified;
}

function decodeGuessCode(code, gv) {
  let rem = code;
  let cost = 0;
  for (let p = 3; p >= 0; p--) {
    const v = rem % 11;
    rem = (rem / 11) | 0;
    gv[p] = v === 0 ? -1 : v - 1;
    if (v !== 0) cost++;
  }
  return cost;
}

const SCARCITY_EPS = 1e-9;

function findBestGuessUnified(candidateIds, guessCodes, unifiedDigits, inventory) {
  let bestGuess = guessCodes[0];
  let bestWorst = Infinity, bestSumSq = Infinity, bestCost = Infinity, bestScarcity = Infinity, bestValueSum = Infinity;
  const counts = new Int32Array(101);
  const gv = new Int8Array(4);
  // Each card spent weighs 1/(how many of it you have): with 20 2s and 10 1s,
  // a 2 weighs half as much as a 1. Unlimited cards weigh 0.
  const weight = new Float64Array(10);
  // Clamped: the projection can spend a card down to 0 or below, which must
  // still weigh the most, not divide by zero or go negative.
  if (inventory) for (let v = 0; v < 10; v++) weight[v] = 1 / Math.max(inventory[v], 0.5);

  for (let gi = 0; gi < guessCodes.length; gi++) {
    const g = guessCodes[gi];
    const cost = decodeGuessCode(g, gv);
    counts.fill(0);

    for (let si = 0; si < candidateIds.length; si++) {
      const id = candidateIds[si];
      const base = id * 4;
      let m = 0;
      if (gv[0] >= 0 && gv[0] === unifiedDigits[base]) m++;
      if (gv[1] >= 0 && gv[1] === unifiedDigits[base + 1]) m++;
      if (gv[2] >= 0 && gv[2] === unifiedDigits[base + 2]) m++;
      if (gv[3] >= 0 && gv[3] === unifiedDigits[base + 3]) m++;
      const pct = id < UNIFIED_N3 ? PCT3[m] : PCT4[m];
      counts[pct]++;
    }

    let worst = 0, sumSq = 0;
    for (let pc = 0; pc <= 100; pc++) { const c = counts[pc]; if (c > worst) worst = c; sumSq += c * c; }

    // Tie-breaks only (never overrides a better split): first spend the cards
    // you have most of, then lower card values (with unlimited inventory every
    // card weighs 0, so this falls straight through to lower values).
    let scarcity = 0, valueSum = 0;
    for (let p = 0; p < 4; p++) if (gv[p] >= 0) { scarcity += weight[gv[p]]; valueSum += gv[p]; }

    const sameSplit = worst === bestWorst && sumSq === bestSumSq && cost === bestCost;
    const better =
      worst < bestWorst ||
      (worst === bestWorst && sumSq < bestSumSq) ||
      (worst === bestWorst && sumSq === bestSumSq && cost < bestCost) ||
      (sameSplit && scarcity < bestScarcity - SCARCITY_EPS) ||
      (sameSplit && Math.abs(scarcity - bestScarcity) < SCARCITY_EPS && valueSum < bestValueSum);

    if (better) { bestWorst = worst; bestSumSq = sumSq; bestCost = cost; bestScarcity = scarcity; bestValueSum = valueSum; bestGuess = g; }
  }

  return { bestGuess, worst: bestWorst, sumSq: bestSumSq };
}

function partitionByGuessUnified(candidateIds, guessCode, unifiedDigits) {
  const buckets = new Array(101);
  const gv = new Int8Array(4);
  decodeGuessCode(guessCode, gv);

  for (let si = 0; si < candidateIds.length; si++) {
    const id = candidateIds[si];
    const base = id * 4;
    let m = 0;
    if (gv[0] >= 0 && gv[0] === unifiedDigits[base]) m++;
    if (gv[1] >= 0 && gv[1] === unifiedDigits[base + 1]) m++;
    if (gv[2] >= 0 && gv[2] === unifiedDigits[base + 2]) m++;
    if (gv[3] >= 0 && gv[3] === unifiedDigits[base + 3]) m++;
    const pct = id < UNIFIED_N3 ? PCT3[m] : PCT4[m];
    if (!buckets[pct]) buckets[pct] = [];
    buckets[pct].push(id);
  }
  return buckets;
}

function guessCardCost(code) {
  const gv = new Int8Array(4);
  return decodeGuessCode(code, gv);
}

// Same base-11 guess encoding as lib.js, duplicated here since the worker
// can't import modules.
function valuesToGuessCodeW(values) {
  let code = 0;
  for (let p = 0; p < 4; p++) {
    const v = values[p];
    code = code * 11 + (v === null || v === undefined ? 0 : v);
  }
  return code;
}

// All PREFIX-shaped guess codes affordable within `inventory` (see lib.js's
// feasibleGuessCodes — kept in sync, duplicated because the worker can't
// import modules).
function feasibleGuessCodesW(inventory, maxCards) {
  const result = [];
  const used = new Array(10);
  const values = new Array(4).fill(null);
  for (let k = 1; k <= maxCards; k++) {
    const total = Math.pow(10, k);
    for (let combo = 0; combo < total; combo++) {
      used.fill(0);
      let rem = combo;
      let ok = true;
      for (let p = k - 1; p >= 0; p--) {
        const v = (rem % 10) + 1;
        rem = Math.floor(rem / 10);
        values[p] = v;
        used[v - 1]++;
        if (used[v - 1] > inventory[v - 1]) { ok = false; break; }
      }
      for (let p = k; p < 4; p++) values[p] = null;
      if (ok) result.push(valuesToGuessCodeW(values));
    }
  }
  return result;
}

// Whether the given candidate's own values (its true length) could actually
// be submitted with what's left in `inventory` — the game still requires
// sending the final answer, so if it uses a digit you've run dry on, you're
// stuck even though the secret is known.
function candidateAffordable(id, unifiedDigits, inventory) {
  const len = id < UNIFIED_N3 ? 3 : 4;
  const base = id * 4;
  const used = new Int32Array(10);
  for (let p = 0; p < len; p++) used[unifiedDigits[base + p]]++;
  for (let v = 0; v < 10; v++) if (used[v] > inventory[v]) return false;
  return true;
}

// Chance of fully resolving the round: plays the same guess this app would
// suggest at every step (best guess among what's actually affordable), and
// follows every branch of results, tracking cards actually spent along each
// path. A candidate only counts as "solvable" if every guess along the way
// was affordable AND the final answer itself is affordable at the end.
function analyzeOddsUnified(candidateIds, inventory, unifiedDigits, L, depth) {
  const n = candidateIds.length;
  if (n === 0) return { solvable: 0, total: 0, capped: false };
  if (n === 1) {
    return { solvable: candidateAffordable(candidateIds[0], unifiedDigits, inventory) ? 1 : 0, total: 1, capped: false };
  }
  if (depth >= UNIFIED_DEPTH_CAP) return { solvable: 0, total: n, capped: true };

  let unlimited = true;
  for (let v = 0; v < 10; v++) if (inventory[v] !== Infinity) { unlimited = false; break; }
  if (unlimited) return { solvable: n, total: n, capped: false };

  const guessCodes = feasibleGuessCodesW(inventory, L);
  if (guessCodes.length === 0) return { solvable: 0, total: n, capped: false };

  const { bestGuess } = findBestGuessUnified(candidateIds, guessCodes, unifiedDigits, inventory);
  const gv = new Int8Array(4);
  decodeGuessCode(bestGuess, gv);
  const nextInventory = inventory.slice();
  for (let p = 0; p < 4; p++) if (gv[p] >= 0) nextInventory[gv[p]]--;

  const buckets = partitionByGuessUnified(candidateIds, bestGuess, unifiedDigits);
  let solvable = 0, capped = false;
  for (let pct = 0; pct < buckets.length; pct++) {
    const b = buckets[pct];
    if (!b || b.length === 0) continue;
    if (pct === 100) { solvable += b.length; continue; } // the guess itself was the answer
    const sub = analyzeOddsUnified(b, nextInventory, unifiedDigits, L, depth + 1);
    solvable += sub.solvable;
    if (sub.capped) capped = true;
  }
  return { solvable, total: n, capped };
}

// Same idea as analyzeTree, but tracks actual CARDS spent along each path
// (not guess count), since guess cost varies here.
function analyzeTreeUnified(candidateIds, guessCodes, unifiedDigits, depth, inventory) {
  if (candidateIds.length === 0) return { worstCards: 0, expectedCards: 0, capped: false };
  if (candidateIds.length === 1) {
    // Single answer left: sending it costs its true length in cards.
    const finalCost = candidateIds[0] < UNIFIED_N3 ? 3 : 4;
    return { worstCards: finalCost, expectedCards: finalCost, capped: false };
  }
  if (depth >= UNIFIED_DEPTH_CAP) return { worstCards: 0, expectedCards: 0, capped: true };

  const { bestGuess } = findBestGuessUnified(candidateIds, guessCodes, unifiedDigits, inventory);
  const cost = guessCardCost(bestGuess);
  const buckets = partitionByGuessUnified(candidateIds, bestGuess, unifiedDigits);
  const n = candidateIds.length;
  // Spend the guess's cards so deeper tie-breaks see what's actually left.
  let nextInventory = inventory;
  if (inventory) {
    const gv = new Int8Array(4);
    decodeGuessCode(bestGuess, gv);
    nextInventory = inventory.slice();
    for (let p = 0; p < 4; p++) if (gv[p] >= 0) nextInventory[gv[p]]--;
  }

  let worstCards = 0, expectedCards = 0, capped = false;
  for (let pct = 0; pct < buckets.length; pct++) {
    const b = buckets[pct];
    if (!b || b.length === 0) continue;
    // 100% means the game accepted it — that guess was the answer, already paid for.
    const sub = pct === 100
      ? { worstCards: 0, expectedCards: 0, capped: false }
      : analyzeTreeUnified(b, guessCodes, unifiedDigits, depth + 1, nextInventory);
    const branchCards = cost + sub.worstCards;
    if (branchCards > worstCards) worstCards = branchCards;
    expectedCards += (b.length / n) * (cost + sub.expectedCards);
    if (sub.capped) capped = true;
  }
  return { worstCards, expectedCards, capped };
}

self.onmessage = (e) => {
  const { type, candidateCodes, guessCodes, requestId, inventory, L } = e.data;
  const unifiedDigits = buildUnifiedDigits();

  if (type === 'analysis') {
    const { worstCards, expectedCards, capped } = analyzeTreeUnified(candidateCodes, guessCodes, unifiedDigits, 0, inventory);
    self.postMessage({ type: 'analysis', requestId, worstCards, expectedCards, capped });
    return;
  }

  if (type === 'odds') {
    const { solvable, total, capped } = analyzeOddsUnified(candidateCodes, inventory, unifiedDigits, L, 0);
    self.postMessage({ type: 'odds', requestId, solvable, total, capped });
    return;
  }

  const { bestGuess, worst, sumSq } = findBestGuessUnified(candidateCodes, guessCodes, unifiedDigits, inventory);
  self.postMessage({ type: 'suggest', requestId, bestGuess, worst, sumSq });
};
