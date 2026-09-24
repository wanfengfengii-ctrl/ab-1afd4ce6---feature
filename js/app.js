/**
 * app.js —— 页面交互：录入/导入、编辑即撤结论、Worker 全局裁决、逐步明细渲染。
 */
import { parseImport, exportModel, validateModel } from './solver.js';

const MIN_VECTORS = 4;
const MAX_VECTORS = 12;

const $ = (sel) => document.querySelector(sel);

const els = {
  pinCount: $('#pin-count'),
  limit: $('#limit'),
  pinsTail: $('#pins-tail'),
  weightsGrid: $('#weights-grid'),
  vectorsBody: $('#vectors-body'),
  btnAdd: $('#btn-add'),
  btnSample: $('#btn-sample'),
  btnImport: $('#btn-import'),
  btnExport: $('#btn-export'),
  btnSolve: $('#btn-solve'),
  importText: $('#import-text'),
  hint: $('#solve-hint'),
  staleBanner: $('#stale-banner'),
  errorBanner: $('#error-banner'),
  empty: $('#result-empty'),
  feasible: $('#result-feasible'),
  infeasible: $('#result-infeasible'),
  orderChain: $('#order-chain'),
  statFlips: $('#stat-flips'),
  statTotal: $('#stat-total'),
  statFeasible: $('#stat-feasible'),
  solveMeta: $('#solve-meta'),
  stepsBody: $('#steps-body'),
  infTotal: $('#inf-total'),
  infDiagnosis: $('#inf-diagnosis'),
};

// ---------- Worker ----------
let worker = null;
let latestNonce = 0;
let hadConclusion = false;
let currentLimit = null;

function getWorker() {
  if (worker === null) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { type, nonce, result, message } = e.data || {};
      if (nonce !== latestNonce) return; // 已被更新的裁决取代
      els.hint.classList.remove('computing');
      els.hint.textContent = '';
      if (type === 'error') {
        showFatal('求解器内部错误：\n' + message);
        return;
      }
      renderResult(result);
    };
    worker.onerror = (e) => {
      els.hint.classList.remove('computing');
      showFatal('Worker 运行失败：' + e.message);
    };
  }
  return worker;
}

// ---------- 示例数据 ----------
const SAMPLE = {
  pinCount: 8,
  limit: 6,
  weights: [2, 1, 3, 1, 2, 1, 1, 1],
  vectors: [
    { id: 'V1', bits: '00101010' },
    { id: 'V2', bits: '11000001' },
    { id: 'V3', bits: '01010001' },
    { id: 'V4', bits: '10000100' },
    { id: 'V5', bits: '00010010' },
    { id: 'V6', bits: '01000001' },
  ],
};

// ---------- 权重栅格 ----------
function renderWeights(values) {
  const pinCount = readPinCount();
  const old = [...els.weightsGrid.querySelectorAll('input')].map((i) => i.value);
  els.weightsGrid.innerHTML = '';
  els.pinsTail.textContent = String(pinCount);
  for (let k = 0; k < pinCount; k += 1) {
    const cell = document.createElement('label');
    cell.className = 'weights-cell';
    const lab = document.createElement('span');
    lab.className = 'pin-label';
    lab.textContent = `P${k + 1}`;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '0';
    inp.step = '1';
    inp.dataset.pinIndex = String(k);
    const src = values && values[k] !== undefined ? values[k] : old[k];
    inp.value = src !== undefined && src !== '' ? src : '1';
    cell.append(lab, inp);
    els.weightsGrid.append(cell);
  }
}

function readPinCount() {
  const v = Number.parseInt(els.pinCount.value, 10);
  return Number.isInteger(v) ? v : NaN;
}

// ---------- 向量行 ----------
function addVectorRow(id = '', bits = '') {
  const tr = document.createElement('tr');
  tr.className = 'vector-row';
  tr.innerHTML = `
    <td class="index-col"></td>
    <td><input class="tf-id" type="text" spellcheck="false" placeholder="如 V1" /></td>
    <td><input class="tf-bits" type="text" spellcheck="false" placeholder="8–20 位 0/1" /></td>
    <td><button class="delete-btn" type="button" title="删除此行">✕</button></td>
    <td class="err-msg"></td>`;
  tr.querySelector('.tf-id').value = id;
  tr.querySelector('.tf-bits').value = bits;
  els.vectorsBody.append(tr);
  renumberRows();
  updateAddDeleteState();
}

