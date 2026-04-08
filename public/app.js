// ── AI Debate Arena – Frontend Engine ────────────────────────────
// Manages the full debate lifecycle: setup → initial positions →
// turn-by-turn debate → convergence detection → final verdict.

// Depth = how thoroughly the model thinks PER RESPONSE (not rounds)
const DEPTH_CONFIG = {
  low:    { maxTokens: 500,  label: 'Low',    instruction: 'Be brief and concise. Hit key points only. 2-3 short paragraphs max.' },
  medium: { maxTokens: 1500, label: 'Medium', instruction: 'Provide a balanced analysis. Cover main arguments with supporting reasoning.' },
  high:   { maxTokens: 3000, label: 'High',   instruction: 'Be thorough and detailed. Explore nuances, cite evidence, consider edge cases.' },
  max:    { maxTokens: 5000, label: 'Max',    instruction: 'Leave no stone unturned. Exhaustive analysis with full reasoning chains, evidence, counterarguments, and caveats.' },
};

const DEFAULT_MAX_ROUNDS = 5;

const CLAUDE_MODELS = {
  'claude-opus-4-6':    'Opus 4.6',
  'claude-sonnet-4-6':  'Sonnet 4.6',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

const OPENAI_MODELS = {
  'gpt-5.4':      'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-4o':       'GPT-4o',
  'o1-mini':      'o1-mini',
};

// ── DOM refs ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  question: $('question'),
  providerA: $('providerA'), modelA: $('modelA'), depthA: $('depthA'),
  providerB: $('providerB'), modelB: $('modelB'), depthB: $('depthB'),
  judgeModel: $('judgeModel'), judgeProvider: $('judgeProvider'),
  maxRounds: $('maxRounds'), convergenceThreshold: $('convergenceThreshold'),
  enableJudge: $('enableJudge'), autoMode: $('autoMode'),
  startBtn: $('startBtn'), pauseBtn: $('pauseBtn'),
  nextRoundBtn: $('nextRoundBtn'), stopBtn: $('stopBtn'),
  newDebateBtn: $('newDebateBtn'),
  setupPanel: $('setup-panel'), arena: $('arena'),
  verdict: $('verdict'), loading: $('loading'), loadingText: $('loadingText'),
  roundCounter: $('roundCounter'), phaseLabel: $('phaseLabel'),
  convergenceFill: $('convergenceFill'), convergenceScore: $('convergenceScore'),
  roundsA: $('roundsA'), roundsB: $('roundsB'),
  labelA: $('labelA'), labelB: $('labelB'),
  modelLabelA: $('modelLabelA'), modelLabelB: $('modelLabelB'),
  judgePanel: $('judge-panel'), judgeContent: $('judgeContent'),
  verdictContent: $('verdictContent'), verdictMeta: $('verdictMeta'),
};

// ── File upload refs ────────────────────────────────────────────
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const fileInfo = $('fileInfo');
const fileName = $('fileName');
const fileStats = $('fileStats');
const filePreview = $('filePreview');
const removeFileBtn = $('removeFileBtn');

// ── State ───────────────────────────────────────────────────────
let uploadedFileText = '';
let uploadedFileName = '';

