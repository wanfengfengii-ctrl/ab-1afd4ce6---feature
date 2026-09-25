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
  softCap: $('#soft-cap'),
  pinsTail: $('#pins-tail'),
  weightsGrid: $('#weights-grid'),
  vectorsBody: $('#vectors-body'),
  btnAdd: $('#btn-add'),
  btnSample: $('#btn-sample'),
  btnImport: $('#btn-import'),
  btnExport: $('#btn-export'),
  btnSolve: $('#btn-solve'),
  btnSoftSolve: $('#btn-soft-solve'),
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
  soft: $('#result-soft'),
  softInfeasible: $('#result-soft-infeasible'),
  softChain: $('#soft-chain'),
  softStatTransients: $('#soft-stat-transients'),
  softStatCap: $('#soft-stat-cap'),
  softStatN: $('#soft-stat-n'),
  softMeta: $('#soft-meta'),
  softTransitions: $('#soft-transitions'),
  softInfeasibleBody: $('#soft-infeasible'),
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
      const { type, nonce, result, message, mode } = e.data || {};
      if (nonce !== latestNonce) return; // 已被更新的裁决取代
      els.hint.classList.remove('computing');
      els.hint.textContent = '';
      if (type === 'error') {
        showFatal('求解器内部错误：\n' + message);
        return;
      }
      if (mode === 'soft-start') renderSoftResult(result);
      else renderResult(result);
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
  // 任何编辑（含导入失败后、切换缓变上限）都立即撤下上一轮的全部结论与错误定位，
  // 既有闭环裁决报告与缓变加载报告一并撤下。
  els.feasible.hidden = true;
  els.infeasible.hidden = true;
  els.soft.hidden = true;
  els.softInfeasible.hidden = true;
  els.empty.hidden = !hadConclusion;
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = '';
  clearRowErrors();
  if (hadConclusion) els.staleBanner.hidden = false;
  latestNonce += 1; // 使在途的裁决结果失效（闭环/缓变两种模式都作废）
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
  els.softCap.classList.remove('invalid');
  els.softCap.title = '';
}