function renumberRows() {
  els.vectorsBody.querySelectorAll('.vector-row').forEach((tr, i) => {
    tr.querySelector('.index-col').textContent = String(i + 1);
  });
}

function rowCount() {
  return els.vectorsBody.querySelectorAll('.vector-row').length;
}

function updateAddDeleteState() {
  els.btnAdd.disabled = rowCount() >= MAX_VECTORS;
  els.vectorsBody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.disabled = rowCount() <= MIN_VECTORS;
  });
}

// ---------- 编辑即撤结论 ----------
function markStale() {
  // 任何编辑（含导入失败后）都立即撤下上一轮的全部结论与错误定位
  els.feasible.hidden = true;
  els.infeasible.hidden = true;
  els.empty.hidden = !hadConclusion;
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = '';
  clearRowErrors();
  if (hadConclusion) els.staleBanner.hidden = false;
  latestNonce += 1; // 使在途的裁决结果失效
  els.hint.classList.remove('computing');
  els.hint.textContent = '';
}

function clearRowErrors() {
  els.vectorsBody.querySelectorAll('tr').forEach((tr) => {
    tr.classList.remove('has-error');
    tr.querySelectorAll('input').forEach((i) => i.classList.remove('invalid'));
    const cell = tr.querySelector('.err-msg');
    if (cell) cell.textContent = '';
  });
  els.weightsGrid.querySelectorAll('input').forEach((i) => i.classList.remove('invalid'));
}

// ---------- 收集模型 ----------
function collectModel() {
  const pinCount = readPinCount();
  const limitRaw = els.limit.value.trim();
  const limit = /^-?\d+$/.test(limitRaw) ? Number.parseInt(limitRaw, 10) : els.limit.value;
  const weights = [...els.weightsGrid.querySelectorAll('input')].map((i) => {
    const s = i.value.trim();
    return /^-?\d+$/.test(s) ? Number.parseInt(s, 10) : s;
  });
  const vectors = [...els.vectorsBody.querySelectorAll('.vector-row')].map((tr) => ({
    id: tr.querySelector('.tf-id').value.trim(),
    bits: tr.querySelector('.tf-bits').value.trim(),
  }));
  return { pinCount, limit, weights, vectors };
}

// ---------- 错误定位 ----------
function showValidationErrors(errors) {
  clearRowErrors();
  const globalLines = [];
  errors.forEach((err) => {
    if (err.scope === 'weight' && err.index != null) {
      const inp = els.weightsGrid.querySelector(`input[data-pin-index="${err.index}"]`);
      if (inp) {
        inp.classList.add('invalid');
        inp.title = err.message;
      }
    } else if (err.scope === 'vector' && err.index != null) {
      const rows = els.vectorsBody.querySelectorAll('.vector-row');
      const tr = rows[err.index];
      if (tr) {
        tr.classList.add('has-error');
        tr.querySelector('.err-msg').textContent = err.message;
        const isBitsMsg = /掩码/.test(err.message);
        tr.querySelector(isBitsMsg ? '.tf-bits' : '.tf-id').classList.add('invalid');
      }
    } else {
      globalLines.push('• ' + err.message);
    }
  });
  els.errorBanner.hidden = false;
  els.errorBanner.textContent =
    `输入有误（${errors.length} 处），已定位如下：\n` +
    (globalLines.length ? globalLines.join('\n') + '\n' : '') +
    errors
      .filter((e) => (e.scope === 'vector' || e.scope === 'weight') && e.index != null)
      .map((e) => `• 第 ${e.index + 1} ${e.scope === 'vector' ? '行向量' : '个引脚'}：${e.message}`)
      .join('\n');
}

function showFatal(text) {
  els.errorBanner.hidden = false;
  els.errorBanner.textContent = text;
}

