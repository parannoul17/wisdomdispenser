import {
  digitCounts, buildUnifiedDigits, allUnifiedCandidates, trueLengthOf, unifiedIdToValues,
  matchCountValuesUnified, feasibleGuessCodes, guessCodeToValues, percentFor,
} from './lib.js?v=13';

const setupPanel = document.getElementById('setup-panel');
const gamePanel = document.getElementById('game-panel');
const remainingCountEl = document.getElementById('remaining-count');
const guessRow = document.getElementById('guess-row');
const guessError = document.getElementById('guess-error');
const guessCost = document.getElementById('guess-cost');
const spinnerRow = document.getElementById('spinner-row');
const resultButtons = document.getElementById('result-buttons');
const historyArea = document.getElementById('history-area');
const bannerArea = document.getElementById('banner-area');
const undoBtn = document.getElementById('undo-btn');
const resetBtn = document.getElementById('reset-btn');
const inventorySetupGrid = document.getElementById('inventory-setup-grid');
const inventoryDisplay = document.getElementById('inventory-display');
const inventoryAddGrid = document.getElementById('inventory-add-grid');
const inventoryAddBtn = document.getElementById('inventory-add-btn');
const sendCountChoices = document.getElementById('send-count-choices');
const sendCountHint = document.getElementById('send-count-hint');
const guessLabel = document.getElementById('guess-label');
const cardsDisplay = document.getElementById('cards-display');
const pastTriesEl = document.getElementById('past-tries');
const addPastTryBtn = document.getElementById('add-past-try-btn');
const setupError = document.getElementById('setup-error');
const odds3Btn = document.getElementById('odds-3-btn');
const odds4Btn = document.getElementById('odds-4-btn');
const oddsResultEl = document.getElementById('odds-result');

let L = null; // combination length: 3 or 4
let digits = null;
let candidateCodes = [];
let history = []; // { guessValues, result (a percent), before, invBefore, remainingAfter, cardsUsed }
let suggestion = null;
let computing = false;
let worker = null;
let inventory = null; // array of 10 remaining counts (index 0 = value 1), Infinity = unlimited
let outOfResources = false; // truly nothing left to send at all
let computeError = null;
let computeTimeoutId = null;
let sendCount = 1; // how many leading cards of the guess row are active (a prefix, never a gap)
const COMPUTE_TIMEOUT_MS = 15000;

// { status: 'idle'|'computing'|'done'|'unavailable', worstCards, expectedCards, capped }
let analysisState = { status: 'idle' };
let analysisWorker = null;
let analysisRequestId = 0;
let analysisTimeoutId = null;
const ANALYSIS_TIMEOUT_MS = 120000;

// Odds check (setup screen only): chance of fully resolving a round with a
// given inventory, computed by simulating this tool's own suggested guesses
// across every possible secret of that length.
let oddsWorker = null;
let oddsRequestId = 0;
let oddsTimeoutId = null;
const ODDS_TIMEOUT_MS = 120000;
const oddsCache = new Map();
function oddsCacheKey(len, inv, tries) {
  const invKey = inv.map((v) => (v === Infinity ? 'inf' : v)).join(',');
  const triesKey = tries.map((t) => `${t.cards}:${t.values.join('.')}:${t.pct}`).join('|');
  return `${len}|${invKey}|${triesKey}`;
}

// The opening move's analysis only depends on (length, inventory) — it's
// the same search every time, so a fresh session with the same setup can
// reuse a previous result instantly instead of re-running the full-tree search.
const openingAnalysisCache = new Map();
const openingSuggestionCache = new Map();
function openingAnalysisCacheKey(len, inv) {
  return len + '|' + inv.map((v) => (v === Infinity ? 'inf' : v)).join(',');
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js?v=13');
  worker.onerror = (err) => {
    console.error('Solver worker error:', err.message || err);
    clearTimeout(computeTimeoutId);
    worker.terminate();
    worker = null;
    computing = false;
    computeError = 'Something went wrong computing a suggestion.';
    updateProjectionsTerminal();
    renderAll();
  };
  return worker;
}

function getAnalysisWorker() {
  if (analysisWorker) return analysisWorker;
  analysisWorker = new Worker('worker.js?v=13');
  analysisWorker.onerror = (err) => {
    console.error('Analysis worker error:', err.message || err);
    clearTimeout(analysisTimeoutId);
    analysisWorker.terminate();
    analysisWorker = null;
    analysisState = { status: 'unavailable' };
    renderCards();
  };
  return analysisWorker;
}

