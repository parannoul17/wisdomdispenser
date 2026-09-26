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

function findBestGuessUnified(candidateIds, guessCodes, unifiedDigits) {
  let bestGuess = guessCodes[0];
  let bestWorst = Infinity, bestSumSq = Infinity, bestCost = Infinity, bestValueSum = Infinity;
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

    // Last tie-break: lower card values first (lower numbers are the ones you
    // usually have more of). Only decides between otherwise-equal guesses.
    let valueSum = 0;
    for (let p = 0; p < 4; p++) if (gv[p] >= 0) valueSum += gv[p];

    const better =
      worst < bestWorst ||
      (worst === bestWorst && sumSq < bestSumSq) ||
      (worst === bestWorst && sumSq === bestSumSq && cost < bestCost) ||
      (worst === bestWorst && sumSq === bestSumSq && cost === bestCost && valueSum < bestValueSum);

    if (better) { bestWorst = worst; bestSumSq = sumSq; bestCost = cost; bestValueSum = valueSum; bestGuess = g; }
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
  if (candidateIds.length === 0) return { worstCards: 0, expectedCards: 0, capped: false };
  if (candidateIds.length === 1) {
    // Single answer left: sending it costs its true length in cards.
    const finalCost = candidateIds[0] < UNIFIED_N3 ? 3 : 4;
    return { worstCards: finalCost, expectedCards: finalCost, capped: false };
  }
  if (depth >= UNIFIED_DEPTH_CAP) return { worstCards: 0, expectedCards: 0, capped: true };

  const { bestGuess } = findBestGuessUnified(candidateIds, guessCodes, unifiedDigits);
  const cost = guessCardCost(bestGuess);
  const buckets = partitionByGuessUnified(candidateIds, bestGuess, unifiedDigits);
  const n = candidateIds.length;

  let worstCards = 0, expectedCards = 0, capped = false;
  for (let pct = 0; pct < buckets.length; pct++) {
    const b = buckets[pct];
    if (!b || b.length === 0) continue;
    // 100% means the game accepted it — that guess was the answer, already paid for.
    const sub = pct === 100
      ? { worstCards: 0, expectedCards: 0, capped: false }
      : analyzeTreeUnified(b, guessCodes, unifiedDigits, depth + 1);
    const branchCards = cost + sub.worstCards;
    if (branchCards > worstCards) worstCards = branchCards;
    expectedCards += (b.length / n) * (cost + sub.expectedCards);
    if (sub.capped) capped = true;
  }
  return { worstCards, expectedCards, capped };
}

self.onmessage = (e) => {
  const { type, candidateCodes, guessCodes, requestId } = e.data;
  const unifiedDigits = buildUnifiedDigits();

  if (type === 'analysis') {
    const { worstCards, expectedCards, capped } = analyzeTreeUnified(candidateCodes, guessCodes, unifiedDigits, 0);
    self.postMessage({ type: 'analysis', requestId, worstCards, expectedCards, capped });
    return;
  }

  const { bestGuess, worst, sumSq } = findBestGuessUnified(candidateCodes, guessCodes, unifiedDigits);
  self.postMessage({ type: 'suggest', requestId, bestGuess, worst, sumSq });
};