// ---------- 执行裁决 ----------
function solve() {
  els.staleBanner.hidden = true;
  els.errorBanner.hidden = true;
  clearRowErrors();

  const model = collectModel();
  currentLimit = typeof model.limit === 'number' ? model.limit : null;

  const errors = validateModel(model);
  if (errors.length > 0) {
    hadConclusion = true;
    els.feasible.hidden = true;
    els.infeasible.hidden = true;
    els.empty.hidden = true;
    showValidationErrors(errors);
    return;
  }

  const nonce = ++latestNonce;
  els.hint.classList.add('computing');
  els.hint.textContent = '正在完整比较全部闭环顺序…';
  getWorker().postMessage({ model, nonce });
}

// ---------- 渲染结论 ----------
function renderResult(result) {
  hadConclusion = true;
  els.empty.hidden = true;
  els.staleBanner.hidden = true;
  els.errorBanner.hidden = true;

  if (!result.feasible) {
    els.feasible.hidden = true;
    els.infeasible.hidden = false;
    els.infTotal.textContent = result.totalOrders;
    els.infDiagnosis.innerHTML = renderDiagnosis(result.diagnosis);
    return;
  }

  els.infeasible.hidden = true;
  els.feasible.hidden = false;

  const chain = ['<span class="node">0</span>'];
  result.sequence.forEach((id) => {
    chain.push('<span class="arrow">→</span>', `<span class="node">${escapeHtml(id)}</span>`);
  });
  chain.push('<span class="arrow">→</span>', '<span class="ret">0（全零态）</span>');
  els.orderChain.innerHTML = chain.join(' ');

  els.statFlips.textContent = String(result.totalFlips);
  els.statTotal.textContent = `${result.totalOrders}（${result.sequence.length}! 全排列）`;
  els.statFeasible.textContent = result.feasibleOrders;
  els.solveMeta.textContent =
    `子集 DP 共到达 ${result.reachedStates} 个“已访问集合×末向量”状态；` +
    '每条可行闭环顺序均被计入，最优值与穷举 n! 条排列完全一致。';

  els.stepsBody.innerHTML = '';
  result.steps.forEach((step) => {
    const tr = document.createElement('tr');
    if (step.kind === 'return') tr.className = 'return-row';
    const risingPositions = new Set(step.rising.map((r) => r.pin.slice(1) - 1)); // P 编号 -> 左起 0 基
    const fallingPositions = new Set();
    for (let k = 0; k < step.prevBits.length; k += 1) {
      if (step.prevBits[k] === '1' && step.nextBits[k] === '0') fallingPositions.add(k);
    }
    const prevHtml = colorBits(step.prevBits, new Set(), fallingPositions);
    const nextHtml = colorBits(step.nextBits, risingPositions, new Set());

    const chips = step.rising.length === 0
      ? '<span class="muted">—（无 0→1）</span>'
      : '<div class="rise-chips">' +
        step.rising.map((r) => `<span class="chip">${escapeHtml(r.pin)}(w=${r.weight})</span>`).join('') +
        '</div>';

    const surgeOver = currentLimit != null && step.surge > currentLimit;
    tr.innerHTML = `
      <td class="hop-col">${step.hop}</td>
      <td class="exec-col">${step.kind === 'return' ? '↩ 回到全零态' : escapeHtml(step.vectorId)}</td>
      <td class="bits">${prevHtml}</td>
      <td class="bits">${nextHtml}</td>
      <td>${chips}</td>
      <td class="surge ${surgeOver ? 'over-limit' : ''}">${step.surge}${currentLimit != null ? ` / ${currentLimit}` : ''}</td>
      <td>${step.flips}</td>
      <td><strong>${step.cumulative}</strong></td>`;
    els.stepsBody.append(tr);
  });
}