function getOddsWorker() {
  if (oddsWorker) return oddsWorker;
  oddsWorker = new Worker('worker.js?v=13');
  oddsWorker.onerror = (err) => {
    console.error('Odds worker error:', err.message || err);
    clearTimeout(oddsTimeoutId);
    oddsWorker.terminate();
    oddsWorker = null;
    oddsResultEl.textContent = 'Something went wrong checking odds.';
  };
  return oddsWorker;
}

function buildInventorySetupGrid() {
  inventorySetupGrid.innerHTML = '';
  for (let v = 1; v <= 10; v++) {
    const field = document.createElement('div');
    field.className = 'inventory-field';
    const label = document.createElement('label');
    label.textContent = String(v);
    label.htmlFor = `inv-${v}`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.placeholder = '∞';
    input.id = `inv-${v}`;
    field.appendChild(label);
    field.appendChild(input);
    inventorySetupGrid.appendChild(field);
  }
}

function readInventoryInputs() {
  const inv = new Array(10);
  for (let v = 1; v <= 10; v++) {
    const input = document.getElementById(`inv-${v}`);
    const raw = input.value.trim();
    inv[v - 1] = raw === '' ? Infinity : Math.max(0, parseInt(raw, 10) || 0);
  }
  return inv;
}

function buildInventoryAddGrid() {
  inventoryAddGrid.innerHTML = '';
  for (let v = 1; v <= 10; v++) {
    const field = document.createElement('div');
    field.className = 'inventory-field';
    const label = document.createElement('label');
    label.textContent = String(v);
    label.htmlFor = `add-inv-${v}`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.placeholder = '0';
    input.id = `add-inv-${v}`;
    field.appendChild(label);
    field.appendChild(input);
    inventoryAddGrid.appendChild(field);
  }
}

function addToInventory() {
  let changed = false;
  for (let v = 1; v <= 10; v++) {
    const input = document.getElementById(`add-inv-${v}`);
    const raw = input.value.trim();
    const amount = raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0);
    if (amount > 0) {
      inventory[v - 1] = inventory[v - 1] === Infinity ? Infinity : inventory[v - 1] + amount;
      changed = true;
    }
    input.value = '';
  }
  if (!changed) return;
  if (candidateCodes.length > 1) {
    requestSuggestion();
  } else {
    renderAll();
  }
}

// The winning guess has been sent (the last result was 100%).
function answerSent() {
  return history.length > 0 && history[history.length - 1].result === 100;
}

// Down to one candidate but the answer itself hasn't been sent yet — the game
// still needs it, so it's offered as the final guess to log.
function solvedPendingSend() {
  return candidateCodes.length === 1 && !answerSent();
}

// Length of the guess's own leading run of real values — guesses are always
// generated as prefixes, so this is just "how many cards did the suggestion
// itself use."
function naturalSendCount(sug) {
  if (sug === null) return 1;
  // One candidate left: the "guess" is the answer itself, sent at its full length.
  if (candidateCodes.length === 1) return trueLengthOf(sug);
  const vals = guessCodeToValues(sug);
  let count = 0;
  for (const v of vals) {
    if (v === null) break;
    count++;
  }
  return Math.max(1, count);
}

const PAST_TRY_PERCENTS = [0, 25, 33, 50, 67, 75, 100];

function renumberPastTries() {
  pastTriesEl.querySelectorAll('.past-try').forEach((row, i) => {
    row.querySelector('.try-num').textContent = `${i + 1}.`;
  });
}