// ── Cost tracking ───────────────────────────────────────────────
// Prices per 1M tokens (USD) as of 2026 - approximate
const PRICING = {
  'claude-opus-4-6':    { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6':  { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00 },
  'gpt-5.4':                   { input: 10.00, output: 30.00 },
  'gpt-5.4-mini':              { input: 1.50,  output: 6.00 },
  'gpt-4o':                    { input: 2.50,  output: 10.00 },
  'o1-mini':                   { input: 3.00,  output: 12.00 },
};

let totalCost = 0;

function trackCost(model, usage) {
  if (!usage) return;
  const p = PRICING[model];
  if (!p) return;
  const inTok = usage.input_tokens || usage.prompt_tokens || 0;
  const outTok = usage.output_tokens || usage.completion_tokens || 0;
  const cost = (inTok / 1_000_000) * p.input + (outTok / 1_000_000) * p.output;
  totalCost += cost;
  updateCostDisplay();
}

function updateCostDisplay() {
  const el = document.getElementById('costDisplay');
  if (el) el.textContent = '$' + totalCost.toFixed(4);
}

function estimateCost() {
  const cfgA = DEPTH_CONFIG[document.getElementById('depthA').value] || DEPTH_CONFIG.medium;
  const cfgB = DEPTH_CONFIG[document.getElementById('depthB').value] || DEPTH_CONFIG.medium;
  const modelA = document.getElementById('modelA').value;
  const modelB = document.getElementById('modelB').value;
  const judgeC = document.getElementById('judgeClaudeModel')?.value || 'claude-haiku-4-5-20251001';
  const judgeG = document.getElementById('judgeOpenAIModel')?.value || 'gpt-4o';
  const rounds = parseInt(document.getElementById('maxRounds')?.value) || DEFAULT_MAX_ROUNDS;
  const tokA = cfgA.maxTokens, tokB = cfgB.maxTokens;

  // Estimate: each round, each debater outputs ~maxTokens, inputs ~2x that (question + opponent)
  // Plus 2 judge calls per round, plus opening statements, plus summary
  let est = 0;
  const pA = PRICING[modelA] || { input: 5, output: 20 };
  const pB = PRICING[modelB] || { input: 5, output: 20 };
  const pJC = PRICING[judgeC] || { input: 1, output: 4 };
  const pJG = PRICING[judgeG] || { input: 1, output: 4 };

  // Opening statements (2 calls)
  est += (tokA * 2 / 1_000_000) * pA.output + (tokA / 1_000_000) * pA.input;
  est += (tokB * 2 / 1_000_000) * pB.output + (tokB / 1_000_000) * pB.input;
  // Debate rounds
  for (let r = 0; r < rounds; r++) {
    est += (tokA * 2 / 1_000_000) * pA.output + (tokA * 2 / 1_000_000) * pA.input;
    est += (tokB * 2 / 1_000_000) * pB.output + (tokB * 2 / 1_000_000) * pB.input;
    est += (2048 / 1_000_000) * (pJC.output + pJG.output) + (tokA + tokB) / 1_000_000 * (pJC.input + pJG.input);
  }
  return est;
}

let debate = {
  running: false,
  paused: false,
  round: 0,
  phase: 'SETUP', // SETUP | INITIAL | DEBATING | CONVERGED | SUMMARY
  history: [],     // [{round, sideA, sideB, judgeResult}]
  config: {},
  convergenceScores: [],
  lastResponseA: '',
  lastResponseB: '',
};

// ── Provider / Model sync ───────────────────────────────────────
function updateModelOptions(providerSelect, modelSelect) {
  const provider = providerSelect.value;
  const models = provider === 'claude' ? CLAUDE_MODELS : OPENAI_MODELS;
  modelSelect.innerHTML = '';
  const group = document.createElement('optgroup');
  group.label = provider === 'claude' ? 'Claude' : 'OpenAI';
  for (const [value, label] of Object.entries(models)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    group.appendChild(opt);
  }
  modelSelect.appendChild(group);
}

function syncJudgeProvider() {
  const model = els.judgeModel.value;
  if (model === 'none') return;
  els.judgeProvider.value = model.startsWith('claude') || model.startsWith('claude') ? 'anthropic' : 'openai';
}

els.providerA.addEventListener('change', () => updateModelOptions(els.providerA, els.modelA));
els.providerB.addEventListener('change', () => updateModelOptions(els.providerB, els.modelB));
els.judgeModel.addEventListener('change', syncJudgeProvider);

// ── File upload handling ────────────────────────────────────────
async function handleFileUpload(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);

  dropZone.classList.add('hidden');
  fileInfo.classList.remove('hidden');
  fileName.textContent = file.name;
  fileStats.textContent = 'Extracting text...';
  filePreview.textContent = '';

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(err.error);
    }
    const data = await res.json();
    uploadedFileText = data.text;
    uploadedFileName = data.filename;

    const kb = (data.size / 1024).toFixed(1);
    const truncNote = data.truncated ? ' (truncated to fit context)' : '';
    fileStats.textContent = `${kb} KB | ${data.chars.toLocaleString()} chars extracted${truncNote}`;
    filePreview.textContent = data.text.substring(0, 500) + (data.text.length > 500 ? '...' : '');
  } catch (err) {
    fileStats.textContent = 'Error: ' + err.message;
    fileStats.style.color = 'var(--red)';
    uploadedFileText = '';
    uploadedFileName = '';
  }
}

function removeFile() {
  uploadedFileText = '';
  uploadedFileName = '';
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  dropZone.classList.remove('hidden');
  fileStats.style.color = '';
}

