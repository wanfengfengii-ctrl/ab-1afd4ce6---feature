/**
 * solver.js —— 扫描向量浪涌约束闭环排序核心（纯逻辑，无 DOM 依赖）
 *
 * 位约定：
 *   二进制掩码字符串自左向右第 k 个字符对应引脚 P(k+1)（k 从 0 起）。
 *   内部用整数保存掩码：字符串最右位为 bit0，引脚 Pj 对应 bit(pinCount-j)。
 *
 * 问题定义：
 *   - n 个唯一编号向量（4 ≤ n ≤ 12），统一使用 pinCount 位掩码（8 ≤ pinCount ≤ 20）；
 *   - 设备从全零安全态出发，每个向量恰好执行一次，最后回到全零态；
 *   - 一跳的浪涌 = 该跳中由 0 变 1 的引脚权重之和，要求每跳 ≤ limit（1→0 不计浪涌）；
 *   - 目标：在所有可行闭环顺序中，先取“全程翻转位数”最小者，
 *     并列时按向量编号序列的字典序取最小；
 *   - 必须做全局裁决，禁止用逐跳贪心替代。
 *
 * 算法：子集动态规划（Held–Karp 形态）。
 *   dp[S][i] = 已访问集合 S、末向量为 i 的最优前缀（翻转位数，编号字典序）。
 *   转移可行性只依赖“上一个向量的掩码”，与更早的历史无关，故 DP 精确等价于
 *   穷举全部 n! 个闭环排列；不可行的边与被支配前缀在枚举中被剪枝，但不影响最优性。
 *   n=12 时状态数仅 2^12×12 ≈ 4.9 万，可完整裁决。
 */

export const MIN_VECTORS = 4;
export const MAX_VECTORS = 12;
export const MIN_PINS = 8;
export const MAX_PINS = 20;
const INTEGER_RE = /^-?\d+$/;

function isInt(value) {
  return Number.isInteger(value);
}

/** 二进制字符串 -> 整数掩码（最右字符为 bit0） */
export function maskFromBits(bits) {
  return Number.parseInt(bits, 2);
}

/** 整数掩码 -> 定长二进制字符串（左为 P1） */
export function maskToBinary(mask, pinCount) {
  let out = '';
  for (let k = 0; k < pinCount; k += 1) {
    const bitPos = pinCount - 1 - k;
    out += (mask & (1 << bitPos)) !== 0 ? '1' : '0';
  }
  return out;
}

/** 一跳中由 0 变 1 的引脚编号列表（P 编号，升序） */
export function risingPinList(prevMask, nextMask, pinCount) {
  const list = [];
  for (let bitPos = pinCount - 1; bitPos >= 0; bitPos -= 1) {
    const bit = 1 << bitPos;
    if ((nextMask & bit) !== 0 && (prevMask & bit) === 0) {
      list.push(pinCount - bitPos); // bitPos = pinCount-pinNumber
    }
  }
  return list;
}

/** 一跳浪涌：仅统计由 0 变 1 的引脚权重。weights[k] 对应 P(k+1) */
export function hopSurge(prevMask, nextMask, pinCount, weights) {
  let sum = 0;
  for (let bitPos = 0; bitPos < pinCount; bitPos += 1) {
    const bit = 1 << bitPos;
    if ((nextMask & bit) !== 0 && (prevMask & bit) === 0) {
      sum += weights[pinCount - 1 - bitPos];
    }
  }
  return sum;
}

/** 一跳翻转位数（0→1 与 1→0 都计翻转） */
export function hopFlips(prevMask, nextMask) {
  return popCount(prevMask ^ nextMask);
}

export function popCount(mask) {
  let x = mask >>> 0;
  let count = 0;
  while (x > 0) {
    x &= x - 1;
    count += 1;
  }
  return count;
}