// One row of the "tries you already made" editor: how many cards were sent
// (always the first k positions), their values, and the % the game gave back.
function addPastTryRow() {
  const row = document.createElement('div');
  row.className = 'past-try';

  const num = document.createElement('span');
  num.className = 'try-num';
  row.appendChild(num);

  const cardsSel = document.createElement('select');
  cardsSel.className = 'try-cards';
  for (let k = 1; k <= 4; k++) {
    const opt = document.createElement('option');
    opt.value = String(k);
    opt.textContent = k === 1 ? '1 card' : `${k} cards`;
    if (k === 3) opt.selected = true;
    cardsSel.appendChild(opt);
  }
  row.appendChild(cardsSel);

  const valueSels = [];
  for (let i = 0; i < 4; i++) {
    const sel = document.createElement('select');
    sel.className = 'try-value';
    for (let v = 1; v <= 10; v++) {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = String(v);
      sel.appendChild(opt);
    }
    valueSels.push(sel);
    row.appendChild(sel);
  }
  const syncDisabled = () => {
    const k = parseInt(cardsSel.value, 10);
    valueSels.forEach((sel, i) => { sel.disabled = i >= k; });
  };
  cardsSel.addEventListener('change', syncDisabled);
  syncDisabled();

  const pctSel = document.createElement('select');
  pctSel.className = 'try-pct';
  for (const p of PAST_TRY_PERCENTS) {
    const opt = document.createElement('option');
    opt.value = String(p);
    opt.textContent = `${p}%`;
    pctSel.appendChild(opt);
  }
  row.appendChild(pctSel);

  const remove = document.createElement('button');
  remove.className = 'try-remove';
  remove.textContent = '×';
  remove.title = 'Remove this try';
  remove.addEventListener('click', () => { row.remove(); renumberPastTries(); });
  row.appendChild(remove);

  pastTriesEl.appendChild(row);
  renumberPastTries();
}

function readPastTries() {
  return Array.from(pastTriesEl.querySelectorAll('.past-try')).map((row) => {
    const cards = parseInt(row.querySelector('.try-cards').value, 10);
    const sels = row.querySelectorAll('.try-value');
    const values = [null, null, null, null];
    for (let i = 0; i < cards; i++) values[i] = parseInt(sels[i].value, 10);
    return { cards, values, pct: parseInt(row.querySelector('.try-pct').value, 10) };
  });
}

function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.classList.remove('hidden');
}

// Replays the entered past tries against candidates of `len`, same
// validation as startGame, without committing to a game. Returns the
// narrowed candidates, or null (after showing the setup error) if a try
// doesn't fit.
function replayTriesFor(len, tries, unifiedDigits) {
  let cands = allUnifiedCandidates().filter((id) => trueLengthOf(id) === len);
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    if (t.cards > len) {
      showSetupError(`Try ${i + 1} sends ${t.cards} cards, but a ${len}-number combination only has ${len}.`);
      return null;
    }
    const after = cands.filter((id) => percentFor(matchCountValuesUnified(t.values, unifiedDigits, id), trueLengthOf(id)) === t.pct);
    if (after.length === 0) {
      showSetupError(i === 0
        ? `Try 1 isn't possible in a ${len}-number game — check its numbers and %, or the length.`
        : `Try ${i + 1} doesn't fit with the earlier tries — check its numbers or %, or whether this is really a ${len}-number game.`);
      return null;
    }
    cands = after;
  }
  return cands;
}

function computeOddsForLength(len) {
  setupError.classList.add('hidden');
  const inv = readInventoryInputs();
  const tries = readPastTries();
  const unifiedDigits = buildUnifiedDigits();

  const cands = replayTriesFor(len, tries, unifiedDigits);
  if (cands === null) { oddsResultEl.textContent = ''; return; }

  if (cands.length <= 1) {
    oddsResultEl.textContent = `${len} numbers: your tries already narrow it to ${cands.length} combination${cands.length === 1 ? '' : 's'} — just send it.`;
    return;
  }

  const cacheKey = oddsCacheKey(len, inv, tries);
  if (oddsCache.has(cacheKey)) {
    reportOddsResult(len, oddsCache.get(cacheKey));
    return;
  }

  oddsResultEl.textContent = `Checking ${len}-number odds…`;
  const myId = ++oddsRequestId;
  const w = getOddsWorker();
  w.onmessage = (e) => {
    if (e.data.requestId !== myId) return;
    clearTimeout(oddsTimeoutId);
    const result = { solvable: e.data.solvable, total: e.data.total, capped: e.data.capped };
    oddsCache.set(cacheKey, result);
    reportOddsResult(len, result);
  };
  w.postMessage({ type: 'odds', requestId: myId, candidateCodes: cands, inventory: inv, L: len });

  clearTimeout(oddsTimeoutId);
  oddsTimeoutId = setTimeout(() => {
    if (oddsRequestId !== myId) return;
    console.error('Odds worker timed out');
    w.terminate();
    oddsWorker = null;
    oddsResultEl.textContent = 'Odds check timed out — try again, or with a more limited inventory.';
  }, ODDS_TIMEOUT_MS);
}