// Drop zone events
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { if (e.target.files[0]) handleFileUpload(e.target.files[0]); });
removeFileBtn.addEventListener('click', removeFile);

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
});

// ── API helpers ─────────────────────────────────────────────────
async function callModel(provider, model, messages, systemPrompt, maxTokens) {
  const endpoint = provider === 'claude' ? '/api/chat/claude' : '/api/chat/openai';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, systemPrompt, maxTokens }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'API call failed');
  }
  const data = await res.json();
  trackCost(model, data.usage);
  return data;
}

async function callSingleJudge(provider, model, positionA, positionB, question, previousClaims) {
  const res = await fetch('/api/judge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider, model, positionA, positionB, question,
      previousClaims: previousClaims || null,
      maxTokens: 2048,
    }),
  });
  if (!res.ok) throw new Error(`Judge (${model}) call failed`);
  return res.json();
}

// Dual-judge: call both Claude and GPT judges in parallel, merge results
async function callJudge(positionA, positionB, question, previousClaims) {
  const judgeModelVal = els.judgeModel.value;
  if (judgeModelVal === 'none') return null;

  // Dual judge config - read from user-selected dropdowns
  const claudeJudge = { provider: 'anthropic', model: document.getElementById('judgeClaudeModel')?.value || 'claude-haiku-4-5-20251001' };
  const gptJudge    = { provider: 'openai',    model: document.getElementById('judgeOpenAIModel')?.value || 'gpt-4o' };

  const [claudeResult, gptResult] = await Promise.allSettled([
    callSingleJudge(claudeJudge.provider, claudeJudge.model, positionA, positionB, question, previousClaims),
    callSingleJudge(gptJudge.provider, gptJudge.model, positionA, positionB, question, previousClaims),
  ]);

  const cj = claudeResult.status === 'fulfilled' ? claudeResult.value : null;
  const gj = gptResult.status === 'fulfilled' ? gptResult.value : null;

  // If one failed, use the other
  if (!cj && !gj) throw new Error('Both judges failed');
  if (!cj) return { ...gj, _judges: { gpt: gj } };
  if (!gj) return { ...cj, _judges: { claude: cj } };

  // Merge: average numeric scores, union lists, AND stale/drift flags
  function avgDim(a, b) {
    if (!a && !b) return {};
    if (!a) return b;
    if (!b) return a;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out = {};
    for (const k of keys) out[k] = Math.round(((a[k] || 0) + (b[k] || 0)) / 2);
    return out;
  }

  return {
    scores_a: avgDim(cj.scores_a, gj.scores_a),
    scores_b: avgDim(cj.scores_b, gj.scores_b),
    convergence_score: Math.round(((cj.convergence_score || 0) + (gj.convergence_score || 0)) / 2),
    stale: cj.stale || gj.stale,  // either judge flags stale → stale
    drift_detected: cj.drift_detected || gj.drift_detected,
    claims_a: cj.claims_a || gj.claims_a,
    claims_b: cj.claims_b || gj.claims_b,
    agreements: [...new Set([...(cj.agreements || []), ...(gj.agreements || [])])],
    remaining_disputes: [...new Set([...(cj.remaining_disputes || []), ...(gj.remaining_disputes || [])])],
    summary: `CLAUDE JUDGE: ${cj.summary || 'N/A'}\n\nGPT JUDGE: ${gj.summary || 'N/A'}`,
    _judges: { claude: cj, gpt: gj },  // keep raw results for display
  };
}

async function callSummary(debateHistory, question) {
  // Use a strong model for the final summary
  const res = await fetch('/api/summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      debateHistory,
      question,
      maxTokens: 4096,
    }),
  });
  if (!res.ok) throw new Error('Summary call failed');
  return res.json();
}

// ── Scoring & Convergence System ────────────────────────────────
// Weights: judge convergence is king, self-scores are a weak signal
const WEIGHTS = {
  judgeConvergence: 0.50,  // Judge's convergence assessment
  selfScoreA:      0.15,   // Model A's self-reported agreement
  selfScoreB:      0.15,   // Model B's self-reported agreement
  noveltyPenalty:  0.10,   // Low novelty = closer to done
  driftBonus:      0.10,   // No drift = positions settled
};

// Track claims across rounds for drift detection
let claimsHistory = [];  // [{round, claims_a, claims_b}]

