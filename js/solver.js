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
/** 缓变加载：每个切换阶段最多同时置高的引脚数上限（取值 1..MAX_PINS） */
export const MAX_GROUP_PINS = MAX_PINS;

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
 * model = { pinCount, limit, weights:[...], vectors:[{id, bits}], maxGroupPins? }
 * maxGroupPins 缺省时缓变加载关闭（仅做既有闭环裁决）。
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

  if (model.maxGroupPins !== undefined && model.maxGroupPins !== null) {
    if (!isInt(model.maxGroupPins) || model.maxGroupPins < 1 || model.maxGroupPins > MAX_GROUP_PINS) {
      errors.push({
        scope: 'maxGroupPins',
        message: `缓变加载每阶段置高引脚数上限必须是 1–${MAX_GROUP_PINS} 之间的整数（当前：${String(model.maxGroupPins)}）`,
      });
    }
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
 *   MAXP 3               # 可选；启用缓变加载：每个切换阶段最多同时置高 3 个引脚（1..PINS）
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
  let maxGroupPins = null;
  let pinsLine = null;
  let limitLine = null;
  let weightsLine = null;
  let maxpLine = null;
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

    if (keyword === 'MAXP') {
      if (maxGroupPins !== null) {
        errors.push({ line: lineNo, message: 'MAXP 重复定义' });
        return;
      }
      if (parts.length !== 2 || !INTEGER_RE.test(parts[1])) {
        errors.push({ line: lineNo, message: 'MAXP 语法应为：MAXP <1–20 的整数>（缓变加载每阶段置高引脚数上限）' });
        return;
      }
      maxpLine = lineNo;
      maxGroupPins = Number.parseInt(parts[1], 10);
      if (maxGroupPins < 1 || maxGroupPins > MAX_GROUP_PINS) {
        errors.push({ line: lineNo, message: `MAXP 必须在 1–${MAX_GROUP_PINS} 之间（当前：${maxGroupPins}）` });
      }
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

  const model = { pinCount, limit, maxGroupPins, weights: weights || [], vectors };

  // 语义校验（位数/数量/取值/重复编号/掩码长度），把定位映射到源行号
  if (errors.length === 0) {
    validateModel(model).forEach((err) => {
      let line = null;
      if (err.scope === 'pins') line = pinsLine;
      else if (err.scope === 'limit') line = limitLine;
      else if (err.scope === 'weights' || err.scope === 'weight') line = weightsLine;
      else if (err.scope === 'maxGroupPins') line = maxpLine;
      else if ((err.scope === 'vector' || err.scope === 'vectors') && err.index != null) {
        line = vectorLines[err.index];
      }
      errors.push({ line, message: err.message });
    });
  }

  return { model, errors };
}

/** 导出文本（与 parseImport 互逆；仅在启用缓变加载时写出 MAXP） */
export function exportModel(model) {
  const lines = [];
  lines.push(`PINS ${model.pinCount}`);
  lines.push(`LIMIT ${model.limit}`);
  if (isInt(model.maxGroupPins)) lines.push(`MAXP ${model.maxGroupPins}`);
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

// ===========================================================================
// 缓变加载（soft-start）：在“当前录入顺序”的正式向量序列上规划切换暂态
// ===========================================================================
//
// 量产设备有时必须遵循已备案（即工程师录入）的向量编号顺序，不能由闭环裁决
// 重排。缓变加载在既有录入/导入模型旁启用，与既有闭环裁决（solveModel）互不
// 影响：正式向量严格按“当前录入顺序”执行，每个正式向量仍在其原掩码处采样。
//
// 每次正式跳转 prevMask -> nextMask 前可插入仅用于切换的暂态：
//   1) 先一次性完成全部降位（1→0，降位不计浪涌）；
//   2) 再把待置高引脚 R（本跳 0→1 的引脚）分入若干“有序阶段”依次置高。
// 每个阶段（一组）必须同时满足：
//   - 组内引脚权重之和 ≤ 既有浪涌限额 limit；
//   - 组内引脚数 ≤ maxGroupPins（新上限，1..MAX_GROUP_PINS）。
//
// 裁决规则（对每个正式跳转都做完整比较，不用逐引脚试探或贪心装箱）：
//   1) 插入暂态总数最少。一跳经若干切换阶段抵达正式掩码（采样点），“插入的
//      仅切换暂态数 = 切换阶段数 - 1”（降位 0/1 个 + 置高 k 个，最后一个阶段
//      抵达采样点本身不计入）；降位贡献对分组方案是常数，故等价于置高分组数
//      k 最少；
//   2) 并列时按“各阶段置高引脚的 P 序列”（阶段先后 × 组内 P 升序）字典序最小。
// 各跳的可行分组只依赖本跳的待置高引脚集合，彼此独立；全链路暂态总数为各跳
// 之和，因此逐跳取“完整比较后的最优”即全链路最优（同数并列时第一段差异由最
// 先发生的正式跳转决定，逐跳取字典序最小恰好拼成全链路字典序最小）。

/** 引脚编号列表（P 编号升序）对应的位掩码（与向量掩码同一坐标系） */
function pinListToMask(pins, pinCount) {
  let m = 0;
  for (const p of pins) m |= 1 << (pinCount - p);
  return m;
}

/** 两个升序引脚列表的字典序比较（测试暴力对拍使用：a<b 返回负数） */
export function comparePinLists(a, b) {
  const len = Math.min(a.length, b.length);
  for (let k = 0; k < len; k += 1) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  return a.length - b.length;
}

/**
 * 按 P 序列字典序惰性枚举 pins（升序）的全部可行非空分组，访问顺序即字典序：
 *   [p0] < [p0,p1] < ... < [p0,p1,...] < [p0,p2] < ... < [p1] < ...
 * 权重非负 => 延长分组只会增大权重和与引脚数，超限/超员的前缀不再扩展（这是
 * 可行性裁剪，不替裁决做任何“选哪组”的贪心决定）。
 * visit(picked, nextStartIdx) 返回 false 可提前停止。
 */
function enumerateFeasibleGroupsLex(pins, weights, limit, cap, visit) {
  const picked = [];
  const gen = (start, sum, size) => {
    for (let i = start; i < pins.length; i += 1) {
      const pin = pins[i];
      const w = weights[pin - 1];
      if (size + 1 > cap || sum + w > limit) continue; // 后面可能有更轻的引脚，继续
      picked.push(pin);
      if (visit(picked, i + 1) === false) return false;
      if (gen(i + 1, sum + w, size + 1) === false) return false;
      picked.pop();
    }
    return true;
  };
  gen(0, 0, 0);
}

/**
 * 穷举一个跳变的全部“有序分组方案”（有序集划分），仅用于小规模暴力对拍/测试。
 * 正式裁决走 bestGrouping 的迭代加深搜索（本函数在 m=20 时会呈组合爆炸）。
 * 返回 [{ groups:Number[][], total:Number }]，未排序。
 */
export function enumerateOrderedGroupings(pins, weights, limit, cap) {
  if (pins.length === 0) return [{ groups: [], total: 0 }];
  const feasibleMasks = [];
  const full = (1 << pins.length) - 1;
  for (let bits = 1; bits <= full; bits += 1) {
    if (popCount(bits) > cap) continue;
    let sum = 0;
    for (let k = 0; k < pins.length; k += 1) {
      if ((bits & (1 << k)) !== 0) sum += weights[pins[k] - 1];
    }
    if (sum <= limit) feasibleMasks.push(bits);
  }
  const out = [];
  const chosen = [];
  const recurse = (used) => {
    if (used === full) {
      out.push({
        groups: chosen.map((gm) => {
          const g = [];
          for (let k = 0; k < pins.length; k += 1) {
            if ((gm & (1 << k)) !== 0) g.push(pins[k]);
          }
          return g;
        }),
        total: chosen.length,
      });
      return;
    }
    for (const gm of feasibleMasks) {
      if ((gm & used) !== 0) continue; // 组互斥；阶段顺序由选择次序区分，完整枚举
      chosen.push(gm);
      recurse(used | gm);
      chosen.pop();
    }
  };
  recurse(0);
  return out;
}

/**
 * 对一个正式跳转的待置高引脚做完整裁决：
 * 迭代加深 DFS —— 从组数下界开始逐层加深，每层遍历该深度下的全部有序分组；
 * 第一个成功的方案就是“组数最少且 P 序列字典序最小”者。
 * 不做逐引脚/贪心装箱：同一深度下所有互斥分组及其阶段顺序都会被比较，
 * 必要的裁剪只有不可行下界（引脚数、权重和）与失败状态记忆。
 *
 * 返回 { feasible, groups, totalTransients, feasibleGroups, lowerBound, triedK }
 * 不可行返回 { feasible:false, reason }。
 */
export function bestGrouping(risePins, weights, limit, cap) {
  if (risePins.length === 0) {
    return { feasible: true, groups: [], totalTransients: 0, feasibleGroups: 0, lowerBound: 0, triedK: [0] };
  }

  // 单引脚权重大于限额：任何阶段都无法置高（降位不产生浪涌，无可绕行暂态）
  const overweight = risePins.filter((p) => weights[p - 1] > limit);
  if (overweight.length > 0) {
    return {
      feasible: false,
      reason: 'overweight',
      overweightPins: overweight,
    };
  }

  const totalSum = risePins.reduce((s, p) => s + weights[p - 1], 0);
  // 可容许下界（只可能低估、不会高估所需组数，故用于剪枝绝不误杀可行解）：
  //   引脚数下界 ceil(m/cap)；权重和下界 ceil(sum/limit)；
  //   装箱下界：权重 > limit/2 的“重引脚”两两不能同组，各占一组，其余轻引脚
  //   先填充这些组的剩余额度，填不下再按 limit 追加组数（此处忽略引脚数上限，
  //   只会让下界更松，仍然安全）。
  const lowerBound = groupLowerBound(risePins, weights, limit, cap);

  // 根层可行组计数（完整枚举一遍所有可行非空组，供汇报“完整比较”规模）
  let feasibleGroups = 0;
  enumerateFeasibleGroupsLex(risePins, weights, limit, cap, () => {
    feasibleGroups += 1;
  });

  const path = [];
  const triedK = [];
  // 失败记忆：键 = 残集位掩码 × 剩余组数。同一 (残集, 剩余组数) 子问题的
  // 可行性是确定的，且与迭代加深的层级、到达路径无关，故跨层级持久保留；
  // 记忆只做剪枝，不影响“字典序首个成功即最优”的完备性。
  const failed = new Set();

  // rem 为“尚未置高”的引脚编号升序列表
  const dfs = (rem, groupsLeft) => {
    if (rem.length === 0) return groupsLeft === 0;
    if (groupsLeft === 0) return false;
    // 可容许下界：残集所需组数下界超过剩余组数则必无解
    if (groupLowerBound(rem, weights, limit, cap) > groupsLeft) return false;

    let solution = false;
    enumerateFeasibleGroupsLex(rem, weights, limit, cap, (group) => {
      if (solution) return false;
      const rest = rem.filter((p) => !group.includes(p));
      const restKey = rest.length === 0 ? 0 : pinListToMask(rest, weights.length);
      const memoKey = restKey * 32 + (groupsLeft - 1); // 残集 × 剩余组数
      if (failed.has(memoKey)) return true; // 该子问题已被证明无解
      path.push(group.slice());
      if (dfs(rest, groupsLeft - 1)) {
        solution = true;
        return false; // 停止枚举：字典序首个成功即全局最优
      }
      path.pop();
      failed.add(memoKey);
      return true;
    });
    return solution;
  };

  // 单引脚组恒可行（w ≤ limit 且 cap ≥ 1），故 k = risePins.length 必然成功；
  // 仍保留失败出口以覆盖任何意料之外的约束组合。
  for (let k = lowerBound; k <= risePins.length; k += 1) {
    triedK.push(k);
    path.length = 0;
    if (dfs(risePins.slice(), k)) {
      return {
        feasible: true,
        groups: path.map((g) => g.slice()),
        totalTransients: k,
        feasibleGroups,
        lowerBound,
        triedK,
      };
    }
  }

  return {
    feasible: false,
    reason: 'ungroupable',
    feasibleGroups,
    lowerBound,
    triedK,
  };
}

/**
 * 分组所需组数的可容许下界（admissible，绝不高估）：
 *   max(ceil(引脚数/cap), 权重和/limit 装箱下界)。
 * 装箱下界：重引脚（w > limit/2）两两不能同组，各占一组；轻引脚先占用这些组
 * 的残余额度，仍装不下的部分按每组至多 limit 权重追加组数。
 */
function groupLowerBound(pins, weights, limit, cap) {
  const byCount = Math.ceil(pins.length / cap);
  let heavy = 0;
  let sumHeavy = 0;
  let sumLight = 0;
  for (const p of pins) {
    const w = weights[p - 1];
    if (limit > 0 && w * 2 > limit) { heavy += 1; sumHeavy += w; }
    else sumLight += w;
  }
  const spareInHeavy = Math.max(0, heavy * limit - sumHeavy);
  const extra = limit > 0
    ? Math.ceil(Math.max(0, sumLight - spareInHeavy) / limit)
    : 0;
  return Math.max(byCount, heavy + extra);
}

/**
 * 规划单个正式跳转（prevMask -> nextMask）的全部切换暂态。
 * 返回：
 *   可行 { feasible:true, prevMask, nextMask, fallPins, risePins, best, stages }
 *   不可行 { feasible:false, reason:{code,message,pins?}, fallPins, risePins }
 */
export function planHopTransients(prevMask, nextMask, pinCount, weights, limit, maxGroupPins) {
  const fallPins = [];
  const risePins = [];
  for (let p = 1; p <= pinCount; p += 1) {
    const bit = 1 << (pinCount - p);
    const was1 = (prevMask & bit) !== 0;
    const now1 = (nextMask & bit) !== 0;
    if (was1 && !now1) fallPins.push(p);
    else if (!was1 && now1) risePins.push(p);
  }

  if (risePins.some((p) => weights[p - 1] > limit)) {
    const bad = risePins.filter((p) => weights[p - 1] > limit);
    return {
      feasible: false,
      prevMask,
      nextMask,
      fallPins,
      risePins,
      reason: {
        code: 'overweight',
        pins: bad,
        message: `引脚 ${bad.map((p) => `P${p}（权重=${weights[p - 1]}）`).join('、')
        } 自身权重已大于浪涌限额 ${limit}，任何切换阶段将其置高都会超限`,
      },
    };
  }

  const result = bestGrouping(risePins, weights, limit, maxGroupPins);
  if (!result.feasible) {
    return {
      feasible: false,
      prevMask,
      nextMask,
      fallPins,
      risePins,
      reason: {
        code: 'ungroupable',
        message: `待置高引脚 ${risePins.map((p) => `P${p}（权重=${weights[p - 1]}）`).join('、')
        } 无法在“每组权重和 ≤ ${limit} 且每组引脚数 ≤ ${maxGroupPins}”下完成完整分组`,
      },
    };
  }

  // 先降位：一次性完成所有 1→0
  const afterFallMask = prevMask & nextMask;
  const stages = [];
  if (fallPins.length > 0) {
    stages.push({
      kind: 'fall',
      name: '降位暂态',
      pins: fallPins.map((p) => ({ pin: `P${p}`, weight: weights[p - 1] })),
      maskBefore: prevMask,
      maskAfter: afterFallMask,
      surge: 0,
      sample: false,
    });
  }
  // 再分组置高
  result.groups.forEach((group, gi) => {
    const before = afterFallMask
      | pinListToMask(result.groups.slice(0, gi).reduce((a, g) => a.concat(g), []), pinCount);
    const after = afterFallMask
      | pinListToMask(result.groups.slice(0, gi + 1).reduce((a, g) => a.concat(g), []), pinCount);
    stages.push({
      kind: 'rise',
      name: `置高暂态 ${gi + 1}/${result.groups.length}`,
      pins: group.map((p) => ({ pin: `P${p}`, weight: weights[p - 1] })),
      maskBefore: before,
      maskAfter: after,
      surge: group.reduce((s, p) => s + weights[p - 1], 0),
      sample: false,
    });
  });
  // 采样点：正式向量在原掩码处采样（暂态序列结束后的稳定态）
  stages.push({
    kind: 'sample',
    name: '正式采样',
    pins: [],
    maskBefore: nextMask,
    maskAfter: nextMask,
    surge: 0,
    sample: true,
  });

  // 切换阶段数 = 降位阶段（0/1）+ 置高阶段数 k。最后一个切换阶段抵达正式掩码
  // （即采样点）本身，故“插入”的仅切换暂态数 = 切换阶段数 - 1：
  //   无降位且一组直达 -> 0；无降位分 k 组 -> k-1；有降位再分 k 组 -> k；
  //   纯降位（无置高）-> 0。降位贡献对分组方案是常数，最小化插入暂态等价于
  //   最小化置高分组数 k（bestGrouping 已做完整裁决）。
  const fallStages = fallPins.length > 0 ? 1 : 0;
  const riseStages = result.groups.length;
  const switchingStages = fallStages + riseStages;
  const insertedTransients = Math.max(0, switchingStages - 1);

  return {
    feasible: true,
    prevMask,
    nextMask,
    fallPins,
    risePins,
    best: { groups: result.groups, totalTransients: result.totalTransients },
    feasibleGroups: result.feasibleGroups,
    lowerBound: result.lowerBound,
    triedK: result.triedK,
    switchingStages,
    insertedTransients,
    stages,
  };
}

/**
 * 缓变加载全局规划：严格按当前录入顺序，从全零出发、逐正式向量在原掩码采样、
 * 最终回零；每个正式跳转前插入经完整比较的切换暂态。
 *
 * 成功返回：
 *   { ok:true, mode:'soft-start', feasible:true, sequence:[id...],
 *     totalTransients, transitions:[{ hop, kind, vectorId, prevBits, nextBits,
 *       fallPins, risePins, transientCount, cumulativeTransients, stages,
 *       feasibleGroups }], returnHop:{...} }
 * 存在无法分组的正式跳转：
 *   { ok:true, mode:'soft-start', feasible:false, sequence, infeasible:[...] }
 * 输入非法：{ ok:false, errors }
 */
export function solveSoftStart(model) {
  const errors = validateModel(model);
  if (errors.length > 0) return { ok: false, errors };
  if (!isInt(model.maxGroupPins) || model.maxGroupPins < 1 || model.maxGroupPins > MAX_GROUP_PINS) {
    return {
      ok: false,
      errors: [{
        scope: 'maxGroupPins',
        message: `启用缓变加载时必须填写 1–${MAX_GROUP_PINS} 之间的每阶段置高引脚数上限`,
      }],
    };
  }

  const { pinCount, weights, limit, maxGroupPins } = model;
  const vectors = model.vectors;
  const n = vectors.length;
  const ids = vectors.map((v) => v.id);
  const masks = vectors.map((v) => maskFromBits(v.bits));

  const buildTransition = (hop, kind, vectorId, prevMask, nextMask) => {
    const plan = planHopTransients(prevMask, nextMask, pinCount, weights, limit, maxGroupPins);
    return { hop, kind, vectorId, ...plan };
  };

  // 正式跳转：全零 -> V(录入顺序[0]) -> ... -> V(录入顺序[n-1])，最后回零
  const hops = [];
  for (let h = 0; h < n; h += 1) {
    const prevMask = h === 0 ? 0 : masks[h - 1];
    hops.push(buildTransition(h + 1, 'vector', ids[h], prevMask, masks[h]));
  }
  hops.push(buildTransition(n + 1, 'return', null, masks[n - 1], 0));

  const infeasible = hops
    .filter((p) => !p.feasible)
    .map((p) => ({
      hop: p.hop,
      kind: p.kind,
      vectorId: p.vectorId,
      reason: p.reason,
      fallPins: p.fallPins,
      risePins: p.risePins,
    }));
  if (infeasible.length > 0) {
    return {
      ok: true,
      mode: 'soft-start',
      feasible: false,
      sequence: ids,
      maxGroupPins,
      infeasible,
    };
  }

  let cumulativeTransients = 0;
  const decorate = (p) => ({
    hop: p.hop,
    kind: p.kind,
    vectorId: p.vectorId,
    prevMask: p.prevMask,
    nextMask: p.nextMask,
    prevBits: maskToBinary(p.prevMask, pinCount),
    nextBits: maskToBinary(p.nextMask, pinCount),
    sampleBits: maskToBinary(p.nextMask, pinCount),
    fallPins: p.fallPins.map((q) => ({ pin: `P${q}`, weight: weights[q - 1] })),
    risePins: p.risePins.map((q) => ({ pin: `P${q}`, weight: weights[q - 1] })),
    feasibleGroups: p.feasibleGroups,
    riseGroupCount: p.best.totalTransients, // 置高分组数 k（裁决对象）
    switchingStages: p.switchingStages,
    insertedTransients: p.insertedTransients, // 本跳插入的仅切换暂态数
    stages: p.stages.map((s) => ({
      ...s,
      bitsBefore: maskToBinary(s.maskBefore, pinCount),
      bitsAfter: maskToBinary(s.maskAfter, pinCount),
    })),
  });

  const transitions = hops.slice(0, n).map((p) => {
    cumulativeTransients += p.insertedTransients;
    return { ...decorate(p), cumulativeTransients };
  });
  const returnHop = decorate(hops[n]); // 回零跳：只有降位，无置高暂态

  return {
    ok: true,
    mode: 'soft-start',
    feasible: true,
    sequence: ids,
    maxGroupPins,
    totalTransients: cumulativeTransients,
    transitions,
    returnHop,
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
