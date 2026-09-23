// Shared logic between the main thread (app.js) and the solver worker.
// A "code" is an integer 0..N-1 encoding a length-L combination whose digits
// (each 0-9) represent values (1-10) at each position, most significant digit first.

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

export function valuesToCode(values) {
  let code = 0;
  for (const v of values) code = code * 10 + (v - 1);
  return code;
}

export function codeToValues(code, L) {
  const values = new Array(L);
  let rem = code;
  for (let p = L - 1; p >= 0; p--) {
    values[p] = (rem % 10) + 1;
    rem = Math.floor(rem / 10);
  }
  return values;
}

export function matchCount(digits, L, codeA, codeB) {
  const baseA = codeA * L, baseB = codeB * L;
  let m = 0;
  for (let p = 0; p < L; p++) if (digits[baseA + p] === digits[baseB + p]) m++;
  return m;
}

// Like matchCount, but the guess is a values array (1-10) that may contain
// `null` for a position that wasn't sent at all — an unsent position never
// counts as a match, no matter what the secret is there.
export function matchCountValues(guessValues, digits, L, secretCode) {
  const base = secretCode * L;
  let m = 0;
  for (let p = 0; p < L; p++) {
    const gv = guessValues[p];
    if (gv === null) continue;
    if (gv - 1 === digits[base + p]) m++;
  }
  return m;
}

export function allCodes(L) {
  const N = comboCount(L);
  const arr = new Array(N);
  for (let i = 0; i < N; i++) arr[i] = i;
  return arr;
}

// Counts of each value 1-10 (index 0 = value 1) used in a values array.
// Entries that are null/undefined (an unsent position) are skipped.
export function digitCounts(values) {
  const counts = new Array(10).fill(0);
  for (const v of values) if (v) counts[v - 1]++;
  return counts;
}

// All codes of length L whose digit usage fits within `inventory`
// (an array of 10 remaining counts, index 0 = value 1; Infinity = unlimited).
export function feasibleCodes(inventory, L) {
  const digits = buildDigits(L);
  const N = comboCount(L);
  const result = [];
  const used = new Array(10);
  for (let code = 0; code < N; code++) {
    used.fill(0);
    const base = code * L;
    let ok = true;
    for (let p = 0; p < L; p++) {
      const v = digits[base + p];
      used[v]++;
      if (used[v] > inventory[v]) { ok = false; break; }
    }
    if (ok) result.push(code);
  }
  return result;
}
