// Shared logic for the main thread (app.js). The solver worker keeps its own
// copy of the search code since it can't import modules.

export function comboCount(L) {
  return Math.pow(10, L);
}

// Flat digit table: digits[code*L + pos] = digit (0-9) of `code` at `pos`.
export function buildDigits(L) {
  const N = comboCount(L);
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

// Counts of each value 1-10 (index 0 = value 1) used in a values array.
// Entries that are null/undefined (an unsent position) are skipped.
export function digitCounts(values) {
  const counts = new Array(10).fill(0);
  for (const v of values) if (v) counts[v - 1]++;
  return counts;
}

// --- Candidate model (used by every mode) ---
// The secret is length 3 or length 4 (a known length just restricts which
// candidates are alive). Both lengths live in one unified candidate space over 4 slots: ids 0..999 are length-3
// secrets (their 4th slot is NA_DIGIT — a value that can never match
// anything, since a real guess digit is always 0-9), ids 1000..10999 are
// length-4 secrets with all 4 slots real. Percentages are always relative
// to a candidate's OWN true length, which is what lets most results
// disambiguate which length it actually is.

export const NA_DIGIT = 255;
const UNIFIED_N3 = comboCount(3);
const UNIFIED_N4 = comboCount(4);

export function unifiedCandidateCount() {
  return UNIFIED_N3 + UNIFIED_N4;
}

export function trueLengthOf(id) {
  return id < UNIFIED_N3 ? 3 : 4;
}

export function allUnifiedCandidates() {
  const total = unifiedCandidateCount();
  const arr = new Array(total);
  for (let i = 0; i < total; i++) arr[i] = i;
  return arr;
}

export function buildUnifiedDigits() {
  const d3 = buildDigits(3);
  const d4 = buildDigits(4);
  const unified = new Uint8Array(unifiedCandidateCount() * 4);
  for (let c = 0; c < UNIFIED_N3; c++) {
    const base = c * 4;
    unified[base] = d3[c * 3];
    unified[base + 1] = d3[c * 3 + 1];
    unified[base + 2] = d3[c * 3 + 2];
    unified[base + 3] = NA_DIGIT;
  }
  for (let c = 0; c < UNIFIED_N4; c++) {
    const base = (UNIFIED_N3 + c) * 4;
    unified[base] = d4[c * 4];
    unified[base + 1] = d4[c * 4 + 1];
    unified[base + 2] = d4[c * 4 + 2];
    unified[base + 3] = d4[c * 4 + 3];
  }
  return unified;
}

export function percentFor(matches, length) {
  return Math.round((matches / length) * 100);
}

// A values array (length 4, each null or 1-10) against a unified secret id.
export function matchCountValuesUnified(guessValues, unifiedDigits, secretId) {
  const base = secretId * 4;
  let m = 0;
  for (let p = 0; p < 4; p++) {
    const gv = guessValues[p];
    if (gv === null || gv === undefined) continue;
    if (gv - 1 === unifiedDigits[base + p]) m++;
  }
  return m;
}

export function unifiedIdToValues(id, unifiedDigits) {
  const len = trueLengthOf(id);
  const base = id * 4;
  const values = new Array(len);
  for (let p = 0; p < len; p++) values[p] = unifiedDigits[base + p] + 1;
  return values;
}

// Guess codes: base-11 encoding over 4 slots, each 0 (not sent) or 1-10.
// Guesses can leave slots blank (cost fewer cards), unlike secrets, which
// are always fully filled for their own true length — hence the separate
// encoding from candidate ids.
export function valuesToGuessCode(values) {
  let code = 0;
  for (let p = 0; p < 4; p++) {
    const v = values[p];
    code = code * 11 + (v === null || v === undefined ? 0 : v);
  }
  return code;
}

export function guessCodeToValues(code) {
  const values = new Array(4);
  let rem = code;
  for (let p = 3; p >= 0; p--) {
    const v = rem % 11;
    values[p] = v === 0 ? null : v;
    rem = Math.floor(rem / 11);
  }
  return values;
}

// All PREFIX-shaped guess codes (cards 1..k filled, k+1..4 always blank, for
// k=1..4 — never a gap in the middle or a suffix-only guess) whose digit
// usage fits within `inventory`. This matches how partial guesses actually
// work in the game: you can only hold back cards from the end.
export function feasibleGuessCodes(inventory, maxCards = 4) {
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
      if (ok) result.push(valuesToGuessCode(values));
    }
  }
  return result;
}
