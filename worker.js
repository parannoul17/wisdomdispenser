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

// Finds the guess (from guessCodes) that minimizes the worst-case number of
// remaining candidates after the result comes back, Knuth-style minimax.
// Ties broken by: smaller sum-of-squares (fewer expected remaining candidates),
// then a guess that is itself still a possible secret, then more distinct
// digits (purely cosmetic — under this position-only-match feedback, the
// match-count distribution for a guess doesn't depend on which values it
// uses, only distinct-value guesses just read more naturally to a person).
function findBestGuess(candidateCodes, guessCodes, digits, L) {
  const candSet = new Set(candidateCodes);
  const counts = new Int32Array(L + 1);

  let bestGuess = guessCodes[0];
  let bestWorst = Infinity;
  let bestSumSq = Infinity;
  let bestIsCand = false;
  let bestDistinct = -1;

  for (let gi = 0; gi < guessCodes.length; gi++) {
    const g = guessCodes[gi];
    counts.fill(0);
    const gBase = g * L;
    for (let si = 0; si < candidateCodes.length; si++) {
      const sBase = candidateCodes[si] * L;
      let m = 0;
      for (let p = 0; p < L; p++) if (digits[gBase + p] === digits[sBase + p]) m++;
      counts[m]++;
    }
    let worst = 0, sumSq = 0;
    for (let k = 0; k <= L; k++) { const c = counts[k]; if (c > worst) worst = c; sumSq += c * c; }
    const isCand = candSet.has(g);

    const seen = new Set();
    for (let p = 0; p < L; p++) seen.add(digits[gBase + p]);
    const distinct = seen.size;

    const better =
      worst < bestWorst ||
      (worst === bestWorst && sumSq < bestSumSq) ||
      (worst === bestWorst && sumSq === bestSumSq && isCand && !bestIsCand) ||
      (worst === bestWorst && sumSq === bestSumSq && isCand === bestIsCand && distinct > bestDistinct);

    if (better) {
      bestWorst = worst; bestSumSq = sumSq; bestIsCand = isCand; bestDistinct = distinct; bestGuess = g;
    }
  }

  return { bestGuess, worst: bestWorst, sumSq: bestSumSq };
}

function partitionByGuess(candidateCodes, guessCode, digits, L) {
  const buckets = [];
  for (let k = 0; k <= L; k++) buckets.push([]);
  const gBase = guessCode * L;
  for (const c of candidateCodes) {
    const cBase = c * L;
    let m = 0;
    for (let p = 0; p < L; p++) if (digits[gBase + p] === digits[cBase + p]) m++;
    buckets[m].push(c);
  }
  return buckets;
}

// Exact analysis of the full decision tree this greedy (locally-minimax)
// strategy produces from here: at every node it picks the guess findBestGuess
// would pick, branches into every non-empty outcome bucket (not just the
// largest one), and recurses into ALL of them. `worstDepth` is the true
// number of additional guesses needed in the worst case — since every
// branch is explored, this is a real upper bound, and it can only decrease
// (or hold) as real results come in, because the real outcome is always one
// of the branches already accounted for here. `expected` is the exact
// (probability-weighted) average number of additional guesses.
// Cost is bounded rather than exponential: candidates only ever get
// partitioned, never duplicated, so the total candidates handled at any
// single depth across all branches together is capped at the size of the
// original candidate set — the tree gets bushier as it gets deeper, but each
// level does a roughly constant amount of total work.
const DEPTH_CAP = 25;