function colorBits(bits, riseSet, fallSet) {
  let html = '';
  for (let k = 0; k < bits.length; k += 1) {
    const ch = bits[k];
    let cls = ch === '1' ? 'bit1' : 'bit0';
    let title = '';
    if (riseSet.has(k)) {
      cls = 'bit1';
      title = `P${k + 1} 由 0 变 1`; // 出现在“后掩码”
    } else if (fallSet.has(k)) {
      cls = 'bit-fall';
      title = `P${k + 1} 由 1 变 0`; // 出现在“前掩码”
    }
    html += `<span class="${cls}" title="${title}">${ch}</span>`;
  }
  return html;
}

function renderDiagnosis(d) {
  const lis = [];
  lis.push(`从全零安全态首跳即可执行的向量：<strong>${d.canStartCount}</strong> 个`);
  if (d.blockedStartIds.length > 0) {
    lis.push(`首跳浪涌即超限、不能作为第一个执行的向量：${
      d.blockedStartIds.map(escapeHtml).join('、')}（提高限额或为其安排有重叠 1 位的前驱）`);
  }
  if (d.deadEndIds.length > 0) {
    lis.push(`<strong>关键卡点</strong>：向量 ${
      d.deadEndIds.map(escapeHtml).join('、')} 没有任何可行入边——无论排在第几跳，进入它时的 0→1 权重和都超过限额，因此不可能存在闭环顺序`);
  }
  if (d.unreachableIds.length > 0 && d.unreachableIds.join() !== d.deadEndIds.join()) {
    lis.push(`沿“浪涌不超限”的跳转关系，从安全态始终无法到达：${
      d.unreachableIds.map(escapeHtml).join('、')}`);
  }
  return '<ul>' + lis.map((x) => `<li>${x}</li>`).join('') + '</ul>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 导入 / 导出 ----------
function doImport() {
  const { model, errors } = parseImport(els.importText.value);
  markStale();
  if (errors.length > 0) {
    els.errorBanner.hidden = false;
    els.errorBanner.textContent =
      '导入失败，未改动上方录入。问题定位：\n' +
      errors.map((e) => `• ${e.line != null ? `第 ${e.line} 行：` : ''}${e.message}`).join('\n');
    return;
  }
  els.pinCount.value = String(model.pinCount);
  els.limit.value = String(model.limit);
  renderWeights(model.weights);
  els.vectorsBody.innerHTML = '';
  model.vectors.forEach((v) => addVectorRow(v.id, v.bits));
  solve();
}

function doExport() {
  const model = collectModel();
  const errors = validateModel(model);
  if (errors.length > 0) {
    markStale();
    showValidationErrors(errors);
    return;
  }
  els.importText.value = exportModel(model);
}

// ---------- 绑定 ----------
function bind() {
  els.pinCount.addEventListener('change', () => {
    const v = readPinCount();
    if (Number.isInteger(v) && v >= 8 && v <= 20) renderWeights();
    markStale();
  });
  els.limit.addEventListener('input', markStale);
  els.weightsGrid.addEventListener('input', markStale);
  els.vectorsBody.addEventListener('input', markStale);

  els.vectorsBody.addEventListener('click', (e) => {
    const btn = e.target.closest('.delete-btn');
    if (!btn || btn.disabled) return;
    btn.closest('tr').remove();
    renumberRows();
    updateAddDeleteState();
    markStale();
  });

  els.btnAdd.addEventListener('click', () => {
    if (rowCount() < MAX_VECTORS) {
      addVectorRow();
      markStale();
    }
  });
  els.btnSolve.addEventListener('click', solve);
  els.btnImport.addEventListener('click', doImport);
  els.btnExport.addEventListener('click', doExport);
  els.btnSample.addEventListener('click', () => {
    els.pinCount.value = String(SAMPLE.pinCount);
    els.limit.value = String(SAMPLE.limit);
    renderWeights(SAMPLE.weights);
    els.vectorsBody.innerHTML = '';
    SAMPLE.vectors.forEach((v) => addVectorRow(v.id, v.bits));
    els.importText.value = exportModel(SAMPLE);
    markStale();
  });
}

// ---------- 初始化 ----------
renderWeights(SAMPLE.weights);
SAMPLE.vectors.slice(0, MIN_VECTORS).forEach((v) => addVectorRow(v.id, v.bits));
updateAddDeleteState();
bind();