function parseAgreement(text) {
  const match = text.match(/\[AGREEMENT:\s*(\d+)\]/i);
  if (match) return parseInt(match[1], 10);
  const fallback = text.match(/agreement(?:\s*score)?[:\s]*(\d+)%?/i);
  if (fallback) return parseInt(fallback[1], 10);
  return null;
}

function computeWeightedScore(selfA, selfB, judgment) {
  // If no judge, fall back to self-scores only
  if (!judgment) {
    const scores = [selfA, selfB].filter(s => s != null);
    return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  }

  const judgeConv = judgment.convergence_score || 0;

  // Novelty penalty: avg of both sides' novelty scores, inverted
  // Low novelty (e.g., 20) → high "done" signal (80)
  const avgNovelty = ((judgment.scores_a?.novelty || 50) + (judgment.scores_b?.novelty || 50)) / 2;
  const noveltyDone = 100 - avgNovelty; // invert: no new ideas = closer to convergence

  // Drift signal: no drift = positions settled = closer to done
  const driftDone = judgment.drift_detected ? 0 : 100;

  // Weighted formula
  let score =
    (judgeConv       * WEIGHTS.judgeConvergence) +
    ((selfA || 0)    * WEIGHTS.selfScoreA) +
    ((selfB || 0)    * WEIGHTS.selfScoreB) +
    (noveltyDone     * WEIGHTS.noveltyPenalty) +
    (driftDone       * WEIGHTS.driftBonus);

  // Stale override: if judge says stale, boost convergence significantly
  if (judgment.stale) score = Math.max(score, 85);

  return Math.round(Math.min(100, Math.max(0, score)));
}

function dimAvg(scores) {
  if (!scores) return 0;
  const vals = Object.values(scores).filter(v => typeof v === 'number');
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
}

function updateConvergence(selfA, selfB, judgment) {
  const weighted = computeWeightedScore(selfA, selfB, judgment);
  debate.convergenceScores.push(weighted);
  els.convergenceFill.style.width = weighted + '%';
  els.convergenceScore.textContent = weighted + '%';
  if (weighted >= 80) {
    els.convergenceScore.style.color = 'var(--green)';
  } else if (weighted >= 50) {
    els.convergenceScore.style.color = 'var(--gold)';
  } else {
    els.convergenceScore.style.color = 'var(--red)';
  }
  return weighted;
}

function isConverged(avgScore) {
  const threshold = parseInt(els.convergenceThreshold.value) || 80;
  return avgScore >= threshold;
}

function getPreviousClaims() {
  if (claimsHistory.length === 0) return null;
  return claimsHistory[claimsHistory.length - 1];
}

function trackClaims(round, judgment) {
  if (judgment?.claims_a && judgment?.claims_b) {
    claimsHistory.push({
      round,
      claims_a: judgment.claims_a,
      claims_b: judgment.claims_b,
    });
  }
}

// ── UI helpers ──────────────────────────────────────────────────
function showLoading(text) {
  els.loadingText.textContent = text;
  els.loading.classList.remove('hidden');
}

function hideLoading() {
  els.loading.classList.add('hidden');
}

function setPhase(phase) {
  debate.phase = phase;
  els.phaseLabel.textContent = phase;
}