/** 编号序列字典序比较（按编号字符串的码点序），a<b 返回负数 */
function compareIdSeq(seqA, seqB, ids) {
  const len = Math.min(seqA.length, seqB.length);
  for (let k = 0; k < len; k += 1) {
    const sa = ids[seqA[k]];
    const sb = ids[seqB[k]];
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return seqA.length - seqB.length;
}

/**
 * 校验页面模型。
 * model = { pinCount, limit, weights:[...], vectors:[{id, bits}] }
 * 返回错误数组：[{ scope, index, message }]，空数组表示通过。
 */
export function validateModel(model) {
  const errors = [];
  const pinCount = model == null ? null : model.pinCount;

  if (!isInt(pinCount) || pinCount < MIN_PINS || pinCount > MAX_PINS) {
    errors.push({
      scope: 'pins',
      message: `掩码位数必须是 ${MIN_PINS}–${MAX_PINS} 之间的整数（当前：${String(pinCount)}）`,
    });
    return errors; // 位数不合法时其余检查无法定位，直接返回
  }

  if (!isInt(model.limit) || model.limit < 0) {
    errors.push({ scope: 'limit', message: '浪涌限额必须是不小于 0 的整数' });
  }

  if (!Array.isArray(model.weights) || model.weights.length !== pinCount) {
    errors.push({
      scope: 'weights',
      message: `需要恰好 ${pinCount} 个引脚权重（当前 ${Array.isArray(model.weights) ? model.weights.length : 0} 个）`,
    });
  } else {
    model.weights.forEach((w, i) => {
      if (!isInt(w) || w < 0) {
        errors.push({
          scope: 'weight',
          index: i,
          message: `引脚 P${i + 1} 的权重必须是不小于 0 的整数（当前：${String(w)}）`,
        });
      }
    });
  }

  const vectors = Array.isArray(model.vectors) ? model.vectors : [];
  if (vectors.length < MIN_VECTORS || vectors.length > MAX_VECTORS) {
    errors.push({
      scope: 'vectors',
      message: `向量数量必须在 ${MIN_VECTORS}–${MAX_VECTORS} 之间（当前：${vectors.length}）`,
    });
  }

  const seenIds = new Map();
  vectors.forEach((v, i) => {
    const id = typeof v.id === 'string' ? v.id.trim() : '';
    if (id === '') {
      errors.push({ scope: 'vector', index: i, message: `第 ${i + 1} 行向量缺少编号` });
    } else if (seenIds.has(id)) {
      errors.push({
        scope: 'vector',
        index: i,
        message: `向量编号 "${id}" 重复，首次出现在第 ${seenIds.get(id) + 1} 行`,
      });
    } else {
      seenIds.set(id, i);
    }
    if (typeof v.bits !== 'string' || !new RegExp(`^[01]{${pinCount}}$`).test(v.bits)) {
      errors.push({
        scope: 'vector',
        index: i,
        message: `向量 ${id || `第 ${i + 1} 行`} 的掩码必须是恰好 ${pinCount} 位的 0/1 字符串（当前：${String(v.bits)}）`,
      });
    }
  });

  return errors;
}

/**
 * 解析导入文本。
 * 格式（# 开头为注释，空行忽略，关键字大小写不敏感）：
 *   PINS 12
 *   LIMIT 100
 *   W 5 3 8 2 ...        # 恰好 PINS 个整数，顺序 P1..Pn
 *   V1 001010101000
 *   V2 110000010100
 * 返回 { model, errors:[{line, message}] }。
 */
export function parseImport(text) {
  const errors = [];
  let pinCount = null;
  let limit = null;
  let weights = null;
  let maxRisePins = null;
  let pinsLine = null;
  let limitLine = null;
  let weightsLine = null;
  let maxRiseLine = null;
  const vectors = [];
  const vectorLines = [];

  const rawLines = String(text == null ? '' : text).split(/\r?\n/);
  rawLines.forEach((raw, lineIdx) => {
    const lineNo = lineIdx + 1;
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') return;
    const parts = line.split(/\s+/);
    const keyword = parts[0].toUpperCase();

    if (keyword === 'PINS') {
      if (pinCount !== null) {
        errors.push({ line: lineNo, message: 'PINS 重复定义' });
        return;
      }
      if (parts.length !== 2 || !INTEGER_RE.test(parts[1])) {
        errors.push({ line: lineNo, message: 'PINS 语法应为：PINS <8–20 的整数>' });
        return;
      }
      pinsLine = lineNo;
      pinCount = Number.parseInt(parts[1], 10);
      if (pinCount < MIN_PINS || pinCount > MAX_PINS) {
        errors.push({ line: lineNo, message: `PINS 必须在 ${MIN_PINS}–${MAX_PINS} 之间（当前：${pinCount}）` });
      }
      return;
    }

    if (keyword === 'LIMIT') {
      if (limit !== null) {
        errors.push({ line: lineNo, message: 'LIMIT 重复定义' });
        return;
      }
      if (parts.length !== 2 || !INTEGER_RE.test(parts[1])) {
        errors.push({ line: lineNo, message: 'LIMIT 语法应为：LIMIT <非负整数>' });
        return;
      }
      limitLine = lineNo;
      limit = Number.parseInt(parts[1], 10);
      if (limit < 0) errors.push({ line: lineNo, message: 'LIMIT 不能为负数' });
      return;
    }

    if (keyword === 'W' || keyword === 'WEIGHTS') {
      if (weights !== null) {
        errors.push({ line: lineNo, message: '权重行 W 重复定义' });
        return;
      }
      const values = parts.slice(1);
      if (values.length === 0 || values.some((s) => !INTEGER_RE.test(s))) {
        errors.push({ line: lineNo, message: '权重行语法应为：W <非负整数> ...（与引脚一一对应）' });
        return;
      }
      weightsLine = lineNo;
      weights = values.map((s) => Number.parseInt(s, 10));
      return;
    }

    if (keyword === RAMP_KEYWORD) {
      // 可选指令：缓变加载每阶段最多同时置高的引脚数
      if (maxRisePins !== null) {
        errors.push({ line: lineNo, message: `${RAMP_KEYWORD} 重复定义` });
        return;
      }
      if (parts.length !== 2 || !INTEGER_RE.test(parts[1])) {
        errors.push({ line: lineNo, message: `${RAMP_KEYWORD} 语法应为：${RAMP_KEYWORD} <1–引脚数 的整数>` });
        return;
      }
      maxRiseLine = lineNo;
      maxRisePins = Number.parseInt(parts[1], 10);
      if (maxRisePins < 1) errors.push({ line: lineNo, message: `${RAMP_KEYWORD} 必须不小于 1` });
      return;
    }

    // 其余一律按“编号 掩码”向量行处理
    if (parts.length !== 2) {
      errors.push({ line: lineNo, message: `无法识别的行（应为“编号 掩码”，或 PINS/LIMIT/W 指令）：${raw.trim()}` });
      return;
    }
    const [id, bits] = parts;
    if (!/^[01]+$/.test(bits)) {
      errors.push({ line: lineNo, message: `向量 ${id} 的掩码只能包含 0/1（当前：${bits}）` });
      return;
    }
    vectorLines.push(lineNo);
    vectors.push({ id, bits });
  });

  if (pinsLine === null) errors.push({ line: null, message: '缺少 PINS 指令' });
  if (limitLine === null) errors.push({ line: null, message: '缺少 LIMIT 指令' });
  if (weightsLine === null) errors.push({ line: null, message: '缺少权重行 W' });

  const model = { pinCount, limit, weights, maxRisePins: maxRisePins == null ? null : maxRisePins, vectors };

  // 语义校验（位数/数量/取值/重复编号/掩码长度），把定位映射到源行号。
  // 仅做通用模型校验：maxRisePins 缺失（未写 MAXRISE 指令）时不在导入阶段报错，
  // 由页面在启用缓变加载时单独校验。
  if (errors.length === 0) {
    validateModel(model).forEach((err) => {
      let line = null;
      if (err.scope === 'pins') line = pinsLine;
      else if (err.scope === 'limit') line = limitLine;
      else if (err.scope === 'weights' || err.scope === 'weight') line = weightsLine;
      else if ((err.scope === 'vector' || err.scope === 'vectors') && err.index != null) {
        line = vectorLines[err.index];
      }
      errors.push({ line, message: err.message });
    });
  }

  if (errors.length === 0 && maxRisePins !== null && maxRisePins > pinCount) {
    errors.push({ line: maxRiseLine, message: `${RAMP_KEYWORD} 不能大于掩码位数（${pinCount}）` });
  }

  return { model, errors };
}

/**
 * 导出文本（与 parseImport 互逆）。
 * model.maxRisePins 为正整数时追加 MAXRISE 行；缺省（null/undefined）时省略，
 * 因此不含该字段的旧模型导出结果与历史格式逐字节一致。
 */
export function exportModel(model) {
  const lines = [];
  lines.push(`PINS ${model.pinCount}`);
  lines.push(`LIMIT ${model.limit}`);
  lines.push(`W ${model.weights.join(' ')}`);
  if (isInt(model.maxRisePins) && model.maxRisePins >= 1) {
    lines.push(`${RAMP_KEYWORD} ${model.maxRisePins}`);
  }
  model.vectors.forEach((v) => lines.push(`${v.id} ${v.bits}`));
  return lines.join('\n') + '\n';
}

function factorial(n) {
  let f = 1n;
  for (let i = 2; i <= n; i += 1) f *= BigInt(i);
  return f;
}

/**
 * 不可行性诊断：从虚拟起点（全零态）沿可行边做可达性分析，定位卡点。
 * 返回 { unreachableIds, canStartIds, notes }
 */
export function diagnose(model) {
  const n = model.vectors.length;
  const ids = model.vectors.map((v) => v.id);
  const masks = model.vectors.map((v) => maskFromBits(v.bits));
  const { pinCount, weights, limit } = model;

  // surgeFrom[i]：向量 i 作为后继时，来自各前驱的浪涌；前驱 -1 表示全零态
  const canStart = [];
  for (let j = 0; j < n; j += 1) {
    canStart.push(hopSurge(0, masks[j], pinCount, weights) <= limit);
  }
  const edge = Array.from({ length: n }, () => new Array(n).fill(false));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i !== j) edge[i][j] = hopSurge(masks[i], masks[j], pinCount, weights) <= limit;
    }
  }

  const reachable = new Array(n).fill(false);
  const queue = [];
  canStart.forEach((ok, j) => {
    if (ok) {
      reachable[j] = true;
      queue.push(j);
    }
  });
  while (queue.length > 0) {
    const i = queue.shift();
    for (let j = 0; j < n; j += 1) {
      if (!reachable[j] && edge[i][j]) {
        reachable[j] = true;
        queue.push(j);
      }
    }
  }

  const unreachableIds = ids.filter((_, j) => !reachable[j]);
  const blockedStartIds = ids.filter((_, j) => !canStart[j]);

  // 入度（含起点）全被浪涌卡死的向量
  const deadEndIds = [];
  for (let j = 0; j < n; j += 1) {
    if (reachable[j]) continue;
    let anyIn = canStart[j];
    for (let i = 0; i < n && !anyIn; i += 1) anyIn = edge[i][j];
    if (!anyIn) deadEndIds.push(ids[j]);
  }

  return {
    unreachableIds,
    blockedStartIds,
    deadEndIds,
    canStartCount: canStart.filter(Boolean).length,
  };
}

