/**
 * app.js —— 页面交互：
 *   - 闭环加载顺序全局裁决（原有功能，语义不变）；
 *   - 缓变加载（新增）：按录入/备案顺序，逐跳先降位再全局最优分组置高。
 * 两种模式共享同一份录入模型；任一编辑（含切换模式、修改置高上限）立即撤下旧报告。
 */
import { parseImport, exportModel, validateModel, validateRamping } from './solver.js';

const MIN_VECTORS = 4;
const MAX_VECTORS = 12;

const $ = (sel) => document.querySelector(sel);

const els = {
  pinCount: $('#pin-count'),
  limit: $('#limit'),
  maxRisePins: $('#max-rise-pins'),
  modeRadios: document.querySelectorAll('input[name="mode"]'),
  btnSolve: $('#btn-solve'),
  pinsTail: $('#pins-tail'),
  weightsGrid: $('#weights-grid'),
  vectorsBody: $('#vectors-body'),
  btnAdd: $('#btn-add'),
  btnSample: $('#btn-sample'),
  btnImport: $('#btn-import'),
  btnExport: $('#btn-export'),
  importText: $('#import-text'),
  hint: $('#solve-hint'),
  staleBanner: $('#stale-banner'),
  errorBanner: $('#error-banner'),
  empty: $('#result-empty'),
  feasible: $('#result-feasible'),
  infeasible: $('#result-infeasible'),
  rampFeasible: $('#result-ramp-feasible'),
  rampInfeasible: $('#result-ramp-infeasible'),
  orderChain: $('#order-chain'),
  statFlips: $('#stat-flips'),
  statTotal: $('#stat-total'),
  statFeasible: $('#stat-feasible'),
  solveMeta: $('#solve-meta'),
  stepsBody: $('#steps-body'),
  infTotal: $('#inf-total'),
  infDiagnosis: $('#inf-diagnosis'),
  rampOrderChain: $('#ramp-order-chain'),
  rampStatTransients: $('#ramp-stat-transients'),
  rampStatGroups: $('#ramp-stat-groups'),
  rampStatSampled: $('#ramp-stat-sampled'),
  rampJumps: $('#ramp-jumps'),
  rampFailures: $('#ramp-failures'),
  rampPartial: $('#ramp-partial'),
};

// ---------- 模式 ----------
let mode = 'closed'; // 'closed' | 'ramp'

function currentMode() {
  return document.querySelector('input[name="mode"]:checked')?.value === 'ramp' ? 'ramp' : 'closed';
}

function applyMode(nextMode, { stale = true } = {}) {
  mode = nextMode === 'ramp' ? 'ramp' : 'closed';
  document.body.classList.toggle('mode-ramp', mode === 'ramp');
  els.btnSolve.textContent = mode === 'ramp'
    ? '执行缓变加载全局分组'
    : '执行闭环全局裁决';
  if (stale) markStale();
}

// ---------- Worker ----------
let worker = null;
let latestNonce = 0;
let hadConclusion = false;
let currentLimit = null;
let currentCap = null;

