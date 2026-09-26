import {
  digitCounts, buildUnifiedDigits, allUnifiedCandidates, trueLengthOf, unifiedIdToValues,
  matchCountValuesUnified, feasibleGuessCodes, guessCodeToValues, percentFor,
} from './lib.js?v=8';

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
  worker = new Worker('worker.js?v=8');
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
  analysisWorker = new Worker('worker.js?v=8');
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

// The secret is one of the candidates of the chosen length (3 or 4).
function startGame(len) {
  L = len;
  inventory = readInventoryInputs();
  digits = buildUnifiedDigits();
  candidateCodes = allUnifiedCandidates().filter((id) => trueLengthOf(id) === len);
  history = [];
  suggestion = null;
  sendCount = L;
  outOfResources = false;
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
  aw.postMessage({ type: 'analysis', requestId: myId, candidateCodes: candidatesForAnalysis, guessCodes: guessCodesForAnalysis });

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
  w.postMessage({ type: 'suggest', candidateCodes, guessCodes });

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