/**
 * 全局裁决求解。
 * 成功返回：
 * { ok:true, feasible:true, sequence:[idx...], steps:[...], totalFlips,
 *   totalOrders:bigint, feasibleOrders:bigint, reachedStates }
 * 无解返回：{ ok:true, feasible:false, totalOrders, feasibleOrders:0n, diagnosis }
 * 输入非法返回：{ ok:false, errors:[...] }
 */
export function solveModel(model) {
  const errors = validateModel(model);
  if (errors.length > 0) return { ok: false, errors };

  const { pinCount, weights, limit } = model;
  const vectors = model.vectors;
  const n = vectors.length;
  const ids = vectors.map((v) => v.id);
  const masks = vectors.map((v) => maskFromBits(v.bits));
  const totalOrders = factorial(n);

  // 边浪涌矩阵：startSurge[j] = 0 -> j；surge[i][j] = i -> j
  const startSurge = masks.map((mk) => hopSurge(0, mk, pinCount, weights));
  const surge = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j ? null : hopSurge(masks[i], masks[j], pinCount, weights),
    ),
  );

  const subsetCount = 1 << n;
  // best[S][i] = { f:Number, seq:number[] } 或 null
  const best = Array.from({ length: subsetCount }, () => new Array(n).fill(null));
  // count[S][i]：到达该状态的可行前缀数量（BigInt）
  const count = Array.from({ length: subsetCount }, () => new Array(n).fill(0n));

  let reachedStates = 0;

  // 初始跳：全零态 -> 向量 j（浪涌超限不可作为首跳）
  for (let j = 0; j < n; j += 1) {
    if (startSurge[j] <= limit) {
      const S = 1 << j;
      best[S][j] = { f: popCount(masks[j]), seq: [j] };
      count[S][j] = 1n;
      reachedStates += 1;
    }
  }

  for (let S = 1; S < subsetCount; S += 1) {
    for (let last = 0; last < n; last += 1) {
      const cur = best[S][last];
      if (cur === null) continue;
      for (let next = 0; next < n; next += 1) {
        if ((S & (1 << next)) !== 0) continue;
        if (surge[last][next] > limit) continue; // 浪涌超限：该闭环顺序在此跳非法
        const S2 = S | (1 << next);
        const added = popCount(masks[last] ^ masks[next]);
        const candidate = { f: cur.f + added, seq: cur.seq.concat(next) };
        const prev = best[S2][next];
        count[S2][next] += count[S][last];
        if (prev === null) {
          best[S2][next] = candidate;
          reachedStates += 1;
        } else if (candidate.f < prev.f ||
          (candidate.f === prev.f && compareIdSeq(candidate.seq, prev.seq, ids) < 0)) {
          best[S2][next] = candidate;
        }
      }
    }
  }

  const full = subsetCount - 1;
  let feasibleOrders = 0n;
  for (let last = 0; last < n; last += 1) feasibleOrders += count[full][last];

  if (feasibleOrders === 0n) {
    return {
      ok: true,
      feasible: false,
      totalOrders,
      feasibleOrders: 0n,
      reachedStates,
      diagnosis: diagnose(model),
    };
  }

  // 闭合跳：末向量 -> 全零态。0→1 引脚为空，浪涌恒为 0，翻转 = popCount(末掩码)
  let winner = null;
  let winnerTotal = Infinity;
  for (let last = 0; last < n; last += 1) {
    const cur = best[full][last];
    if (cur === null) continue;
    const total = cur.f + popCount(masks[last]);
    if (winner === null || total < winnerTotal ||
      (total === winnerTotal && compareIdSeq(cur.seq, winner.seq, ids) < 0)) {
      winner = cur;
      winnerTotal = total;
    }
  }

  // 展开逐步明细（含闭合跳，共 n+1 跳）
  const steps = [];
  let cumulative = 0;
  let prevMask = 0;
  winner.seq.forEach((idx, hop) => {
    const nextMask = masks[idx];
    const rising = risingPinList(prevMask, nextMask, pinCount)
      .map((pinNo) => ({ pin: `P${pinNo}`, weight: weights[pinNo - 1] }));
    const surgeValue = hop === 0
      ? startSurge[idx]
      : surge[winner.seq[hop - 1]][idx];
    const flips = popCount(prevMask ^ nextMask);
    cumulative += flips;
    steps.push({
      hop: hop + 1,
      kind: 'vector',
      vectorId: ids[idx],
      prevMask,
      nextMask,
      prevBits: maskToBinary(prevMask, pinCount),
      nextBits: maskToBinary(nextMask, pinCount),
      rising,
      surge: surgeValue,
      flips,
      cumulative,
    });
    prevMask = nextMask;
  });
  const lastMask = masks[winner.seq[winner.seq.length - 1]];
  const closeFlips = popCount(lastMask);
  cumulative += closeFlips;
  steps.push({
    hop: n + 1,
    kind: 'return',
    vectorId: null,
    prevMask: lastMask,
    nextMask: 0,
    prevBits: maskToBinary(lastMask, pinCount),
    nextBits: maskToBinary(0, pinCount),
    rising: [],
    surge: 0,
    flips: closeFlips,
    cumulative,
  });

  return {
    ok: true,
    feasible: true,
    sequence: winner.seq.map((i) => ids[i]),
    sequenceIndexes: winner.seq,
    steps,
    totalFlips: winnerTotal,
    totalOrders,
    feasibleOrders,
    reachedStates,
  };
}