function getWorker() {
  if (worker === null) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { type, nonce, result, message, mode: resMode } = e.data || {};
      if (nonce !== latestNonce) return; // 已被更新的裁决取代
      els.hint.classList.remove('computing');
      els.hint.textContent = '';
      if (type === 'error') {
        showFatal('求解器内部错误：\n' + message);
        return;
      }
      if (resMode === 'ramp') renderRampResult(result);
      else renderClosedResult(result);
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
  maxRisePins: 2,
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
  // 任何编辑（含切换模式、修改置高上限、导入失败后）都立即撤下上一轮的全部结论与错误定位
  els.feasible.hidden = true;
  els.infeasible.hidden = true;
  els.rampFeasible.hidden = true;
  els.rampInfeasible.hidden = true;
  els.empty.hidden = !hadConclusion;
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = '';
  els.maxRisePins.classList.remove('invalid');
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
function readIntField(input) {
  const s = input.value.trim();
  return /^-?\d+$/.test(s) ? Number.parseInt(s, 10) : input.value;
}

function collectModel() {
  const pinCount = readPinCount();
  const limit = readIntField(els.limit);
  const maxRisePins = readIntField(els.maxRisePins);
  const weights = [...els.weightsGrid.querySelectorAll('input')].map((i) => {
    const s = i.value.trim();
    return /^-?\d+$/.test(s) ? Number.parseInt(s, 10) : s;
  });
  const vectors = [...els.vectorsBody.querySelectorAll('.vector-row')].map((tr) => ({
    id: tr.querySelector('.tf-id').value.trim(),
    bits: tr.querySelector('.tf-bits').value.trim(),
  }));
  return { pinCount, limit, maxRisePins, weights, vectors };
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
  if (errors.some((e) => e.scope === 'maxRisePins')) els.maxRisePins.classList.add('invalid');
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
  els.maxRisePins.classList.remove('invalid');

  const model = collectModel();
  currentLimit = typeof model.limit === 'number' ? model.limit : null;
  currentCap = typeof model.maxRisePins === 'number' ? model.maxRisePins : null;
  mode = currentMode();

  const errors = mode === 'ramp' ? validateRamping(model) : validateModel(model);
  if (errors.length > 0) {
    hadConclusion = true;
    hideAllResults();
    els.empty.hidden = true;
    showValidationErrors(errors);
    return;
  }

  const nonce = ++latestNonce;
  els.hint.classList.add('computing');
  els.hint.textContent = mode === 'ramp'
    ? '正在逐跳完整枚举全部可行分组与阶段顺序…'
    : '正在完整比较全部闭环顺序…';
  getWorker().postMessage({ model, nonce, mode });
}

function hideAllResults() {
  els.feasible.hidden = true;
  els.infeasible.hidden = true;
  els.rampFeasible.hidden = true;
  els.rampInfeasible.hidden = true;
}

/* ===================== 闭环模式渲染（原有逻辑） ===================== */

function renderClosedResult(result) {
  hadConclusion = true;
  hideAllResults();
  els.empty.hidden = true;
  els.staleBanner.hidden = true;
  els.errorBanner.hidden = true;

  if (!result.feasible) {
    els.infeasible.hidden = false;
    els.infTotal.textContent = result.totalOrders;
    els.infDiagnosis.innerHTML = renderDiagnosis(result.diagnosis);
    return;
  }

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

/* ===================== 缓变模式渲染 ===================== */

function renderPinsChips(pinObjsOrStrings, weights) {
  const items = pinObjsOrStrings.map((p) => {
    if (typeof p === 'string') {
      const w = p.startsWith('P') ? weights[Number.parseInt(p.slice(1), 10) - 1] : null;
      return w == null ? escapeHtml(p) : `${escapeHtml(p)}(w=${w})`;
    }
    return `${escapeHtml(p.pin)}(w=${p.weight})`;
  });
  return items.length === 0
    ? '<span class="muted">—</span>'
    : '<div class="rise-chips">' + items.map((t) => `<span class="chip">${t}</span>`).join('') + '</div>';
}

/** 由阶段相对上一阶段变化，构造位着色（rise：本阶段新置高；fall：本阶段降位） */
function stageBitsHtml(prevBits, bits) {
  const rise = new Set();
  const fall = new Set();
  for (let k = 0; k < bits.length; k += 1) {
    if (prevBits[k] === '0' && bits[k] === '1') rise.add(k);
    if (prevBits[k] === '1' && bits[k] === '0') fall.add(k);
  }
  return colorBits(bits, rise, fall);
}

function rampLine({ phaseClass, label, bitsHtml, pinsHtml, surgeHtml, mark }) {
  return `
    <div class="ramp-line ${phaseClass}">
      <span class="phase">${label}</span>
      <span class="bits">${bitsHtml}</span>
      <span class="pins">${pinsHtml}</span>
      <span class="surge">${surgeHtml}</span>
      <span class="sample-mark">${mark}</span>
    </div>`;
}

function renderRampJump(jump, weights, pinCount, prevLabel) {
  const stagesHtml = [];
  // 切换前：上一正式采样点
  stagesHtml.push(rampLine({
    phaseClass: 'phase-sample',
    label: jump.vectorIndex === 0 ? '起点·全零' : '切换前（采样点）',
    bitsHtml: colorBits(jump.prevBits),
    pinsHtml: '<span class="muted">上一正式采样掩码</span>',
    surgeHtml: '—',
    mark: '✓ 采样点',
  }));

  let prevBits = jump.prevBits;
  jump.stages.forEach((st) => {
    if (st.kind === 'fall') {
      const fallSet = new Set();
      for (let k = 0; k < pinCount; k += 1) {
        if (prevBits[k] === '1' && st.bits[k] === '0') fallSet.add(k);
      }
      stagesHtml.push(rampLine({
        phaseClass: 'phase-transient phase-fall',
        label: `暂态 ${st.ordinal}｜统一降位`,
        bitsHtml: colorBits(st.bits, new Set(), fallSet),
        pinsHtml: `降 ${st.pins.map(escapeHtml).join('、')}`,
        surgeHtml: '浪涌 0（降位不计）',
        mark: '非采样·暂态',
      }));
    } else {
      stagesHtml.push(rampLine({
        phaseClass: 'phase-transient phase-rise',
        label: `暂态 ${st.ordinal}｜置高组`,
        bitsHtml: stageBitsHtml(prevBits, st.bits),
        pinsHtml: renderPinsChips(st.pins, weights),
        surgeHtml: `浪涌 ${st.surge} / ${currentLimit}　${st.count} 脚 / ≤ ${currentCap}`,
        mark: '非采样·暂态',
      }));
    }
    prevBits = st.bits;
  });

  // 正式采样：目标掩码
  const riseObjs = jump.risePins;
  stagesHtml.push(rampLine({
    phaseClass: 'phase-sample',
    label: `正式采样 ${escapeHtml(jump.vectorId)}`,
    bitsHtml: stageBitsHtml(prevBits, jump.targetBits),
    pinsHtml: riseObjs.length
      ? `本跳置高合计 ${renderPinsChips(riseObjs, weights)}`
      : '<span class="muted">本跳无 0→1</span>',
    surgeHtml: '—',
    mark: '✓ 原掩码处采样',
  }));

  const fallN = jump.fallPins.length;
  const tag = `降位暂态 ${fallN} 个 ＋ 置高组 ${jump.groupCount} 组 ＝ ${jump.transientCount} 个暂态`;
  return `
    <div class="ramp-jump" data-vector="${escapeHtml(jump.vectorId)}">
      <div class="ramp-jump-head">
        <span class="exec">正式跳转 ${jump.vectorIndex + 1}：${escapeHtml(prevLabel)} → ${escapeHtml(jump.vectorId)}</span>
        <span class="tag">${tag}</span>
        <span class="tag">累计暂态 ${jump.cumulativeTransients}</span>
      </div>
      <div class="ramp-flow">${stagesHtml.join('')}</div>
    </div>`;
}

function renderRampReturn(ret) {
  const pinCount = ret.targetBits.length;
  const lines = [];
  lines.push(rampLine({
    phaseClass: 'phase-sample',
    label: '回零前（采样点）',
    bitsHtml: colorBits(ret.prevBits),
    pinsHtml: '<span class="muted">最后一个正式采样掩码</span>',
    surgeHtml: '—',
    mark: '✓ 采样点',
  }));
  if (ret.stages.length > 0) {
    const st = ret.stages[0];
    const fallSet = new Set();
    for (let k = 0; k < pinCount; k += 1) {
      if (ret.prevBits[k] === '1' && st.bits[k] === '0') fallSet.add(k);
    }
    lines.push(rampLine({
      phaseClass: 'phase-transient phase-fall',
      label: '暂态｜统一降位回零',
      bitsHtml: colorBits(st.bits, new Set(), fallSet),
      pinsHtml: `降 ${st.pins.map(escapeHtml).join('、')}`,
      surgeHtml: '浪涌 0（降位不计）',
      mark: '非采样·暂态',
    }));
  }
  lines.push(rampLine({
    phaseClass: 'phase-sample phase-return',
    label: '正式采样·全零',
    bitsHtml: colorBits(ret.targetBits),
    pinsHtml: '<span class="muted">回到全零安全态</span>',
    surgeHtml: '—',
    mark: '✓ 全零处采样',
  }));
  return `
    <div class="ramp-jump">
      <div class="ramp-jump-head">
        <span class="exec">收尾回零：… → 0（全零态）</span>
        <span class="tag">${ret.stages.length > 0 ? '1 个降位暂态' : '末态已为全零，无暂态'}</span>
        <span class="tag">累计暂态 ${ret.cumulativeTransients}</span>
      </div>
      <div class="ramp-flow">${lines.join('')}</div>
    </div>`;
}

function renderRampResult(result) {
  hadConclusion = true;
  hideAllResults();
  els.empty.hidden = true;
  els.staleBanner.hidden = true;
  els.errorBanner.hidden = true;

  const weights = collectModel().weights.map((w) => (typeof w === 'number' ? w : null));
  const pinCount = result.jumps[0]
    ? result.jumps[0].targetBits.length
    : (result.failures[0] ? result.failures[0].targetBits.length : readPinCount());

  if (!result.feasible) {
    els.rampInfeasible.hidden = false;
    els.rampFailures.innerHTML = renderRampFailures(result.failures);
    // 已成功规划的正式跳转仍展示（灰显参考）
    if (result.jumps.length > 0) {
      els.rampPartial.hidden = false;
      els.rampPartial.innerHTML =
        '<h3 class="muted small">下列正式跳转在卡点之前/之外已可成功规划（仅供参考）</h3>' +
        result.jumps.map((j) =>
          renderRampJump(j, weights, pinCount, j.vectorIndex === 0 ? '0（全零）' : result.order[j.vectorIndex - 1]))
        .join('');
    } else {
      els.rampPartial.hidden = true;
      els.rampPartial.innerHTML = '';
    }
    return;
  }

  els.rampFeasible.hidden = false;

  // 顶部顺序链：在每个正式向量处标注采样
  const chain = ['<span class="node">0（全零·采样）</span>'];
  result.order.forEach((id, i) => {
    const j = result.jumps[i];
    const note = j ? `（前置 ${j.transientCount} 暂态）` : '';
    chain.push('<span class="arrow">⇒</span>',
      `<span class="node">${escapeHtml(id)}·采样</span><span class="muted small">${note}</span>`);
  });
  chain.push('<span class="arrow">⇒</span>', '<span class="ret">0（全零·采样）</span>');
  els.rampOrderChain.innerHTML = chain.join(' ');

  els.rampStatTransients.textContent = String(result.totalTransients);
  els.rampStatGroups.textContent = String(result.totalGroups);
  els.rampStatSampled.textContent = `${result.sampledCount + 1}（${result.sampledCount} 个正式向量 ＋ 回零）`;

  els.rampJumps.innerHTML =
    result.jumps.map((j, i) =>
      renderRampJump(j, weights, pinCount, j.vectorIndex === 0 ? '0（全零）' : result.order[j.vectorIndex - 1]))
    .join('') +
    renderRampReturn(result.returnJump);
}

function renderRampFailures(failures) {
  return failures.map((f) => {
    const riseChips = renderPinsChips(f.risePins, null).replace(/\(w=\d+\)/g, '');
    const detail = f.reason === 'overweight'
      ? `<ul>
          <li>该跳需要置高的引脚：${f.risePins.map((p) => `${escapeHtml(p.pin)}(w=${p.weight})`).join('、') || '—'}</li>
          <li><strong>单引脚权重已超过浪涌限额 ${currentLimit}</strong>：
            ${f.overloadPins.map((p) => `${escapeHtml(p.pin)} 权重 ${p.weight} ＞ ${currentLimit}`).join('、')}。
            该引脚即使独占一个置高组也必然越限——任何分组都不可行。</li>
          <li>定位：录入第 ${f.vectorIndex + 1} 行向量 ${escapeHtml(f.vectorId)}
            （备案顺序下第 ${f.vectorIndex + 1} 个正式跳转）；前掩码 <code>${f.prevBits}</code>，
            目标采样掩码 <code>${f.targetBits}</code>。</li>
          <li>处置建议：提高浪涌限额、降低该引脚权重，或调整该向量在备案序列中的相邻向量（使该位此前已为高，无需置高）。</li>
        </ul>`
      : `<ul>
          <li>该跳待置高引脚：${riseChips}</li>
          <li><strong>在“每组权重和 ≤ ${currentLimit}、每组引脚数 ≤ ${currentCap}”约束下，
            不存在覆盖全部待置高引脚的有序分组</strong>（已完整枚举全部可行组与全部阶段顺序，非贪心结论）。</li>
          <li>无法被任何可行组覆盖的引脚：${
            (f.uncoveredPins || []).map((p) => `${escapeHtml(p.pin)}(w=${p.weight})`).join('、') || '—'}</li>
          <li>定位：录入第 ${f.vectorIndex + 1} 行向量 ${escapeHtml(f.vectorId)}；前掩码 <code>${f.prevBits}</code>，
            目标采样掩码 <code>${f.targetBits}</code>。</li>
          <li>处置建议：提高浪涌限额或每阶段置高引脚数上限，或调整备案相邻向量以减少同跳置高引脚。</li>
        </ul>`;
    return `<div class="ramp-fail">
      <div class="rf-title">正式跳转 ${f.vectorIndex + 1}（向量 ${escapeHtml(f.vectorId)}）无法规划：${
        f.reason === 'overweight' ? '单引脚权重超过限额' : '约束下无法完成分组'
      }</div>${detail}</div>`;
  }).join('');
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
  if (Number.isInteger(model.maxRisePins)) els.maxRisePins.value = String(model.maxRisePins);
  renderWeights(model.weights);
  els.vectorsBody.innerHTML = '';
  model.vectors.forEach((v) => addVectorRow(v.id, v.bits));
  solve();
}

function doExport() {
  const model = collectModel();
  // 两种模式共享同一份模型校验（闭环模式不强制 MAXRISE）
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
  els.modeRadios.forEach((radio) => radio.addEventListener('change', () => applyMode(currentMode())));

  els.pinCount.addEventListener('change', () => {
    const v = readPinCount();
    if (Number.isInteger(v) && v >= 8 && v <= 20) renderWeights();
    markStale();
  });
  els.limit.addEventListener('input', markStale);
  els.maxRisePins.addEventListener('input', markStale);
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
    els.maxRisePins.value = String(SAMPLE.maxRisePins);
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
applyMode('closed', { stale: false });