function reportOddsResult(len, { solvable, total, capped }) {
  const pct = Math.round((solvable / total) * 100);
  const cappedNote = capped ? ' (the search hit its depth limit — treat this as an estimate)' : '';
  oddsResultEl.textContent = `${len} numbers: about ${pct}% chance to fully resolve with this inventory${cappedNote}.`;
}

// The secret is one of the candidates of the chosen length (3 or 4). Tries
// made before using the tool are replayed first, narrowing the candidates
// exactly as if they'd been entered live.
function startGame(len) {
  setupError.classList.add('hidden');
  const inv = readInventoryInputs();
  const tries = readPastTries();
  const unifiedDigits = buildUnifiedDigits();

  let cands = allUnifiedCandidates().filter((id) => trueLengthOf(id) === len);
  const replayed = [];
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    if (t.cards > len) {
      showSetupError(`Try ${i + 1} sends ${t.cards} cards, but a ${len}-number combination only has ${len}.`);
      return;
    }
    const after = cands.filter((id) => percentFor(matchCountValuesUnified(t.values, unifiedDigits, id), trueLengthOf(id)) === t.pct);
    if (after.length === 0) {
      showSetupError(i === 0
        ? `Try 1 isn't possible in a ${len}-number game — check its numbers and %, or the length.`
        : `Try ${i + 1} doesn't fit with the earlier tries — check its numbers or %, or whether this is really a ${len}-number game.`);
      return;
    }
    replayed.push({ guessValues: t.values.slice(0, len), result: t.pct, before: cands, invBefore: inv, remainingAfter: after.length, cardsUsed: t.cards });
    cands = after;
  }

  L = len;
  inventory = inv;
  digits = unifiedDigits;
  candidateCodes = cands;
  history = replayed;
  suggestion = null;
  sendCount = L;
  outOfResources = false;
  computeError = null;
  analysisState = { status: 'idle' };
  setupPanel.classList.add('hidden');
  gamePanel.classList.remove('hidden');
  renderAll();
  settleAfterUpdate();
}

function resetGame() {
  pastTriesEl.innerHTML = ''; // don't carry last game's tries into the next one
  setupError.classList.add('hidden');
  oddsResultEl.textContent = '';
  L = null;
  candidateCodes = [];
  history = [];
  suggestion = null;
  inventory = null;
  outOfResources = false;
  computeError = null;
  analysisState = { status: 'idle' };
  analysisRequestId++;
  clearTimeout(computeTimeoutId);
  clearTimeout(analysisTimeoutId);
  if (worker) { worker.terminate(); worker = null; }
  if (analysisWorker) { analysisWorker.terminate(); analysisWorker = null; }
  gamePanel.classList.add('hidden');
  setupPanel.classList.remove('hidden');
}

// Sets analysisState for states where there's no pending guess to project
// forward from (solved, contradiction, out of resources, or a failed
// computation).
function updateProjectionsTerminal() {
  analysisRequestId++; // invalidate any in-flight analysis request
  if (candidateCodes.length <= 1) {
    // Nothing more to find out. (The answer's own cards, if not sent yet, are
    // already counted in "used" — see renderCards.)
    analysisState = { status: 'done', worstCards: 0, expectedCards: 0, capped: false };
  } else {
    analysisState = { status: 'unavailable' };
  }
}

function requestAnalysis(candidatesForAnalysis, guessCodesForAnalysis, cacheKey = null) {
  if (cacheKey && openingAnalysisCache.has(cacheKey)) {
    analysisState = { status: 'done', ...openingAnalysisCache.get(cacheKey) };
    renderCards();
    return;
  }

  analysisRequestId++;
  const myId = analysisRequestId;
  analysisState = { status: 'computing' };
  renderCards();

  const aw = getAnalysisWorker();
  aw.onmessage = (e) => {
    if (e.data.requestId !== myId) return;
    clearTimeout(analysisTimeoutId);
    const result = { worstCards: e.data.worstCards, expectedCards: e.data.expectedCards, capped: e.data.capped };
    if (cacheKey) openingAnalysisCache.set(cacheKey, result);
    analysisState = { status: 'done', ...result };
    renderCards();
  };
  aw.postMessage({ type: 'analysis', requestId: myId, candidateCodes: candidatesForAnalysis, guessCodes: guessCodesForAnalysis, inventory });

  clearTimeout(analysisTimeoutId);
  analysisTimeoutId = setTimeout(() => {
    if (analysisRequestId !== myId) return;
    console.error('Analysis worker timed out');
    aw.terminate();
    analysisWorker = null;
    analysisState = { status: 'unavailable' };
    renderCards();
  }, ANALYSIS_TIMEOUT_MS);
}