/* ==========================================================================
 * 缓变加载（已备案向量编号顺序模式）
 *
 * 与上面“闭环全局裁决”并存、语义相互独立的第二种模式：
 *   - 严格按“当前录入顺序”执行正式向量（不做重排），从全零出发、最终回零；
 *   - 每个正式向量仍在其原掩码处采样：正式跳转的采样掩码就是向量本身；
 *   - 每次正式跳转前允许插入仅用于切换的暂态：
 *       1) 先一次性完成全部降位（1→0），得到前掩码与目标掩码的交集；
 *       2) 再把全部待置高引脚（0→1）划分为若干有序非空组依次置高；
 *   - 每个置高组必须同时满足：
 *       · 组内引脚权重和 ≤ 既有浪涌限额 limit（与闭环裁决同一个限额）；
 *       · 组内引脚数 ≤ maxRisePins（每个切换阶段最多同时置高的引脚数，新上限）；
 *   - 降位不产生浪涌、也不计入置高组引脚数。
 *
 * 全局裁决（禁止逐引脚试探或贪心装箱代替）：
 *   1. 先取全程插入的暂态总数最少（= Σ 各正式跳的“降位态（有降位时 1 个）+
 *      置高组数”，再加收尾回零的 1 个降位态）的方案；
 *   2. 暂态总数并列时，按“各阶段置高引脚的 P 序列”字典序取最小——
 *      所有置高阶段按时间先后排列，逐阶段比较升序 P 编号序列
 *      （[P1,P3] < [P1,P4] < [P2]）。
 *
 * 精确性：每一跳都穷举待置高引脚的全部“可行有序集合划分”。可行块（满足
 * 引脚数 ≤ maxRisePins、权重和 ≤ limit 的非空引脚子集）按 P 序列字典序生成；
 * 记忆化搜索 findFirst(已置位集合, 剩余阶段预算) 返回该状态下字典序最小的
 * 完整划分。顶层从阶段数下界 ceil(k/maxRisePins) 起逐档尝试，首个成功档位
 * 即为最少暂态方案；这不是贪心装箱——它对“全部组划分 × 全部阶段顺序”做
 * 完整裁决，字典序生成顺序只保证首个可行解即全局字典序最优，不剪去任何
 * 可能更优的划分。
 * 跨跳之间：总暂态数为各跳暂态数之和、P 序列按跳先后拼接，故逐跳最优即
 * 全程最优，无需在跳与跳之间再做联合枚举。
 * ========================================================================== */

