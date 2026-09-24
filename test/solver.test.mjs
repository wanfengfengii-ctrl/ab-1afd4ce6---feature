/**
 * solver.test.mjs —— 核心逻辑测试。
 * 关键：用一份完全独立的全排列暴力枚举（n!）对拍子集 DP 的
 *   - 可行性 / 可行顺序数
 *   - 最小全程翻转位数
 *   - 字典序最小的编号序列
 * 随机用例覆盖多种限额（含无解），确保“全局裁决”不被贪心替代。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveModel,
  validateModel,
  parseImport,
  exportModel,
  maskFromBits,
  maskToBinary,
  hopSurge,
  hopFlips,
  risingPinList,
  popCount,
  MIN_PINS,
} from '../js/solver.js';

// ---------- 独立暴力实现（与 solver 内部代码不共享任何函数） ----------

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((v, i) => {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    permutations(rest).forEach((p) => out.push([v].concat(p)));
  });
  return out;
}

function bruteForce(model) {
  const n = model.vectors.length;
  const ids = model.vectors.map((v) => v.id);
  const masks = model.vectors.map((v) => maskFromBits(v.bits));
  const { pinCount, weights, limit } = model;

  const surgeOf = (a, b) => {
    let s = 0;
    for (let p = 0; p < pinCount; p += 1) {
      const bit = 1 << (pinCount - 1 - p);
      const was1 = (a & bit) !== 0;
      const now1 = (b & bit) !== 0;
      if (now1 && !was1) s += weights[p];
    }
    return s;
  };

  let feasibleOrders = 0n;
  let best = null; // { flips, seq:[ids] }

  permutations([...Array(n).keys()]).forEach((perm) => {
    let prev = 0;
    let flips = 0;
    let feasible = true;
    perm.forEach((idx) => {
      if (surgeOf(prev, masks[idx]) > limit) feasible = false;
      flips += popCount(prev ^ masks[idx]);
      prev = masks[idx];
    });
    flips += popCount(prev); // 闭合回全零态
    // 闭合跳 0->1 集合为空，浪涌恒为 0；限额非负时必然满足
    if (surgeOf(prev, 0) > limit) feasible = false;
    if (!feasible) return;
    feasibleOrders += 1n;
    const seq = perm.map((i) => ids[i]);
    if (best === null || flips < best.flips
      || (flips === best.flips && lexLess(seq, best.seq))) {
      best = { flips, seq };
    }
  });

  return { feasibleOrders, best };
}

function lexLess(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

// ---------- 构造工具 ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function randomModel(seed, n) {
  const r = rng(seed);
  const pinCount = MIN_PINS;
  const weights = Array.from({ length: pinCount }, () => Math.floor(r() * 4)); // 0..3
  const vectors = [];
  const usedMasks = new Set();
  for (let i = 0; i < n; i += 1) {
    let bits;
    do {
      bits = Array.from({ length: pinCount }, () => (r() < 0.4 ? '1' : '0')).join('');
    } while (usedMasks.has(bits));
    usedMasks.add(bits);
    vectors.push({ id: `V${i + 1}`, bits });
  }
  const limit = Math.floor(r() * 7); // 0..6，常会造成无解或紧约束
  return { pinCount, limit, weights, vectors };
}

// ---------- 对拍 ----------

test('随机对拍：DP 与 n! 暴力枚举在可行性、可行数、最优翻转与字典序上完全一致', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const n = 4 + (seed % 5); // 4..8
    const model = randomModel(seed * 7919 + 13, n);
    const got = solveModel(model);
    assert.equal(got.ok, true, `seed=${seed} 不应报输入错误`);
    const want = bruteForce(model);

    if (want.best === null) {
      assert.equal(got.feasible, false, `seed=${seed} 暴力判无解，DP 不应给出解`);
      assert.equal(got.feasibleOrders, 0n);
    } else {
      assert.equal(got.feasible, true, `seed=${seed} 暴力判有解，DP 不应判无解`);
      assert.equal(got.feasibleOrders, want.feasibleOrders,
        `seed=${seed} 可行顺序数不符`);
      assert.equal(got.totalFlips, want.best.flips,
        `seed=${seed} 最小翻转位数不符`);
      assert.deepEqual(got.sequence, want.best.seq,
        `seed=${seed} 字典序裁决不符`);
      assert.equal(got.totalOrders, (() => {
        let f = 1n; for (let i = 2; i <= n; i += 1) f *= BigInt(i); return f;
      })());
      // 逐步明细自洽：起于全零、每向量一次、终于全零
      assert.equal(got.steps.length, n + 1);
      assert.equal(got.steps[0].prevBits, '0'.repeat(MIN_PINS));
      assert.equal(got.steps[n].nextBits, '0'.repeat(MIN_PINS));
      const seen = new Set(got.steps.slice(0, n).map((s) => s.vectorId));
      assert.equal(seen.size, n);
      got.steps.forEach((s) => {
        assert.equal(s.cumulative >= s.flips, true);
        assert.ok(s.surge <= model.limit, `seed=${seed} 明细出现越限浪涌`);
      });
      assert.equal(got.steps[n].cumulative, got.totalFlips);
    }
  }
});

test('n=12 上限规模可完整裁决（4.9 万状态级 DP）', () => {
  const r = rng(42);
  const pinCount = 20;
  const weights = Array.from({ length: 20 }, () => 1);
  const vectors = Array.from({ length: 12 }, (_, i) => ({
    id: `V${i + 1}`,
    bits: Array.from({ length: 20 }, () => (r() < 0.3 ? '1' : '0')).join(''),
  }));
  const model = { pinCount, limit: 20, weights, vectors };
  const t0 = Date.now();
  const got = solveModel(model);
  assert.equal(got.ok, true);
  assert.equal(got.totalOrders, 479001600n); // 12!
  assert.ok(Date.now() - t0 < 5000, '12 向量求解应在数秒内完成');
  if (got.feasible) {
    assert.equal(got.steps.length, 13);
    assert.ok(got.totalFlips >= 0);
  }
});

test('字典序并列裁决：全部掩码相同时按编号码点序，且 “10” 排在 “2” 之前', () => {
  const bits = '00000001';
  const model = {
    pinCount: 8,
    limit: 1,
    weights: [1, 1, 1, 1, 1, 1, 1, 1],
    vectors: ['3', '1', '10', '2'].map((id) => ({ id, bits })),
  };
  const got = solveModel(model);
  assert.equal(got.feasible, true);
  assert.deepEqual(got.sequence, ['1', '10', '2', '3']);
  // 4! 条顺序全部可行
  assert.equal(got.feasibleOrders, 24n);
});

test('浪涌只计 0→1：已为高的引脚重复保持不重复计费，1→0 不计浪涌', () => {
  // 权重 [5,1,...]；首跳到 10000000 浪涌 5；再跳 10000001 只新增 P8（w=1）
  const model = {
    pinCount: 8,
    limit: 5,
    weights: [5, 1, 1, 1, 1, 1, 1, 1],
    vectors: [
      { id: 'A', bits: '10000000' },
      { id: 'B', bits: '10000001' },
      { id: 'C', bits: '01000000' },
      { id: 'D', bits: '00100000' },
    ],
  };
  const got = solveModel(model);
  assert.equal(got.feasible, true);
  // 手工核对 A->B 浪涌
  assert.equal(hopSurge(maskFromBits('10000000'), maskFromBits('10000001'), 8, model.weights), 1);
  assert.equal(hopSurge(maskFromBits('10000001'), maskFromBits('10000000'), 8, model.weights), 0);
  assert.deepEqual(risingPinList(maskFromBits('10000000'), maskFromBits('10000001'), 8), [8]);
  // 翻转位对称：A->B 与 B->A 都是 1 位
  assert.equal(hopFlips(maskFromBits('10000000'), maskFromBits('10000001')), 1);
});

test('全局裁决纠贪案例：存在逐跳贪心走错而全局最优不同的用例', () => {
  // 由 scripts 搜索固化：该用例下“最近邻贪心首跳选择”不在全局最优序列首位
  const model = GREEDY_TRAP;
  const got = solveModel(model);
  assert.equal(got.feasible, true);
  const want = bruteForce(model);
  assert.equal(got.totalFlips, want.best.flips);
  assert.deepEqual(got.sequence, want.best.seq);

  // 模拟从全零态出发的最近邻贪心（浪涌可行前提下取翻转最少、并列小编号）
  const masks = model.vectors.map((v) => maskFromBits(v.bits));
  const remaining = new Set(masks.keys());
  let prev = 0;
  const greedySeq = [];
  while (remaining.size > 0) {
    let pick = null;
    for (const j of remaining) {
      const surge = hopSurge(prev, masks[j], model.pinCount, model.weights);
      if (surge > model.limit) continue;
      const d = popCount(prev ^ masks[j]);
      if (pick === null || d < pick.d || (d === pick.d && model.vectors[j].id < model.vectors[pick.j].id)) {
        pick = { j, d };
      }
    }
    if (pick === null) break; // 贪心走进死路
    greedySeq.push(model.vectors[pick.j].id);
    prev = masks[pick.j];
    remaining.delete(pick.j);
  }
  assert.notDeepEqual(greedySeq, got.sequence,
    '固化用例应当能区分贪心与全局最优；若失败说明用例已失效');
});

test('无解时给出诊断且 feasibleOrders 为 0', () => {
  // 限额 0：任何首跳含 1 的向量都超限
  const model = {
    pinCount: 8,
    limit: 0,
    weights: [1, 1, 1, 1, 1, 1, 1, 1],
    vectors: [
      { id: 'V1', bits: '10000000' },
      { id: 'V2', bits: '01000000' },
      { id: 'V3', bits: '00100000' },
      { id: 'V4', bits: '00010000' },
    ],
  };
  const got = solveModel(model);
  assert.equal(got.ok, true);
  assert.equal(got.feasible, false);
  assert.equal(got.feasibleOrders, 0n);
  assert.deepEqual(got.diagnosis.blockedStartIds.sort(), ['V1', 'V2', 'V3', 'V4']);
  assert.ok(got.diagnosis.deadEndIds.length === 4);
});

// ---------- 输入校验与定位 ----------

const validBase = () => ({
  pinCount: 8,
  limit: 5,
  weights: [1, 1, 1, 1, 1, 1, 1, 1],
  vectors: [
    { id: 'V1', bits: '10000000' },
    { id: 'V2', bits: '01000000' },
    { id: 'V3', bits: '00100000' },
    { id: 'V4', bits: '00010000' },
  ],
});

test('输入校验：向量数量越界、位数越界、重复编号、权重非法、掩码长度错误均被定位', () => {
  let m = validBase();
  m.vectors = m.vectors.slice(0, 3);
  assert.ok(validateModel(m).some((e) => e.scope === 'vectors'));

  m = validBase();
  m.vectors = Array.from({ length: 13 }, (_, i) => ({
    id: `V${i + 1}`, bits: '00000000',
  })); // 13 个 > 12
  assert.ok(validateModel(m).some((e) => /向量数量/.test(e.message)));

  m = validBase();
  m.pinCount = 7;
  assert.ok(validateModel(m).some((e) => e.scope === 'pins'));
  m.pinCount = 21;
  assert.ok(validateModel(m).some((e) => e.scope === 'pins'));

  m = validBase();
  m.vectors[2].id = 'V1';
  const dup = validateModel(m);
  assert.ok(dup.some((e) => e.scope === 'vector' && e.index === 2 && /重复/.test(e.message)));

  m = validBase();
  m.weights[3] = -2;
  const w = validateModel(m);
  assert.ok(w.some((e) => e.scope === 'weight' && e.index === 3));

  m = validBase();
  m.weights = [1, 2, 3];
  assert.ok(validateModel(m).some((e) => e.scope === 'weights'));

  m = validBase();
  m.limit = -1;
  assert.ok(validateModel(m).some((e) => e.scope === 'limit'));

  m = validBase();
  m.vectors[0].bits = '1000000'; // 7 位
  const b = validateModel(m);
  assert.ok(b.some((e) => e.scope === 'vector' && e.index === 0));

  m = validBase();
  m.vectors[1].bits = '02000000'; // 含非法字符
  assert.ok(validateModel(m).some((e) => e.index === 1));
});

test('掩码转换与位序：左起 P1 对应最高位', () => {
  assert.equal(maskToBinary(maskFromBits('10000000'), 8), '10000000');
  assert.equal(popCount(maskFromBits('10101000')), 3);
  assert.deepEqual(
    risingPinList(maskFromBits('10100000'), maskFromBits('10110001'), 8),
    [4, 8],
  );
});

test('导入解析：成功、往返一致、错误行号定位', () => {
  const text = exportModel(validBase());
  const { model, errors } = parseImport(text);
  assert.equal(errors.length, 0);
  assert.equal(model.pinCount, 8);
  assert.equal(model.limit, 5);
  assert.deepEqual(model.weights, [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(model.vectors[0], { id: 'V1', bits: '10000000' });
  assert.equal(exportModel(model), text);

  const bad = [
    'PINS 8',
    'LIMIT 5',
    'W 1 1 1 1 1 1 1 1',
    'V1 10000000',
    'V2 01000000',
    'V1 00100000', // 第 6 行：重复编号
    'V4 00001',    // 第 7 行：位数不对
  ].join('\n');
  const res = parseImport(bad);
  assert.ok(res.errors.some((e) => e.line === 6 && /重复/.test(e.message)));
  assert.ok(res.errors.some((e) => e.line === 7 && /8 位/.test(e.message)));

  const bad2 = 'PINS 9\nLIMIT 5\nV1 10000000\nV2 01000000\nV3 00100000\nV4 00010000\n';
  const res2 = parseImport(bad2);
  assert.ok(res2.errors.some((e) => /缺少权重行/.test(e.message)));

  const bad3 = 'PINS 25\nLIMIT -1\nW 1\nBOGUS LINE\n';
  const res3 = parseImport(bad3);
  assert.ok(res3.errors.some((e) => e.line === 1 && /PINS/.test(e.message)));
  assert.ok(res3.errors.some((e) => e.line === 2));
  assert.ok(res3.errors.some((e) => e.line === 4));
});

test('导入支持 WEIGHTS 别名、注释与任意空白', () => {
  const text = `
# 注释行
PINS  8
LIMIT\t5
WEIGHTS 2 2 2 2 2 2 2 2
V1   10000000
V2 01000000
V3 00100000
V4 00010000
`;
  const { errors } = parseImport(text);
  assert.deepEqual(errors, []);
});

// ---------- 反贪心固化用例（由对拍搜索得到，见 scripts/find-greedy-trap.mjs） ----------
const GREEDY_TRAP = {
  // 由 scripts/find-greedy-trap.mjs 搜索（seed=8）：
  // 最近邻贪心首跳选翻转更少的 V4 并一路走到 V4→V3→V2→V1，
  // 但全局裁决的最小翻转顺序是 V1→V2→V3→V4。
  pinCount: 8,
  limit: 6,
  weights: [0, 0, 2, 2, 3, 1, 0, 1],
  vectors: [
    { id: 'V1', bits: '11101000' },
    { id: 'V2', bits: '10001101' },
    { id: 'V3', bits: '00011001' },
    { id: 'V4', bits: '00010010' },
  ],
};