function requestSuggestion() {
  guessError.classList.add('hidden');

  if (candidateCodes.length === 0) { suggestion = null; sendCount = 1; updateProjectionsTerminal(); renderAll(); return; }
  if (candidateCodes.length === 1) { suggestion = candidateCodes[0]; sendCount = naturalSendCount(suggestion); updateProjectionsTerminal(); renderAll(); return; }

  // Guesses are prefixes of up to L cards (never longer than the secret can be).
  // Any card at all makes a 1-card guess affordable, so this is only empty when
  // there is nothing left to send.
  const guessCodes = feasibleGuessCodes(inventory, L);
  if (guessCodes.length === 0) {
    suggestion = null;
    sendCount = 1;
    outOfResources = true;
    updateProjectionsTerminal();
    renderAll();
    return;
  }
  outOfResources = false;

  computing = true;
  computeError = null;
  renderAll();

  const isOpeningMove = history.length === 0;
  const cacheKey = isOpeningMove ? openingAnalysisCacheKey(L, inventory) : null;

  if (cacheKey && openingSuggestionCache.has(cacheKey)) {
    suggestion = openingSuggestionCache.get(cacheKey);
    sendCount = naturalSendCount(suggestion);
    computing = false;
    renderAll();
    requestAnalysis(candidateCodes, guessCodes, cacheKey);
    return;
  }

  const w = getWorker();
  w.onmessage = (e) => {
    clearTimeout(computeTimeoutId);
    suggestion = e.data.bestGuess;
    sendCount = naturalSendCount(suggestion);
    if (cacheKey) openingSuggestionCache.set(cacheKey, suggestion);
    computing = false;
    renderAll();
    requestAnalysis(candidateCodes, guessCodes, cacheKey);
  };
  w.postMessage({ type: 'suggest', candidateCodes, guessCodes, inventory });

  clearTimeout(computeTimeoutId);
  computeTimeoutId = setTimeout(() => {
    if (!computing) return;
    console.error('Solver worker timed out');
    w.terminate();
    worker = null;
    computing = false;
    computeError = 'The solver got stuck and was stopped.';
    updateProjectionsTerminal();
    renderAll();
  }, COMPUTE_TIMEOUT_MS);
}

function submitResult(pct) {
  if (computing) return;
  const guessValues = readGuessInputs();
  const filledCount = guessValues.filter((v) => v !== null).length;
  if (filledCount === 0) return;

  const counts = digitCounts(guessValues);
  for (let v = 1; v <= 10; v++) {
    if (counts[v - 1] > inventory[v - 1]) {
      guessError.textContent = `Not enough ${v}s left (have ${inventory[v - 1]}, this guess uses ${counts[v - 1]}).`;
      guessError.classList.remove('hidden');
      return;
    }
  }
  guessError.classList.add('hidden');

  const before = candidateCodes;
  const invBefore = inventory;
  const after = before.filter((id) => percentFor(matchCountValuesUnified(guessValues, digits, id), trueLengthOf(id)) === pct);

  const newInventory = inventory.slice();
  for (let v = 1; v <= 10; v++) newInventory[v - 1] -= counts[v - 1];

  history.push({ guessValues, result: pct, before, invBefore, remainingAfter: after.length, cardsUsed: filledCount });
  candidateCodes = after;
  inventory = newInventory;

  settleAfterUpdate();
}

// After the candidates change (a new result, or a replayed session): show the
// contradiction / solved state, or ask for the next suggestion.
function settleAfterUpdate() {
  if (candidateCodes.length === 0) {
    suggestion = null;
    sendCount = 1;
    updateProjectionsTerminal();
    renderAll();
    return;
  }
  if (candidateCodes.length === 1) {
    suggestion = candidateCodes[0];
    sendCount = naturalSendCount(suggestion);
    updateProjectionsTerminal();
    renderAll();
    return;
  }
  requestSuggestion();
}

function undoLast() {
  if (history.length === 0) return;
  const last = history.pop();
  candidateCodes = last.before;
  inventory = last.invBefore;
  suggestion = null;
  if (candidateCodes.length === 1) {
    suggestion = candidateCodes[0];
    sendCount = naturalSendCount(suggestion);
    updateProjectionsTerminal();
    renderAll();
  } else {
    requestSuggestion();
  }
}