/**
 * 校验缓变加载参数。在通用 validateModel 之上追加：
 *   maxRisePins 必须是 1..pinCount 的整数。
 * 返回错误数组（新增错误 scope: 'maxRisePins'），空数组表示通过。
 */
export function validateRamping(model) {
  const errors = validateModel(model);
  const pinCount = model == null ? null : model.pinCount;
  const maxPins = Number.isInteger(pinCount) && pinCount >= MIN_PINS && pinCount <= MAX_PINS
    ? pinCount
    : null;
  const v = model == null ? null : model.maxRisePins;
  if (!isInt(v) || v < 1 || (maxPins !== null && v > maxPins)) {
    errors.push({
      scope: 'maxRisePins',
      message: `每阶段置高引脚数上限必须是 1${maxPins !== null ? `–${maxPins}` : ''} 之间的整数（当前：${String(v)}）`,
    });
  }
  return errors;
}

/** 导入文本中“每阶段置高引脚数上限”的指令关键字 */
export const RAMP_KEYWORD = 'MAXRISE';

/**
 * 枚举全部可行置高块。
 * 入参 pins：[{ bitPos, pinNo, weight }]（顺序任意，内部按 P 编号升序处理）。
 * 返回块数组，按块的升序 P 编号序列字典序排列：
 *   { mask(位掩码), pinNos:[升序 P 编号], count, surge }
 * 只包含 1 ≤ 引脚数 ≤ maxRisePins、权重和 ≤ limit 的非空子集。
 */