function analyzeTree(candidateCodes, guessCodes, digits, L, depth) {
  if (candidateCodes.length <= 1) return { worstDepth: 0, expected: 0, capped: false };
  if (depth >= DEPTH_CAP) return { worstDepth: 0, expected: 0, capped: true };

  const { bestGuess } = findBestGuess(candidateCodes, guessCodes, digits, L);
  const buckets = partitionByGuess(candidateCodes, bestGuess, digits, L);
  const n = candidateCodes.length;

  let worstDepth = 0;
  let expected = 0;
  let capped = false;
  for (const b of buckets) {
    if (b.length === 0) continue; // an outcome with zero candidates can't actually happen
    const sub = analyzeTree(b, guessCodes, digits, L, depth + 1);
    const branchDepth = 1 + sub.worstDepth;
    if (branchDepth > worstDepth) worstDepth = branchDepth;
    expected += (b.length / n) * (1 + sub.expected);
    if (sub.capped) capped = true;
  }
  return { worstDepth, expected, capped };
}

// --- "Not sure (3 or 4)" mode ---
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

function findBestGuessUnified(candidateIds, guessCodes, unifiedDigits) {
  let bestGuess = guessCodes[0];
  let bestWorst = Infinity, bestSumSq = Infinity, bestCost = Infinity, bestDistinct = -1;
  const counts = new Int32Array(101);
  const gv = new Int8Array(4);

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

    const seen = new Set();
    for (let p = 0; p < 4; p++) if (gv[p] >= 0) seen.add(gv[p]);
    const distinct = seen.size;

    const better =
      worst < bestWorst ||
      (worst === bestWorst && sumSq < bestSumSq) ||
      (worst === bestWorst && sumSq === bestSumSq && cost < bestCost) ||
      (worst === bestWorst && sumSq === bestSumSq && cost === bestCost && distinct > bestDistinct);

    if (better) { bestWorst = worst; bestSumSq = sumSq; bestCost = cost; bestDistinct = distinct; bestGuess = g; }
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

// Same idea as analyzeTree, but tracks actual CARDS spent along each path
// (not guess count), since guess cost varies here.
function analyzeTreeUnified(candidateIds, guessCodes, unifiedDigits, depth) {
  if (candidateIds.length <= 1) return { worstCards: 0, expectedCards: 0, capped: false };
  if (depth >= UNIFIED_DEPTH_CAP) return { worstCards: 0, expectedCards: 0, capped: true };

  const { bestGuess } = findBestGuessUnified(candidateIds, guessCodes, unifiedDigits);
  const cost = guessCardCost(bestGuess);
  const buckets = partitionByGuessUnified(candidateIds, bestGuess, unifiedDigits);
  const n = candidateIds.length;

  let worstCards = 0, expectedCards = 0, capped = false;
  for (const b of buckets) {
    if (!b || b.length === 0) continue;
    const sub = analyzeTreeUnified(b, guessCodes, unifiedDigits, depth + 1);
    const branchCards = cost + sub.worstCards;
    if (branchCards > worstCards) worstCards = branchCards;
    expectedCards += (b.length / n) * (cost + sub.expectedCards);
    if (sub.capped) capped = true;
  }
  return { worstCards, expectedCards, capped };
}

self.onmessage = (e) => {
  const { type, mode, candidateCodes, guessCodes, L, requestId } = e.data;

  if (mode === 'unified') {
    const unifiedDigits = buildUnifiedDigits();
    if (type === 'analysis') {
      const { worstCards, expectedCards, capped } = analyzeTreeUnified(candidateCodes, guessCodes, unifiedDigits, 0);
      self.postMessage({ type: 'analysis', requestId, worstCards, expectedCards, capped });
      return;
    }
    const { bestGuess, worst, sumSq } = findBestGuessUnified(candidateCodes, guessCodes, unifiedDigits);
    self.postMessage({ type: 'suggest', requestId, bestGuess, worst, sumSq });
    return;
  }

  const digits = buildDigits(L);

  if (type === 'analysis') {
    const { worstDepth, expected, capped } = analyzeTree(candidateCodes, guessCodes, digits, L, 0);
    self.postMessage({ type: 'analysis', requestId, worstDepth, expected, capped });
    return;
  }

  const { bestGuess, worst, sumSq } = findBestGuess(candidateCodes, guessCodes, digits, L);
  self.postMessage({ type: 'suggest', requestId, bestGuess, worst, sumSq });
};