function readGuessInputs() {
  const selects = guessRow.querySelectorAll('select');
  return Array.from(selects).map((s) => {
    if (s.disabled) return null;
    const v = parseInt(s.value, 10);
    return v === 0 ? null : v;
  });
}

function onGuessChanged() {
  renderResultButtons();
  renderGuessCostPreview();
}

function renderSendCountControl() {
  sendCountChoices.innerHTML = '';
  for (let n = 1; n <= L; n++) {
    const btn = document.createElement('button');
    btn.textContent = String(n);
    btn.className = n === sendCount ? 'send-count-btn active' : 'send-count-btn';
    btn.addEventListener('click', () => {
      sendCount = n;
      renderGuessInputs();
      renderResultButtons();
      renderGuessCostPreview();
    });
    sendCountChoices.appendChild(btn);
  }
}

function renderGuessInputs() {
  guessRow.innerHTML = '';
  let values;
  if (suggestion === null) values = new Array(L).fill(null);
  else if (candidateCodes.length === 1) values = unifiedIdToValues(suggestion, digits);
  else values = guessCodeToValues(suggestion);
  for (let i = 0; i < L; i++) {
    const select = document.createElement('select');
    if (i >= sendCount) {
      const opt = document.createElement('option');
      opt.value = '0';
      opt.textContent = '—';
      opt.selected = true;
      select.appendChild(opt);
      select.disabled = true;
    } else {
      const defaultVal = values[i] !== null && values[i] !== undefined ? values[i] : 1;
      for (let v = 1; v <= 10; v++) {
        const opt = document.createElement('option');
        opt.value = String(v);
        opt.textContent = String(v);
        if (v === defaultVal) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', onGuessChanged);
    }
    guessRow.appendChild(select);
  }
}

function renderGuessCostPreview() {
  const guessValues = readGuessInputs();
  const filled = guessValues.filter((v) => v !== null).length;
  guessCost.textContent = filled === 0
    ? 'Set at least one number before you can submit a result.'
    : `This guess will use ${filled} card${filled === 1 ? '' : 's'}.`;
}

function renderResultButtons() {
  resultButtons.innerHTML = '';
  const guessValues = readGuessInputs();
  const filledCount = guessValues.filter((v) => v !== null).length;
  if (filledCount === 0) return;

  const disabled = computing || candidateCodes.length === 0 || outOfResources || !!computeError;

  if (solvedPendingSend()) {
    // Only one outcome is possible: the answer is right.
    const btn = document.createElement('button');
    btn.textContent = 'I sent it (100%)';
    btn.className = 'btn-primary';
    btn.disabled = disabled;
    btn.addEventListener('click', () => submitResult(100));
    resultButtons.appendChild(btn);
    return;
  }

  // Only offer results that are still possible: the achievable percentages
  // depend on the lengths still alive among the actual remaining candidates.
  const percents = new Set();
  for (const id of candidateCodes) {
    const m = matchCountValuesUnified(guessValues, digits, id);
    percents.add(percentFor(m, trueLengthOf(id)));
  }
  for (const pct of Array.from(percents).sort((a, b) => a - b)) {
    const btn = document.createElement('button');
    btn.textContent = `${Math.round((pct * L) / 100)}/${L} correct (${pct}%)`;
    btn.disabled = disabled;
    btn.addEventListener('click', () => submitResult(pct));
    resultButtons.appendChild(btn);
  }
}

function renderHistory() {
  if (history.length === 0) {
    historyArea.innerHTML = '<p class="empty-history">No guesses yet.</p>';
    return;
  }
  const rows = history.map((h, i) => {
    const digitsHtml = h.guessValues.map((v) => `<span class="digit${v === null ? ' blank' : ''}">${v === null ? '&mdash;' : v}</span>`).join('');
    return `<tr>
      <td>${i + 1}</td>
      <td><span class="guess-pill">${digitsHtml}</span></td>
      <td>${h.cardsUsed}</td>
      <td>${h.result}%</td>
      <td>${h.remainingAfter.toLocaleString('en-US')}</td>
    </tr>`;
  }).join('');
  historyArea.innerHTML = `<table>
    <thead><tr><th>#</th><th>Guess</th><th>Cards</th><th>Result</th><th>Remaining</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderInventory() {
  inventoryDisplay.innerHTML = '';
  for (let v = 1; v <= 10; v++) {
    const count = inventory[v - 1];
    const chip = document.createElement('div');
    chip.className = 'inventory-chip' + (count === 0 ? ' exhausted' : '');
    chip.innerHTML = `<span class="val">${v}</span><span class="count">${count === Infinity ? '∞' : count}</span>`;
    inventoryDisplay.appendChild(chip);
  }
}

function renderCards() {
  // The answer's cards count as used as soon as it's known: the game still
  // needs it sent, whether or not you tap "I sent it" here.
  const used = history.reduce((sum, h) => sum + h.cardsUsed, 0)
    + (solvedPendingSend() ? trueLengthOf(candidateCodes[0]) : 0);

  let predictedHtml = 'n/a';
  let worstHtml = 'n/a';

  if (!outOfResources && !computeError) {
    if (analysisState.status === 'computing') {
      predictedHtml = 'calculating…';
      worstHtml = 'calculating…';
    } else if (analysisState.status === 'done') {
      const suffix = analysisState.capped ? '+' : '';
      predictedHtml = `${used + Math.round(analysisState.expectedCards)}${suffix}`;
      worstHtml = `${used + analysisState.worstCards}${suffix}`;
    }
  }

  cardsDisplay.innerHTML = `
    <div class="card-stat"><span class="label">Used this session</span><span class="value used">${used}</span></div>
    <div class="card-stat"><span class="label">Estimated to finish</span><span class="value predicted">${predictedHtml}</span></div>
    <div class="card-stat"><span class="label">Worst case</span><span class="value worst">${worstHtml}</span></div>
  `;
}

function renderBanner() {
  if (candidateCodes.length === 0) {
    bannerArea.innerHTML = `<div class="banner error">No combination matches all the results entered so far &mdash; one of the results was probably mis-entered. Use "Undo last" to fix it.</div>`;
  } else if (candidateCodes.length === 1 && suggestion !== null) {
    const values = unifiedIdToValues(suggestion, digits);
    const tail = answerSent() ? '' : ` Send it in the game (${values.length} cards), then tap "I sent it" below.`;
    bannerArea.innerHTML = `<div class="banner win">Solved! The combination is <strong>${values.join(', ')}</strong>.${tail}</div>`;
  } else if (outOfResources) {
    bannerArea.innerHTML = `<div class="banner error">You're out of numbers to send &mdash; no guess is possible. Use "Undo last" if that's wrong.</div>`;
  } else if (computeError) {
    bannerArea.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'banner error';
    div.append(computeError + ' ');
    const btn = document.createElement('button');
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => requestSuggestion());
    div.appendChild(btn);
    bannerArea.appendChild(div);
  } else {
    bannerArea.innerHTML = '';
  }
}

function renderAll() {
  remainingCountEl.textContent = candidateCodes.length.toLocaleString('en-US');
  spinnerRow.classList.toggle('hidden', !computing);
  renderInventory();
  renderSendCountControl();
  renderGuessInputs();
  renderResultButtons();
  renderGuessCostPreview();
  renderHistory();
  renderCards();
  renderBanner();
  undoBtn.disabled = history.length === 0;

  const guessRowPanel = guessRow.closest('.panel');
  const resultPanel = resultButtons.closest('.panel');
  const pendingSend = solvedPendingSend();
  const hideGuessUi = (candidateCodes.length <= 1 && !pendingSend) || outOfResources || !!computeError;
  guessRowPanel.classList.toggle('hidden', hideGuessUi);
  resultPanel.classList.toggle('hidden', hideGuessUi);
  sendCountChoices.classList.toggle('hidden', pendingSend);
  sendCountHint.classList.toggle('hidden', pendingSend);
  guessLabel.textContent = pendingSend ? 'Final answer — send this to finish' : 'Suggested guess (edit if you tried something else)';
}

buildInventorySetupGrid();
buildInventoryAddGrid();
document.getElementById('len-3-btn').addEventListener('click', () => startGame(3));
document.getElementById('len-4-btn').addEventListener('click', () => startGame(4));
resetBtn.addEventListener('click', resetGame);
undoBtn.addEventListener('click', undoLast);
inventoryAddBtn.addEventListener('click', addToInventory);
addPastTryBtn.addEventListener('click', addPastTryRow);
odds3Btn.addEventListener('click', () => computeOddsForLength(3));
odds4Btn.addEventListener('click', () => computeOddsForLength(4));