function enumerateRiseBlocks(pins, limit, maxRisePins) {
  const sorted = pins.slice().sort((a, b) => a.pinNo - b.pinNo);
  const blocks = [];

  const recurse = (start, chosenMask, chosenPins, count, weight) => {
    if (count > 0 && count <= maxRisePins && weight <= limit) {
      blocks.push({
        mask: chosenMask,
        pinNos: chosenPins.slice(),
        count,
        surge: weight,
      });
    }
    if (count === maxRisePins) return;
    for (let i = start; i < sorted.length; i += 1) {
      const p = sorted[i];
      // 权重非负：把“这一个”更重的引脚加入只会使本组权重和上升，故跳过该元素
      // （注意是 continue 而非 break：后续更轻的引脚仍需逐一尝试）
      if (weight + p.weight > limit) continue;
      chosenPins.push(p.pinNo);
      recurse(i + 1, chosenMask | (1 << p.bitPos), chosenPins, count + 1, weight + p.weight);
      chosenPins.pop();
    }
  };

  recurse(0, 0, [], 0, 0);
  // DFS 按升序下标前缀展开，产出顺序已是 P 序列字典序；显式排序以固定契约
  blocks.sort((a, b) => comparePinSeq(a.pinNos, b.pinNos));
  return blocks;
}

/** 升序引脚编号序列字典序比较，a<b 返回负数 */
function comparePinSeq(a, b) {
  const len = Math.min(a.length, b.length);
  for (let k = 0; k < len; k += 1) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  return a.length - b.length;
}

/**
 * 单跳待置高引脚的全局分组裁决。
 * 参数：
 *   riseMask —— 待置高引脚位掩码（bitPos 约定同文件头部）；
 *   pinCount / weights / limit / maxRisePins。
 * 返回：
 *   { feasible:true, groups:[{mask,pinNos,pins,count,surge}], stages }
 *   或
 *   { feasible:false, reason:'overweight'|'ungroupable',
 *     overloadPins:[{pin,weight}], uncoveredPins:[{pin,weight}] }
 */