function addRoundCard(container, roundNum, label, content, agreement) {
  const card = document.createElement('div');
  card.className = 'round-card';

  let badgeHTML = '';
  if (agreement !== null && agreement !== undefined) {
    const cls = agreement >= 80 ? 'agreement-high' : agreement >= 50 ? 'agreement-mid' : 'agreement-low';
    badgeHTML = `<span class="agreement-badge ${cls}">${agreement}% agree</span>`;
  }

  card.innerHTML = `
    <div class="round-label">
      <span>${label}</span>
      ${badgeHTML}
    </div>
    <div class="content">${formatContent(content)}</div>
  `;
  container.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function addTypingIndicator(container) {
  const el = document.createElement('div');
  el.className = 'round-card typing-card';
  el.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  container.appendChild(el);
  return el;
}

function formatContent(text) {
  // Simple markdown-ish formatting
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<strong style="font-size:0.95rem;color:var(--gold)">$1</strong>')
    .replace(/^## (.+)$/gm, '<strong style="font-size:1rem;color:var(--gold)">$1</strong>')
    .replace(/^# (.+)$/gm, '<strong style="font-size:1.05rem;color:var(--gold)">$1</strong>')
    .replace(/^- (.+)$/gm, '&bull; $1')
    .replace(/\n/g, '<br>');
}

function buildDebateTranscript() {
  let transcript = '';
  for (const round of debate.history) {
    transcript += `\n--- Round ${round.round} ---\n`;
    transcript += `CORNER A: ${round.sideA}\n`;
    transcript += `CORNER B: ${round.sideB}\n`;
  }
  return transcript;
}

// ── System prompts ──────────────────────────────────────────────
function sourceBlock() {
  if (!uploadedFileText) return '';
  return `\n\nSOURCE MATERIAL (from "${uploadedFileName}"):\n---\n${uploadedFileText}\n---\n\nBase your analysis on this source material. Reference specific parts of it.`;
}

function initialPrompt(question, depthInstruction) {
  return `You are participating in a structured intellectual debate.

RESPONSE DEPTH: ${depthInstruction}

Analyze the following question/topic and provide your reasoned position.
Consider multiple angles, provide evidence and reasoning for your stance.${sourceBlock()}

At the end of your response, on a new line, write your self-assessed position strength as:
[AGREEMENT: 0]
(Start at 0 since you haven't seen the opponent's position yet)

QUESTION: ${question}`;
}

function debatePrompt(question, opponentResponse, roundNum, depthInstruction) {
  const srcRef = uploadedFileText
    ? `\n\nRemember to reference the source material ("${uploadedFileName}") in your arguments.`
    : '';
  return `You are in round ${roundNum} of a structured debate.

RESPONSE DEPTH: ${depthInstruction}

The question is: ${question}${srcRef}

Your opponent just argued:
---
${opponentResponse}
---

Respond by:
1. AGREEMENTS: Identify specific points you agree with (be honest, concede good points)
2. CHALLENGES: Challenge points you disagree with, explaining why
3. NEW ARGUMENTS: Present any new evidence or angles not yet discussed
4. UPDATED POSITION: State your current position, incorporating any concessions

At the end of your response, on a new line, rate your overall agreement with your opponent:
[AGREEMENT: X]
where X is 0-100 (0 = total disagreement, 100 = full agreement)

Be intellectually honest. If the opponent makes a strong point, acknowledge it.`;
}

// ── DEBATE ENGINE ───────────────────────────────────────────────
async function startDebate() {
  const question = els.question.value.trim();
  if (!question) {
    els.question.focus();
    return;
  }

  // Gather config
  const cfgA = DEPTH_CONFIG[els.depthA.value] || DEPTH_CONFIG.medium;
  const cfgB = DEPTH_CONFIG[els.depthB.value] || DEPTH_CONFIG.medium;
  const maxRoundsOverride = parseInt(els.maxRounds.value);
  const maxRounds = maxRoundsOverride || DEFAULT_MAX_ROUNDS;

  claimsHistory = [];
  totalCost = 0;
  updateCostDisplay();
  debate = {
    running: true,
    paused: false,
    round: 0,
    phase: 'INITIAL',
    history: [],
    convergenceScores: [],
    lastResponseA: '',
    lastResponseB: '',
    config: {
      question,
      providerA: els.providerA.value, modelA: els.modelA.value, depthA: els.depthA.value,
      providerB: els.providerB.value, modelB: els.modelB.value, depthB: els.depthB.value,
      maxRounds,
      maxTokensA: parseInt(document.getElementById('maxTokensOverride')?.value) || cfgA.maxTokens,
      maxTokensB: parseInt(document.getElementById('maxTokensOverride')?.value) || cfgB.maxTokens,
      enableJudge: els.enableJudge.checked,
      autoMode: els.autoMode.checked,
    },
  };

  // Update UI
  els.setupPanel.classList.add('hidden');
  els.arena.classList.remove('hidden');
  els.verdict.classList.add('hidden');
  document.getElementById('questionBanner').textContent = question;
  els.roundsA.innerHTML = '';
  els.roundsB.innerHTML = '';
  els.judgePanel.classList.add('hidden');
  els.judgeContent.innerHTML = '';

  const nameA = CLAUDE_MODELS[debate.config.modelA] || OPENAI_MODELS[debate.config.modelA] || debate.config.modelA;
  const nameB = CLAUDE_MODELS[debate.config.modelB] || OPENAI_MODELS[debate.config.modelB] || debate.config.modelB;
  els.modelLabelA.textContent = nameA;
  els.modelLabelB.textContent = nameB;
  els.labelA.textContent = 'CORNER A';
  els.labelB.textContent = 'CORNER B';

  updateConvergence(0, 0, null);
  setPhase('INITIAL');
  els.roundCounter.textContent = 'Round 0';
  els.pauseBtn.classList.remove('hidden');
  els.stopBtn.classList.remove('hidden');

  try {
    // ── Phase 1: Initial positions (parallel) ─────────────────
    showLoading('Both models studying the question...');

    const depthInstrA = (DEPTH_CONFIG[debate.config.depthA] || DEPTH_CONFIG.medium).instruction;
    const depthInstrB = (DEPTH_CONFIG[debate.config.depthB] || DEPTH_CONFIG.medium).instruction;

    const [resA, resB] = await Promise.all([
      callModel(
        debate.config.providerA, debate.config.modelA,
        [{ role: 'user', content: initialPrompt(question, depthInstrA) }],
        'You are a thoughtful debater. Present well-reasoned arguments.',
        debate.config.maxTokensA
      ),
      callModel(
        debate.config.providerB, debate.config.modelB,
        [{ role: 'user', content: initialPrompt(question, depthInstrB) }],
        'You are a thoughtful debater. Present well-reasoned arguments.',
        debate.config.maxTokensB
      ),
    ]);

    hideLoading();

    debate.lastResponseA = resA.text;
    debate.lastResponseB = resB.text;
    debate.history.push({ round: 0, sideA: resA.text, sideB: resB.text, judgeResult: null });

    addRoundCard(els.roundsA, 0, 'OPENING STATEMENT', resA.text, parseAgreement(resA.text));
    addRoundCard(els.roundsB, 0, 'OPENING STATEMENT', resB.text, parseAgreement(resB.text));

    // ── Phase 2+: Debate rounds ───────────────────────────────
    setPhase('DEBATING');

    for (let r = 1; r <= debate.config.maxRounds; r++) {
      if (!debate.running) break;

      // Handle pause
      while (debate.paused && debate.running) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!debate.running) break;

      // Step mode: wait for user to click "Next Round"
      if (!debate.config.autoMode) {
        els.nextRoundBtn.classList.remove('hidden');
        els.pauseBtn.classList.add('hidden');
        await waitForNextRound();
        els.nextRoundBtn.classList.add('hidden');
        els.pauseBtn.classList.remove('hidden');
        if (!debate.running) break;
      }

      debate.round = r;
      els.roundCounter.textContent = `Round ${r} / ${debate.config.maxRounds}`;

      // A responds to B
      showLoading(`Round ${r}: Corner A analyzing opponent's position...`);
      const typingA = addTypingIndicator(els.roundsA);

      const roundResA = await callModel(
        debate.config.providerA, debate.config.modelA,
        [{ role: 'user', content: debatePrompt(question, debate.lastResponseB, r, depthInstrA) }],
        'You are a thoughtful debater. Be intellectually honest. Concede good points.',
        debate.config.maxTokensA
      );
      typingA.remove();
      debate.lastResponseA = roundResA.text;
      const agreementA = parseAgreement(roundResA.text);
      addRoundCard(els.roundsA, r, `ROUND ${r}`, roundResA.text, agreementA);

      if (!debate.running) break;

      // B responds to A
      els.loadingText.textContent = `Round ${r}: Corner B analyzing opponent's position...`;
      const typingB = addTypingIndicator(els.roundsB);

      const roundResB = await callModel(
        debate.config.providerB, debate.config.modelB,
        [{ role: 'user', content: debatePrompt(question, debate.lastResponseA, r, depthInstrB) }],
        'You are a thoughtful debater. Be intellectually honest. Concede good points.',
        debate.config.maxTokensB
      );
      typingB.remove();
      hideLoading();
      debate.lastResponseB = roundResB.text;
      const agreementB = parseAgreement(roundResB.text);
      addRoundCard(els.roundsB, r, `ROUND ${r}`, roundResB.text, agreementB);

      // Judge assessment with rubric + drift tracking
      let judgment = null;
      if (debate.config.enableJudge) {
        try {
          showLoading('Judge scoring on 5 dimensions...');
          judgment = await callJudge(
            debate.lastResponseA, debate.lastResponseB, question,
            getPreviousClaims()
          );
          hideLoading();
          trackClaims(r, judgment);
          debate.history.push({
            round: r, sideA: roundResA.text, sideB: roundResB.text, judgeResult: judgment,
          });
        } catch (e) {
          console.warn('Judge failed:', e.message);
          hideLoading();
          debate.history.push({
            round: r, sideA: roundResA.text, sideB: roundResB.text, judgeResult: null,
          });
        }
      } else {
        debate.history.push({
          round: r, sideA: roundResA.text, sideB: roundResB.text, judgeResult: null,
        });
      }

      // Weighted convergence check
      const weightedScore = updateConvergence(agreementA, agreementB, judgment);
      if (judgment) showJudgeAssessment(judgment, r, weightedScore);

      if (isConverged(weightedScore)) {
        setPhase('CONVERGED');
        debate.running = false;
        break;
      }
    }

    // ── Final summary ────────────────────────────────────────
    if (debate.phase === 'DEBATING') {
      setPhase('MAX ROUNDS');
    }

    showLoading('Generating final verdict...');
    const transcript = buildDebateTranscript();
    const summary = await callSummary(transcript, question);
    hideLoading();

    showVerdict(summary.text);

  } catch (err) {
    hideLoading();
    console.error('Debate error:', err);
    alert('Debate error: ' + err.message);
    resetToSetup();
  }
}

function renderDimBar(label, score) {
  const cls = score >= 70 ? 'bar-high' : score >= 40 ? 'bar-mid' : 'bar-low';
  return `<div class="dim-row">
    <span class="dim-label">${label}</span>
    <div class="dim-bar"><div class="dim-fill ${cls}" style="width:${score}%"></div></div>
    <span class="dim-score">${score}</span>
  </div>`;
}

function showJudgeAssessment(judgment, round, weightedScore) {
  els.judgePanel.classList.remove('hidden');

  const scoreClass = weightedScore >= 80 ? 'agreement-high'
    : weightedScore >= 50 ? 'agreement-mid' : 'agreement-low';

  const sa = judgment.scores_a || {};
  const sb = judgment.scores_b || {};

  const flags = [];
  if (judgment.stale) flags.push('<span class="flag-stale">STALE</span>');
  if (judgment.drift_detected) flags.push('<span class="flag-drift">DRIFT</span>');
  if (weightedScore >= 80) flags.push('<span class="flag-converged">CONVERGED</span>');

  // Show which judges responded
  const judges = judgment._judges || {};
  const allModels = { ...CLAUDE_MODELS, ...OPENAI_MODELS };
  const cModel = document.getElementById('judgeClaudeModel')?.value || '';
  const gModel = document.getElementById('judgeOpenAIModel')?.value || '';
  const judgeNames = [];
  if (judges.claude) judgeNames.push(allModels[cModel] || cModel);
  if (judges.gpt) judgeNames.push(allModels[gModel] || gModel);
  const panelLabel = judgeNames.length === 2
    ? `Dual Judge Panel (${judgeNames.join(' + ')})`
    : `Judge: ${judgeNames[0] || 'Unknown'}`;

  // Per-judge raw convergence for transparency
  const rawScores = [];
  if (judges.claude) rawScores.push(`Claude: ${judges.claude.convergence_score}%`);
  if (judges.gpt) rawScores.push(`GPT: ${judges.gpt.convergence_score}%`);

  const html = `
    <div class="judge-header-row">
      <strong>Round ${round}</strong>
      <span class="agreement-badge ${scoreClass}" style="font-size:0.85rem;padding:4px 14px;">
        Weighted: ${weightedScore}%
      </span>
      <span style="font-size:0.7rem;color:var(--text-dim);">
        Merged: ${judgment.convergence_score}% ${rawScores.length ? '(' + rawScores.join(' / ') + ')' : ''}
      </span>
      ${flags.join(' ')}
    </div>
    <div style="font-size:0.7rem;color:var(--purple);margin-bottom:12px;font-family:'JetBrains Mono',monospace;">
      ${panelLabel}
    </div>

    <div class="rubric-grid">
      <div class="rubric-side">
        <div class="rubric-title" style="color:var(--red);">Corner A</div>
        ${renderDimBar('Argument', sa.argument || 0)}
        ${renderDimBar('Evidence', sa.evidence || 0)}
        ${renderDimBar('Logic', sa.logic || 0)}
        ${renderDimBar('Novelty', sa.novelty || 0)}
        ${renderDimBar('Honesty', sa.honesty || 0)}
        <div class="dim-avg">Avg: ${dimAvg(sa)}</div>
      </div>
      <div class="rubric-side">
        <div class="rubric-title" style="color:var(--blue);">Corner B</div>
        ${renderDimBar('Argument', sb.argument || 0)}
        ${renderDimBar('Evidence', sb.evidence || 0)}
        ${renderDimBar('Logic', sb.logic || 0)}
        ${renderDimBar('Novelty', sb.novelty || 0)}
        ${renderDimBar('Honesty', sb.honesty || 0)}
        <div class="dim-avg">Avg: ${dimAvg(sb)}</div>
      </div>
    </div>

    ${judgment.agreements?.length ? `
    <div class="judge-section">
      <span class="judge-section-label">Agreements</span>
      ${judgment.agreements.map(a => '<span class="judge-chip agree-chip">' + a + '</span>').join('')}
    </div>` : ''}
    ${judgment.remaining_disputes?.length ? `
    <div class="judge-section">
      <span class="judge-section-label">Remaining Disputes</span>
      ${judgment.remaining_disputes.map(d => '<span class="judge-chip dispute-chip">' + d + '</span>').join('')}
    </div>` : ''}
    <div class="judge-summary">${(judgment.summary || '').replace(/\n/g, '<br>')}</div>
  `;
  els.judgeContent.innerHTML = html;
}

function showVerdict(text) {
  els.verdict.classList.remove('hidden');
  els.verdictContent.innerHTML = formatContent(text);
  const allM = { ...CLAUDE_MODELS, ...OPENAI_MODELS };
  els.verdictMeta.textContent =
    `${debate.history.length - 1} rounds | Ended: ${debate.phase} | ` +
    `${allM[debate.config.modelA] || debate.config.modelA} vs ${allM[debate.config.modelB] || debate.config.modelB} | ` +
    `Total cost: $${totalCost.toFixed(4)}`;
  els.verdict.scrollIntoView({ behavior: 'smooth' });
}

function resetToSetup() {
  debate.running = false;
  debate.paused = false;
  els.setupPanel.classList.remove('hidden');
  els.arena.classList.add('hidden');
  els.verdict.classList.add('hidden');
  hideLoading();
}

// ── Manual step mode ────────────────────────────────────────────
let nextRoundResolve = null;

function waitForNextRound() {
  return new Promise(resolve => { nextRoundResolve = resolve; });
}

// ── Event listeners ─────────────────────────────────────────────
els.startBtn.addEventListener('click', () => {
  els.startBtn.disabled = true;
  startDebate().finally(() => { els.startBtn.disabled = false; });
});

els.pauseBtn.addEventListener('click', () => {
  debate.paused = !debate.paused;
  els.pauseBtn.innerHTML = debate.paused ? '&#9654;' : '&#10074;&#10074;';
  els.pauseBtn.title = debate.paused ? 'Resume' : 'Pause';
});

els.nextRoundBtn.addEventListener('click', () => {
  if (nextRoundResolve) {
    nextRoundResolve();
    nextRoundResolve = null;
  }
});

els.stopBtn.addEventListener('click', () => {
  debate.running = false;
  debate.paused = false;
  setPhase('STOPPED');
});

els.newDebateBtn.addEventListener('click', resetToSetup);

// ── Print / Export ──────────────────────────────────────────────
$('printBtn').addEventListener('click', () => window.print());

// ── Cost estimate updater ───────────────────────────────────────
function refreshEstimate() {
  const est = estimateCost();
  const el = $('estCostDisplay');
  if (el) el.textContent = est < 0.01 ? '< $0.01' : '$' + est.toFixed(2);
}

// Update estimate when any config changes
['modelA', 'modelB', 'depthA', 'depthB', 'judgeClaudeModel', 'judgeOpenAIModel'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('change', refreshEstimate);
});
refreshEstimate(); // initial

// ── Keyboard shortcut ───────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.metaKey && debate.phase === 'SETUP') {
    els.startBtn.click();
  }
  if (e.key === ' ' && debate.running && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    els.pauseBtn.click();
  }
});

// ── Health check on load ────────────────────────────────────────
fetch('/api/health')
  .then(r => r.json())
  .then(data => {
    if (!data.anthropic) console.warn('Anthropic API key not configured');
    if (!data.openai) console.warn('OpenAI API key not configured');
  })
  .catch(() => console.warn('Server not reachable'));
