import { buildDigits, codeToValues, allCodes, digitCounts, feasibleCodes, matchCountValues } from './lib.js';

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
const cardsDisplay = document.getElementById('cards-display');

let L = null;
let digits = null;
let candidateCodes = [];
let history = []; // { guessValues, result, before, invBefore, remainingAfter, cardsUsed }
let suggestion = null;
let computing = false;
let worker = null;
let inventory = null; // array of 10 remaining counts (index 0 = value 1), Infinity = unlimited
let outOfResources = false; // truly nothing left to send at all
let fullGuessUnaffordable = false; // can't afford a full-length guess, but a partial one may still work
let computeError = null;
let computeTimeoutId = null;
const COMPUTE_TIMEOUT_MS = 8000;

// { status: 'idle' | 'computing' | 'done' | 'unavailable', worstDepth, expected, capped }
let analysisState = { status: 'idle' };
let analysisWorker = null;
let analysisRequestId = 0;
let analysisTimeoutId = null;
const ANALYSIS_TIMEOUT_MS = 60000;

// The opening move's analysis only depends on (L, inventory) — it's the same
// 10,000-vs-10,000 (or however inventory restricts it) search every time, so
// a fresh session with the same setup can reuse a previous result instantly
// instead of re-running the multi-second full-tree search.
const openingAnalysisCache = new Map();
function openingAnalysisCacheKey(len, inv) {
  return len + '|' + inv.map((v) => (v === Infinity ? 'inf' : v)).join(',');
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js');
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
  analysisWorker = new Worker('worker.js');
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

function startGame(len) {
  L = len;
  inventory = readInventoryInputs();
  digits = buildDigits(L);
  candidateCodes = allCodes(L);
  history = [];
  suggestion = null;
  outOfResources = false;
  fullGuessUnaffordable = false;
  computeError = null;
  analysisState = { status: 'idle' };
  setupPanel.classList.add('hidden');
  gamePanel.classList.remove('hidden');
  renderAll();
  requestSuggestion();
}

function resetGame() {
  L = null;
  candidateCodes = [];
  history = [];
  suggestion = null;
  inventory = null;
  outOfResources = false;
  fullGuessUnaffordable = false;
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
    analysisState = { status: 'done', worstDepth: 0, expected: 0, capped: false };
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
    const result = { worstDepth: e.data.worstDepth, expected: e.data.expected, capped: e.data.capped };
    if (cacheKey) openingAnalysisCache.set(cacheKey, result);
    analysisState = { status: 'done', ...result };
    renderCards();
  };
  aw.postMessage({ type: 'analysis', requestId: myId, candidateCodes: candidatesForAnalysis, guessCodes: guessCodesForAnalysis, L });

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

  if (candidateCodes.length === 0) { suggestion = null; updateProjectionsTerminal(); renderAll(); return; }
  if (candidateCodes.length === 1) { suggestion = candidateCodes[0]; updateProjectionsTerminal(); renderAll(); return; }

  const guessCodes = feasibleCodes(inventory, L);
  if (guessCodes.length === 0) {
    suggestion = null;
    const totalLeft = inventory.reduce((s, c) => s + c, 0);
    outOfResources = totalLeft === 0;
    fullGuessUnaffordable = !outOfResources;
    updateProjectionsTerminal();
    renderAll();
    return;
  }
  outOfResources = false;
  fullGuessUnaffordable = false;

  computing = true;
  computeError = null;
  renderAll();

  const isOpeningMove = history.length === 0;
  const cacheKey = isOpeningMove ? openingAnalysisCacheKey(L, inventory) : null;

  const w = getWorker();
  w.onmessage = (e) => {
    clearTimeout(computeTimeoutId);
    suggestion = e.data.bestGuess;
    computing = false;
    renderAll();
    requestAnalysis(candidateCodes, guessCodes, cacheKey);
  };
  w.postMessage({ type: 'suggest', candidateCodes, guessCodes, L });

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

function submitResult(k) {
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
  const after = before.filter((c) => matchCountValues(guessValues, digits, L, c) === k);

  const newInventory = inventory.slice();
  for (let v = 1; v <= 10; v++) newInventory[v - 1] -= counts[v - 1];

  history.push({ guessValues, result: k, before, invBefore, remainingAfter: after.length, cardsUsed: filledCount });
  candidateCodes = after;
  inventory = newInventory;

  if (candidateCodes.length === 0) {
    suggestion = null;
    updateProjectionsTerminal();
    renderAll();
    return;
  }
  if (candidateCodes.length === 1) {
    suggestion = candidateCodes[0];
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
    updateProjectionsTerminal();
    renderAll();
  } else {
    requestSuggestion();
  }
}

function readGuessInputs() {
  const selects = guessRow.querySelectorAll('select');
  return Array.from(selects).map((s) => {
    const v = parseInt(s.value, 10);
    return v === 0 ? null : v;
  });
}

function pctFor(k) {
  return Math.round((k / L) * 100);
}

function onGuessChanged() {
  renderResultButtons();
  renderGuessCostPreview();
}

function renderGuessInputs() {
  guessRow.innerHTML = '';
  // No suggestion (e.g. a full-length guess isn't affordable) means there's
  // no recommendation to show — default to blank so the choice is deliberate.
  const values = suggestion !== null ? codeToValues(suggestion, L) : new Array(L).fill(null);
  for (let i = 0; i < L; i++) {
    const select = document.createElement('select');
    const blankOpt = document.createElement('option');
    blankOpt.value = '0';
    blankOpt.textContent = '—';
    if (values[i] === null) blankOpt.selected = true;
    select.appendChild(blankOpt);
    for (let v = 1; v <= 10; v++) {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = String(v);
      if (v === values[i]) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', onGuessChanged);
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
  for (let k = 0; k <= filledCount; k++) {
    const btn = document.createElement('button');
    btn.textContent = `${k}/${L} correct (${pctFor(k)}%)`;
    btn.disabled = disabled;
    btn.addEventListener('click', () => submitResult(k));
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
      <td>${h.result}/${L} (${pctFor(h.result)}%)</td>
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
  const used = history.reduce((sum, h) => sum + h.cardsUsed, 0);

  let predictedHtml = 'n/a';
  let worstHtml = 'n/a';

  if (!outOfResources && !computeError) {
    if (analysisState.status === 'computing') {
      predictedHtml = 'calculating…';
      worstHtml = 'calculating…';
    } else if (analysisState.status === 'done') {
      const suffix = analysisState.capped ? '+' : '';
      const expectedGuesses = Math.round(analysisState.expected);
      predictedHtml = `${used + expectedGuesses * L}${suffix}`;
      worstHtml = `${used + analysisState.worstDepth * L}${suffix}`;
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
    const values = codeToValues(suggestion, L).join(', ');
    bannerArea.innerHTML = `<div class="banner win">Solved! The combination is <strong>${values}</strong>.</div>`;
  } else if (outOfResources) {
    bannerArea.innerHTML = `<div class="banner error">You're out of numbers to send &mdash; no guess is possible. Use "Undo last" if that's wrong.</div>`;
  } else if (fullGuessUnaffordable) {
    bannerArea.innerHTML = `<div class="banner error">Not enough of any one combination left for a full ${L}-number guess. You can still send fewer numbers &mdash; set some slots to &ldquo;&mdash;&rdquo; below and use what you have left.</div>`;
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
  renderGuessInputs();
  renderResultButtons();
  renderGuessCostPreview();
  renderHistory();
  renderCards();
  renderBanner();
  undoBtn.disabled = history.length === 0;

  const guessRowPanel = guessRow.closest('.panel');
  const resultPanel = resultButtons.closest('.panel');
  const hideGuessUi = candidateCodes.length <= 1 || outOfResources || !!computeError;
  guessRowPanel.classList.toggle('hidden', hideGuessUi);
  resultPanel.classList.toggle('hidden', hideGuessUi);
}

buildInventorySetupGrid();
document.getElementById('len-3-btn').addEventListener('click', () => startGame(3));
document.getElementById('len-4-btn').addEventListener('click', () => startGame(4));
resetBtn.addEventListener('click', resetGame);
undoBtn.addEventListener('click', undoLast);