export function planRiseGroups(riseMask, pinCount, weights, limit, maxRisePins) {
  // 收集待置高引脚：{ bitPos, pinNo, weight }
  const pins = [];
  for (let bitPos = pinCount - 1; bitPos >= 0; bitPos -= 1) {
    if ((riseMask & (1 << bitPos)) !== 0) {
      const pinNo = pinCount - bitPos;
      pins.push({ bitPos, pinNo, weight: weights[pinNo - 1] });
    }
  }

  // 1) 单个引脚权重 > 限额：任何组（哪怕独占一组）都放不下
  const overloadPins = pins
    .filter((p) => p.weight > limit)
    .sort((a, b) => a.pinNo - b.pinNo)
    .map((p) => ({ pin: `P${p.pinNo}`, weight: p.weight }));
  if (overloadPins.length > 0) {
    return { feasible: false, reason: 'overweight', overloadPins, uncoveredPins: [], groups: [], stages: 0 };
  }

  if (pins.length === 0) {
    return { feasible: true, reason: null, overloadPins: [], uncoveredPins: [], groups: [], stages: 0 };
  }

  const k = pins.length;
  const full = riseMask;
  const totalWeight = pins.reduce((s, p) => s + p.weight, 0);

  // 快路径：全部待置高引脚本身就能在一个阶段内完成 —— 单组既是最少阶段数，
  // 也是唯一的一组划分，无需枚举子集。
  if (k <= maxRisePins && totalWeight <= limit) {
    const pinNos = pins.map((p) => p.pinNo).sort((a, b) => a - b);
    return {
      feasible: true,
      reason: null,
      overloadPins: [],
      uncoveredPins: [],
      groups: [{
        mask: full,
        pinNos,
        pins: pinNos.map((p) => `P${p}`),
        count: k,
        surge: totalWeight,
      }],
      stages: 1,
    };
  }

  const blocks = enumerateRiseBlocks(pins, limit, maxRisePins);

  // 2) 约束下无法成组：存在引脚不属于任何可行块。
  //    （当所有单引脚权重 ≤ 限额时单引脚块必可行，此项理论上不会触发，
  //     仍显式裁决以独立定位“无法分组”这一失败类别。）
  let coverUnion = 0;
  for (const b of blocks) coverUnion |= b.mask;
  if ((full & ~coverUnion) !== 0) {
    const uncoveredPins = pins
      .filter((p) => (coverUnion & (1 << p.bitPos)) === 0)
      .sort((a, b) => a.pinNo - b.pinNo)
      .map((p) => ({ pin: `P${p.pinNo}`, weight: p.weight }));
    return { feasible: false, reason: 'ungroupable', overloadPins: [], uncoveredPins, groups: [], stages: 0 };
  }

  /**
   * 最少组数下界（合法的 bin-packing lower bound）：
   *   max(ceil(引脚数/cap), limit>0 ? ceil(权重和/limit) : 0)
   * 用于在字典序回溯时提前排除“剩余引脚不可能在剩余组数内完成”的分支。
   */
  const lowerBound = (remMask) => {
    const cnt = popCount(remMask);
    let lb = Math.ceil(cnt / maxRisePins);
    if (limit > 0) {
      let wsum = 0;
      for (const p of pins) if ((remMask & (1 << p.bitPos)) !== 0) wsum += p.weight;
      lb = Math.max(lb, Math.ceil(wsum / limit));
    }
    return lb;
  };

  /**
   * 记忆化：findFirst(mask, g) = 用“恰好” g 个有序块覆盖 full\\mask 的
   * 字典序最小完整划分；不存在返回 null。块按 P 序列字典序依次尝试，
   * 因此首个成功组合即所有“恰好 g 组”划分中的字典序最优；
   * 全部可行块划分与全部阶段顺序都在比较范围内（无贪心截断）。
   */
  const memo = new Map();
  const findFirst = (mask, g) => {
    const remaining = full & ~mask;
    if (remaining === 0) return g === 0 ? [] : null;
    if (g === 0) return null;
    if (lowerBound(remaining) > g) return null; // 下界剪枝
    const key = mask + ':' + g;
    if (memo.has(key)) return memo.get(key);

    let answer = null;
    for (const b of blocks) {
      if ((b.mask & mask) !== 0) continue; // 块只能由未置高引脚组成
      if ((b.mask & remaining) !== b.mask) continue;
      const left = remaining & ~b.mask;
      if (left === 0) {
        if (g === 1) { answer = [b]; break; }
        continue; // 恰好 g 组：还有预算就不能在此用完
      }
      if (g < 2) continue;
      if (lowerBound(left) > g - 1) continue;
      const tail = findFirst(mask | b.mask, g - 1);
      if (tail !== null) {
        answer = [b].concat(tail);
        break;
      }
    }

    memo.set(key, answer);
    return answer;
  };

  // 3) 顶层：从最少组数下界起逐档裁决，首个成功档位即最少暂态方案
  let chosen = null;
  for (let g = lowerBound(full); g <= k; g += 1) {
    chosen = findFirst(0, g);
    if (chosen !== null) break;
  }

  if (chosen === null) {
    // 与第 2 步互补的防御性兜底（完整划分搜索失败）
    const uncoveredPins = pins
      .sort((a, b) => a.pinNo - b.pinNo)
      .map((p) => ({ pin: `P${p.pinNo}`, weight: p.weight }));
    return { feasible: false, reason: 'ungroupable', overloadPins: [], uncoveredPins, groups: [], stages: 0 };
  }

  const groups = chosen.map((b) => ({
    mask: b.mask,
    pinNos: b.pinNos.slice(),
    pins: b.pinNos.map((p) => `P${p}`),
    count: b.count,
    surge: b.surge,
  }));
  return { feasible: true, reason: null, overloadPins: [], uncoveredPins: [], groups, stages: groups.length };
}

/** 位掩码中引脚编号升序列表 */
function maskToPinNos(mask, pinCount) {
  const list = [];
  for (let bitPos = pinCount - 1; bitPos >= 0; bitPos -= 1) {
    if ((mask & (1 << bitPos)) !== 0) list.push(pinCount - bitPos);
  }
  return list;
}

