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
  let pinsLine = null;
  let limitLine = null;
  let weightsLine = null;
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

  const model = { pinCount, limit, weights: weights || [], vectors };

  // 语义校验（位数/数量/取值/重复编号/掩码长度），把定位映射到源行号
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

  return { model, errors };
}

/** 导出文本（与 parseImport 互逆） */
export function exportModel(model) {
  const lines = [];
  lines.push(`PINS ${model.pinCount}`);
  lines.push(`LIMIT ${model.limit}`);
  lines.push(`W ${model.weights.join(' ')}`);
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