// ---------- 收集模型 ----------
function readSoftCap() {
  const raw = els.softCap.value.trim();
  return /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : els.softCap.value;
}

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
  return { pinCount, limit, maxGroupPins: readSoftCap(), weights, vectors };
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
    } else if (err.scope === 'maxGroupPins') {
      els.softCap.classList.add('invalid');
      els.softCap.title = err.message;
      globalLines.push('• ' + err.message);
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
// 既有闭环裁决：严格使用原模型，剥离缓变加载参数，保证语义与原先完全一致。
function closedLoopModel(full) {
  const { maxGroupPins, ...rest } = full;
  return rest;
}

function solve() {
  els.staleBanner.hidden = true;
  els.errorBanner.hidden = true;
  clearRowErrors();

  const model = closedLoopModel(collectModel());
  currentLimit = typeof model.limit === 'number' ? model.limit : null;

  const errors = validateModel(model);
  if (errors.length > 0) {
    hadConclusion = true;
    hideAllResults();
    els.empty.hidden = true;
    showValidationErrors(errors);
    return;
  }

  const nonce = ++latestNonce;
  els.hint.classList.add('computing');
  els.hint.textContent = '正在完整比较全部闭环顺序…';
  getWorker().postMessage({ model, nonce, mode: 'closed-loop' });
}

// ---------- 执行缓变加载规划 ----------
function solveSoft() {
  els.staleBanner.hidden = true;
  els.errorBanner.hidden = true;
  clearRowErrors();

  const model = collectModel();
  currentLimit = typeof model.limit === 'number' ? model.limit : null;

  // 复用同一套录入校验；缓变模式额外要求每阶段引脚上限为 1..20 的整数
  const errors = validateModel(model);
  if (errors.length > 0) {
    hadConclusion = true;
    hideAllResults();
    els.empty.hidden = true;
    showValidationErrors(errors);
    return;
  }

  const nonce = ++latestNonce;
  els.hint.classList.add('computing');
  els.hint.textContent = '正在完整比较每个正式跳转的全部分组与阶段顺序…';
  getWorker().postMessage({ model, nonce, mode: 'soft-start' });
}

function hideAllResults() {
  els.feasible.hidden = true;
  els.infeasible.hidden = true;
  els.soft.hidden = true;
  els.softInfeasible.hidden = true;
}

// ---------- 渲染结论 ----------
function renderResult(result) {
  hadConclusion = true;
  els.empty.hidden = true;
  els.staleBanner.hidden = true;
  els.errorBanner.hidden = true;
  els.soft.hidden = true;
  els.softInfeasible.hidden = true;

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

// ---------- 渲染缓变加载结论 ----------
function renderSoftResult(result) {
  hadConclusion = true;
  els.empty.hidden = true;
  els.staleBanner.hidden = true;
  els.errorBanner.hidden = true;
  els.feasible.hidden = true;
  els.infeasible.hidden = true;

  if (!result.feasible) {
    els.soft.hidden = true;
    els.softInfeasible.hidden = false;
    els.softInfeasibleBody.innerHTML = result.infeasible.map((p) => {
      const target = p.kind === 'return'
        ? '↩ 收尾回零跳'
        : `正式跳转 ${p.hop} → 向量 ${escapeHtml(p.vectorId)}`;
      const rise = p.risePins.length
        ? `待置高引脚：${p.risePins.map((q) => `P${q}`).join('、')}`
        : '无待置高引脚';
      return `<div class="soft-infeasible-item">
        <div><strong>${target}</strong></div>
        <div class="muted small">${rise}</div>
        <div>${escapeHtml(p.reason.message)}</div>
      </div>`;
    }).join('');
    return;
  }

  els.softInfeasible.hidden = true;
  els.soft.hidden = false;

  const chain = ['<span class="node">0</span>'];
  result.sequence.forEach((id) => {
    chain.push('<span class="arrow">→</span>', `<span class="node">${escapeHtml(id)}</span>`);
  });
  chain.push('<span class="arrow">→</span>', '<span class="ret">0（全零态）</span>');
  els.softChain.innerHTML = chain.join(' ');

  els.softStatTransients.textContent = String(result.totalTransients);
  els.softStatCap.textContent = String(result.maxGroupPins);
  els.softStatN.textContent = String(result.sequence.length);
  els.softMeta.textContent =
    '严格按录入/备案顺序执行；每个正式跳转的分组都经过“先最少插入暂态数、同数按各阶段置高引脚 P 序列字典序最小”的完整比较（非逐引脚、非贪心装箱）。';

  els.softTransitions.innerHTML = '';
  result.transitions.forEach((t) => els.softTransitions.append(renderHopCard(t, currentLimit)));
  els.softTransitions.append(renderHopCard(result.returnHop, currentLimit));
}

function renderHopCard(t, limit) {
  const card = document.createElement('div');
  card.className = 'hop-card' + (t.kind === 'return' ? ' return-card' : '');

  const execName = t.kind === 'return'
    ? '↩ 收尾回零（最终回全零）'
    : `跳转 ${t.hop} · 采样向量 ${escapeHtml(t.vectorId)}`;
  const head = document.createElement('div');
  head.className = 'hop-head';
  head.innerHTML = `
    <span class="hop-no">#${t.hop}</span>
    <span class="hop-name">${execName}</span>
    <span class="hop-counts">
      暂态前掩码 <code>${t.prevBits}</code> → 采样点掩码 <code>${t.nextBits}</code>
      · 本跳插入暂态 <strong>${t.insertedTransients}</strong>
      · 置高分组 ${t.riseGroupCount}
      ${t.kind === 'vector' ? `· 累计暂态 <strong>${t.cumulativeTransients}</strong>` : ''}
    </span>`;
  card.append(head);

  const table = document.createElement('table');
  table.className = 'stage-table';
  table.innerHTML = `
    <thead><tr>
      <th>阶段</th><th>暂态前掩码</th><th>暂态后掩码</th>
      <th>置高引脚（权重）</th><th>浪涌/限额</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector('tbody');

  t.stages.forEach((s) => {
    const tr = document.createElement('tr');
    if (s.kind === 'fall') tr.classList.add('stage-row-fall');
    if (s.kind === 'sample') tr.classList.add('stage-row-sample');

    let nameHtml;
    if (s.kind === 'fall') nameHtml = '<span class="fall-tag">↓ 降位暂态（1→0）</span>';
    else if (s.kind === 'sample') nameHtml = '<span class="sample-tag">● 正式采样点</span>';
    else nameHtml = escapeHtml(s.name);

    const pinsHtml = s.pins.length === 0
      ? '<span class="muted">—</span>'
      : '<span class="pins-cell">' +
        s.pins.map((pp) => `<span class="chip">${escapeHtml(pp.pin)}(w=${pp.weight})</span>`).join('') +
        '</span>';

    const surgeText = s.kind === 'fall' || s.kind === 'sample'
      ? '0'
      : `${s.surge}${limit != null ? ` / ${limit}` : ''}`;
    const over = s.kind === 'rise' && limit != null && s.surge > limit;

    tr.innerHTML = `
      <td class="stage-name">${nameHtml}</td>
      <td class="bits">${s.bitsBefore}</td>
      <td class="bits">${s.bitsAfter}</td>
      <td>${pinsHtml}</td>
      <td class="surge-cell ${over ? 'over' : ''}">${surgeText}</td>`;
    tbody.append(tr);
  });

  card.append(table);
  return card;
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
  if (Number.isInteger(model.maxGroupPins)) els.softCap.value = String(model.maxGroupPins);
  renderWeights(model.weights);
  els.vectorsBody.innerHTML = '';
  model.vectors.forEach((v) => addVectorRow(v.id, v.bits));
  // 导入文本含 MAXP（缓变上限）时直接出缓变规划，否则保持原闭环裁决行为
  if (Number.isInteger(model.maxGroupPins)) solveSoft();
  else solve();
}

function doExport() {
  const full = collectModel();
  const { maxGroupPins, ...base } = full;
  const errors = validateModel(base);
  if (errors.length > 0) {
    markStale();
    showValidationErrors(errors);
    return;
  }
  // MAXP 为可选项：仅当上限是 1..20 的整数时才写入导出文本
  const exportObj = Number.isInteger(maxGroupPins) && maxGroupPins >= 1 && maxGroupPins <= 20
    ? { ...base, maxGroupPins }
    : base;
  els.importText.value = exportModel(exportObj);
}

// ---------- 绑定 ----------
function bind() {
  els.pinCount.addEventListener('change', () => {
    const v = readPinCount();
    if (Number.isInteger(v) && v >= 8 && v <= 20) renderWeights();
    markStale();
  });
  els.limit.addEventListener('input', markStale);
  els.softCap.addEventListener('input', markStale); // 上限编辑立即撤下旧报告（两种模式都撤）
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
  els.btnSoftSolve.addEventListener('click', solveSoft);
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
