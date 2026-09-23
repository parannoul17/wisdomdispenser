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

self.onmessage = (e) => {
  const { type, candidateCodes, guessCodes, L, requestId } = e.data;
  const digits = buildDigits(L);

  if (type === 'analysis') {
    const { worstDepth, expected, capped } = analyzeTree(candidateCodes, guessCodes, digits, L, 0);
    self.postMessage({ type: 'analysis', requestId, worstDepth, expected, capped });
    return;
  }

  const { bestGuess, worst, sumSq } = findBestGuess(candidateCodes, guessCodes, digits, L);
  self.postMessage({ type: 'suggest', requestId, bestGuess, worst, sumSq });
};