/**
 * 缓变加载全局规划（按录入顺序，不做任何重排）。
 * 输入 model：{ pinCount, limit, weights, maxRisePins, vectors:[{id,bits}] }
 * 成功：
 *   { ok:true, feasible:true, order, jumps, returnJump, totalTransients,
 *     totalGroups, sampledCount, totalOrders, maxRisePins, limit }
 * 失败：
 *   { ok:true, feasible:false, order, jumps, failures, totalTransients,
 *     totalOrders, maxRisePins, limit }
 * 输入非法：{ ok:false, errors:[...] }
 */
export function solveRamping(model) {
  const errors = validateRamping(model);
  if (errors.length > 0) return { ok: false, errors };

  const { pinCount, weights, limit, maxRisePins } = model;
  const vectors = model.vectors;
  const n = vectors.length;
  const ids = vectors.map((v) => v.id);
  const masks = vectors.map((v) => maskFromBits(v.bits));
  const totalOrders = factorial(n);

  const order = ids.slice(); // 备案顺序 = 录入顺序
  const jumps = [];
  const failures = [];
  let totalTransients = 0;
  let totalGroups = 0;

  let prevMask = 0;
  for (let t = 0; t < n; t += 1) {
    const targetMask = masks[t];
    const fallMask = prevMask & ~targetMask;  // 先降：1→0
    const riseMask = ~prevMask & targetMask;  // 再升：0→1
    const settleMask = prevMask & targetMask; // 全部降位后、置高前的暂态

    const fallPinNos = maskToPinNos(fallMask, pinCount);
    const risePinNos = maskToPinNos(riseMask, pinCount);
    const risePins = risePinNos.map((p) => ({ pin: `P${p}`, weight: weights[p - 1] }));
    const plan = planRiseGroups(riseMask, pinCount, weights, limit, maxRisePins);

    if (!plan.feasible) {
      failures.push({
        vectorIndex: t,
        vectorId: ids[t],
        reason: plan.reason,
        overloadPins: plan.overloadPins,
        uncoveredPins: plan.uncoveredPins,
        prevBits: maskToBinary(prevMask, pinCount),
        targetBits: maskToBinary(targetMask, pinCount),
        risePins,
        fallPins: fallPinNos.map((p) => `P${p}`),
      });
      prevMask = targetMask; // 继续分析后续正式跳，尽量一次定位全部卡点
      continue;
    }

    const stages = [];

    // 暂态 1：统一降位（无降位则不产生暂态）
    if (fallMask !== 0) {
      stages.push({
        kind: 'fall',
        ordinal: stages.length + 1,
        mask: settleMask,
        bits: maskToBinary(settleMask, pinCount),
        pins: fallPinNos.map((p) => `P${p}`),
        count: fallPinNos.length,
        surge: 0,
      });
      totalTransients += 1;
    }

    // 暂态 2..：分组置高
    let stageMask = settleMask;
    for (const g of plan.groups) {
      stageMask |= g.mask;
      stages.push({
        kind: 'rise',
        ordinal: stages.length + 1,
        mask: stageMask,
        bits: maskToBinary(stageMask, pinCount),
        pins: g.pins,
        count: g.count,
        surge: g.surge,
      });
      totalTransients += 1;
      totalGroups += 1;
    }

    jumps.push({
      vectorIndex: t,
      vectorId: ids[t],
      prevMask,
      prevBits: maskToBinary(prevMask, pinCount),
      settleMask,
      settleBits: maskToBinary(settleMask, pinCount),
      targetMask,
      targetBits: maskToBinary(targetMask, pinCount),
      fallPins: fallPinNos.map((p) => `P${p}`),
      risePins,
      stages,
      groupCount: plan.groups.length,
      transientCount: stages.length,
      cumulativeTransients: totalTransients,
    });

    prevMask = targetMask;
  }

  // 收尾回零跳（正式采样点 = 全零）：仅一次降位暂态
  const lastMask = prevMask;
  const returnFallPins = maskToPinNos(lastMask, pinCount).map((p) => `P${p}`);
  if (lastMask !== 0) totalTransients += 1;
  const returnJump = {
    prevBits: maskToBinary(lastMask, pinCount),
    targetBits: maskToBinary(0, pinCount),
    fallPins: returnFallPins,
    stages: lastMask !== 0 ? [{
      kind: 'fall',
      ordinal: 1,
      mask: 0,
      bits: maskToBinary(0, pinCount),
      pins: returnFallPins,
      count: returnFallPins.length,
      surge: 0,
    }] : [],
    cumulativeTransients: totalTransients,
  };

  if (failures.length > 0) {
    return {
      ok: true,
      feasible: false,
      order,
      jumps,
      returnJump,
      failures,
      totalTransients,
      totalGroups,
      totalOrders,
      maxRisePins,
      limit,
    };
  }

  return {
    ok: true,
    feasible: true,
    order,
    jumps,
    returnJump,
    totalTransients,
    totalGroups,
    sampledCount: n,
    totalOrders,
    maxRisePins,
    limit,
  };
}
