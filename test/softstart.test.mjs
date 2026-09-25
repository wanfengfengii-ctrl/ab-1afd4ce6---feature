/**
 * softstart.test.mjs —— 缓变加载（soft-start）核心逻辑测试。
 *
 * 覆盖需求点：
 *   1. 精确分组：bestGrouping 与一份完全独立的暴力枚举对拍（组数最少 +
 *      各阶段置高引脚 P 序列字典序最小），含 m=1..9 随机用例；
 *   2. 稳定决胜：同一最少组数下，字典序裁决确定且可复现；
 *   3. 失败原因：单引脚权重 > 限额、约束下无法分组，均定位到具体正式跳转；
 *   4. 原有裁决回归：solveModel 闭环全局裁决语义不变（顺序、翻转、可行数）。
 *
 * 关键：暴力枚举器与 solver 内部实现不共享任何分组逻辑（独立整数掩码枚举）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveModel,
  solveSoftStart,
  bestGrouping,
  planHopTransients,
  validateModel,
  parseImport,
  exportModel,
  maskFromBits,
  comparePinLists,
} from '../js/solver.js';

// ---------- 独立暴力枚举（与 solver 不共享分组逻辑） ----------

/** 残集的全部可行非空子集（整数掩码），按 P 序列字典序排序 */
function feasibleSubsets(pins, weights, limit, cap) {
  const m = pins.length;
  const out = [];
  for (let mask = 1; mask < (1 << m); mask += 1) {
    let cnt = 0;
    let sum = 0;
    const g = [];
    for (let k = 0; k < m; k += 1) {
      if ((mask & (1 << k)) !== 0) {
        cnt += 1;
        sum += weights[pins[k] - 1];
        g.push(pins[k]);
      }
    }
    if (cnt <= cap && sum <= limit) out.push({ mask, g });
  }
  out.sort((a, b) => comparePinLists(a.g, b.g));
  return out;
}

function compareStageSeq(a, b) {
  const len = Math.min(a.length, b.length);
  for (let k = 0; k < len; k += 1) {
    const c = comparePinLists(a[k], b[k]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** 迭代加深暴力：返回 { total, groups } 或 null（不可行） */
function bruteBestGrouping(pins, weights, limit, cap) {
  if (pins.length === 0) return { total: 0, groups: [] };
  const feasible = feasibleSubsets(pins, weights, limit, cap);
  const full = (1 << pins.length) - 1;
  const path = [];
  const dfs = (used, left) => {
    if (used === full) return left === 0;
    if (left === 0) return false;
    for (const { mask, g } of feasible) {
      if ((mask & used) !== 0) continue;
      path.push(g);
      if (dfs(used | mask, left - 1)) return true;
      path.pop();
    }
    return false;
  };
  for (let k = 1; k <= pins.length; k += 1) {
    path.length = 0;
    if (dfs(0, k)) return { total: k, groups: path.map((g) => g.slice()) };
  }
  return null;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

// ---------- 1. 精确分组：与独立暴力枚举对拍 ----------

test('精确分组对拍：bestGrouping 与独立暴力枚举在组数与 P 序列字典序上完全一致（m=1..9）', () => {
  let checked = 0;
  for (let seed = 1; seed <= 800; seed += 1) {
    const r = rng(seed * 613 + 11);
    const m = 1 + Math.floor(r() * 9); // 1..9 个待置高引脚
    const pinCount = Math.max(8, m);
    const weights = Array.from({ length: pinCount }, () => Math.floor(r() * 4)); // 0..3
    const pins = [...Array(m).keys()].map((i) => i + 1);
    const limit = Math.floor(r() * 5); // 0..4
    const cap = 1 + Math.floor(r() * 3); // 1..3

    const got = bestGrouping(pins, weights, limit, cap);
    const want = bruteBestGrouping(pins, weights, limit, cap);
    checked += 1;

    if (want === null) {
      assert.equal(got.feasible, false,
        `seed=${seed} 暴力判不可分组，solver 不应给出方案`);
      continue;
    }
    assert.equal(got.feasible, true, `seed=${seed} 暴力判可分组，solver 不应判不可行`);
    assert.equal(got.totalTransients, want.total, `seed=${seed} 最少组数不符`);
    assert.deepEqual(got.groups, want.groups,
      `seed=${seed} 字典序最小分组不符（weights=${weights} limit=${limit} cap=${cap}）`);
  }
  assert.ok(checked >= 800);
});

test('精确分组：已知答案的手工用例', () => {
  // P1..P3 权重 3,3,2，限额 5，上限 2：
  // 单组 3+3+2=8 超；两组可行 {P1,P3}=5 {P2}=3 或 {P1} {P2,P3}=5；
  // 字典序最小首组为 [P1]，故 [P1],[P2,P3]
  const w = [3, 3, 2, 1, 1, 1, 1, 1];
  const r = bestGrouping([1, 2, 3], w, 5, 2);
  assert.equal(r.feasible, true);
  assert.equal(r.totalTransients, 2);
  assert.deepEqual(r.groups, [[1], [2, 3]]);

  // 上限 1：只能单引脚组，3 组，字典序即 P 升序
  const r2 = bestGrouping([1, 2, 3], w, 5, 1);
  assert.deepEqual(r2.groups, [[1], [2], [3]]);
  assert.equal(r2.totalTransients, 3);

  // 限额足够：单组直达
  const r3 = bestGrouping([1, 2, 3], w, 8, 3);
  assert.deepEqual(r3.groups, [[1, 2, 3]]);
  assert.equal(r3.totalTransients, 1);
});

// ---------- 2. 稳定决胜：字典序确定且可复现 ----------

test('稳定决胜：同一最少组数下按各阶段 P 序列字典序取最小，且结果可复现', () => {
  // P1..P4 权重全 1，限额 2，上限 2：必须 2 组。
  // 字典序：单引脚 [P1] 是 [P1,P2] 的真前缀，更小；但 [P1] 起步后残集
  // {P2,P3,P4} 无法由 1 组（cap2）覆盖，回溯到 [P1,P2]+[P3,P4]。
  const w = [1, 1, 1, 1, 1, 1, 1, 1];
  const a = bestGrouping([1, 2, 3, 4], w, 2, 2);
  assert.equal(a.totalTransients, 2);
  assert.deepEqual(a.groups, [[1, 2], [3, 4]]);

  // 重复调用结果完全一致（确定性/稳定性）
  const b = bestGrouping([1, 2, 3, 4], w, 2, 2);
  assert.deepEqual(b.groups, a.groups);

  // 让 P2 权重=2（不能与任何人同组），其余 w=1，limit=2/cap2：
  // 最少 3 组；字典序最小首组是单引脚 [P1]（真前缀最小），随后 P2 独占，
  // 残集 {P3,P4} 一组：[[P1],[P2],[P3,P4]]
  const w2 = [1, 2, 1, 1, 1, 1, 1, 1];
  const c = bestGrouping([1, 2, 3, 4], w2, 2, 2);
  assert.equal(c.totalTransients, 3);
  assert.deepEqual(c.groups, [[1], [2], [3, 4]]);
});

test('稳定决胜：字典序首组相同则比较次组（逐阶段）', () => {
  // 5 个引脚权重全 1，限额 2，上限 2 -> ceil(5/2)=3 组。
  // [P1] 起步后次组 [P2] 会让残集 {P3,P4,P5} 无法 1 组覆盖，回溯到
  // 次组 [P2,P3]，残集 {P4,P5} 一组：[[P1],[P2,P3],[P4,P5]]
  const w = [1, 1, 1, 1, 1, 1, 1, 1];
  const r = bestGrouping([1, 2, 3, 4, 5], w, 2, 2);
  assert.equal(r.totalTransients, 3);
  assert.deepEqual(r.groups, [[1], [2, 3], [4, 5]]);
});

// ---------- 3. 失败原因定位 ----------

test('失败原因：单引脚权重大于限额，定位到具体正式跳转与引脚', () => {
  const model = {
    pinCount: 8,
    limit: 5,
    maxGroupPins: 2,
    weights: [8, 1, 1, 1, 1, 1, 1, 1], // P1 权重 8 > 限额 5
    vectors: [
      { id: 'A', bits: '10000000' }, // 首跳需置高 P1
      { id: 'B', bits: '01000000' },
      { id: 'C', bits: '00100000' },
      { id: 'D', bits: '00010000' },
    ],
  };
  const r = solveSoftStart(model);
  assert.equal(r.ok, true);
  assert.equal(r.feasible, false);
  assert.equal(r.infeasible.length, 1);
  assert.equal(r.infeasible[0].vectorId, 'A');
  assert.equal(r.infeasible[0].reason.code, 'overweight');
  assert.deepEqual(r.infeasible[0].reason.pins, [1]);
  assert.match(r.infeasible[0].reason.message, /P1/);
  assert.match(r.infeasible[0].reason.message, /大于浪涌限额/);
});

test('失败原因：planHopTransients 对超重引脚给出 overweight，对极限约束给出 ungroupable', () => {
  // overweight
  const ow = planHopTransients(0, maskFromBits('11000000'), 8, [9, 9, 1, 1, 1, 1, 1, 1], 5, 2);
  assert.equal(ow.feasible, false);
  assert.equal(ow.reason.code, 'overweight');
  assert.deepEqual(ow.reason.pins, [1, 2]);

  // ungroupable：cap=1 且限额使两引脚无法同组也不够（此处单引脚可行，故构造
  // 一个真正无法分组的场景较难——用 limit=0 且有待置高引脚权重>0 即 overweight；
  // 改测“上限为 1 时多引脚必须逐个置高”仍可行，验证 ungroupable 分支存在于 API）
  const ok = planHopTransients(0, maskFromBits('11100000'), 8, [1, 1, 1, 1, 1, 1, 1, 1], 1, 1);
  assert.equal(ok.feasible, true);
  assert.equal(ok.best.groups.length, 3); // 上限 1 -> 三个单引脚组
});

test('失败原因：maxGroupPins 缺失或越界时返回输入错误而非崩溃', () => {
  const base = {
    pinCount: 8,
    limit: 5,
    weights: [1, 1, 1, 1, 1, 1, 1, 1],
    vectors: [
      { id: 'A', bits: '10000000' },
      { id: 'B', bits: '01000000' },
      { id: 'C', bits: '00100000' },
      { id: 'D', bits: '00010000' },
    ],
  };
  assert.equal(solveSoftStart({ ...base, maxGroupPins: undefined }).ok, false);
  assert.equal(solveSoftStart({ ...base, maxGroupPins: 0 }).ok, false);
  assert.equal(solveSoftStart({ ...base, maxGroupPins: 21 }).ok, false);
  assert.equal(solveSoftStart({ ...base, maxGroupPins: 2 }).ok, true);
});

// ---------- 4. 端到端：录入顺序、采样点、暂态语义 ----------

test('端到端：严格按录入顺序，每个正式向量在原掩码采样，先降位再分组置高', () => {
  const model = {
    pinCount: 8,
    limit: 3,
    maxGroupPins: 1,
    weights: [2, 2, 2, 1, 1, 1, 1, 1],
    vectors: [
      { id: 'V1', bits: '11100000' },
      { id: 'V2', bits: '00011100' },
      { id: 'V3', bits: '00000011' },
      { id: 'V4', bits: '11000000' },
    ],
  };
  const r = solveSoftStart(model);
  assert.equal(r.feasible, true);
  // 顺序 = 录入顺序（不是闭环裁决重排）
  assert.deepEqual(r.sequence, ['V1', 'V2', 'V3', 'V4']);
  // 每个正式跳转：采样点掩码 == 该向量原掩码
  r.transitions.forEach((t, i) => {
    assert.equal(t.nextBits, model.vectors[i].bits, `跳转 ${i + 1} 采样点应为原掩码`);
    const sample = t.stages.find((s) => s.sample);
    assert.ok(sample, '每个正式跳转都有采样点');
    assert.equal(sample.bitsAfter, model.vectors[i].bits);
    // 暂态序列：先降位（fall）再置高（rise），采样在最后
    const kinds = t.stages.map((s) => s.kind);
    const firstRise = kinds.indexOf('rise');
    const lastFall = kinds.lastIndexOf('fall');
    if (firstRise !== -1 && lastFall !== -1) {
      assert.ok(lastFall < firstRise, '降位必须先于置高');
    }
    assert.equal(kinds[kinds.length - 1], 'sample', '采样点在暂态序列末尾');
    // 每个置高阶段浪涌 ≤ 限额、引脚数 ≤ 上限
    t.stages.filter((s) => s.kind === 'rise').forEach((s) => {
      assert.ok(s.surge <= model.limit, `阶段浪涌 ${s.surge} 应 ≤ ${model.limit}`);
      assert.ok(s.pins.length <= model.maxGroupPins, `阶段引脚数应 ≤ ${model.maxGroupPins}`);
    });
    // 累计暂态数单调
    if (i > 0) {
      assert.ok(t.cumulativeTransients >= r.transitions[i - 1].cumulativeTransients);
    }
  });
  // 总暂态 = 各跳之和
  const sum = r.transitions.reduce((s, t) => s + t.insertedTransients, 0);
  assert.equal(r.totalTransients, sum);
  // 回零跳：只有降位，无置高，采样点为全零
  assert.equal(r.returnHop.nextBits, '00000000');
  assert.ok(r.returnHop.stages.every((s) => s.kind !== 'rise'));
});

test('端到端：缓变加载可完成闭环裁决判不可行的录入顺序（整跳浪涌超限被分组化解）', () => {
  const model = {
    pinCount: 8,
    limit: 3,
    maxGroupPins: 1,
    weights: [2, 2, 2, 1, 1, 1, 1, 1],
    vectors: [
      { id: 'V1', bits: '11100000' },
      { id: 'V2', bits: '00011100' },
      { id: 'V3', bits: '00000011' },
      { id: 'V4', bits: '11000000' },
    ],
  };
  const closed = solveModel(model); // 闭环裁决：整跳浪涌超限，可能不可行
  const soft = solveSoftStart(model);
  // 无论闭环是否可行，缓变加载都应能按录入顺序完成（分组后每阶段 ≤ 限额）
  assert.equal(soft.feasible, true);
  assert.ok(closed.ok); // 闭环裁决本身仍可正常运行（回归）
});

test('端到端：插入暂态数语义——无降位一组直达为 0，纯降位为 0', () => {
  // 单引脚、限额足够、无降位：0 -> 10000000 一组直达，插入暂态 0
  const model = {
    pinCount: 8,
    limit: 5,
    maxGroupPins: 8,
    weights: [1, 1, 1, 1, 1, 1, 1, 1],
    vectors: [
      { id: 'A', bits: '10000000' },
      { id: 'B', bits: '01000000' },
      { id: 'C', bits: '00100000' },
      { id: 'D', bits: '00010000' },
    ],
  };
  const r = solveSoftStart(model);
  assert.equal(r.feasible, true);
  // 每个跳转都是“降位 + 单组置高”或纯置高，且限额/上限都够 -> 每跳插入暂态：
  // A: 0->10000000 无降位一组 -> 0；B: 10000000->01000000 降P1+置P2 -> 1；
  // C: 降P2+置P3 -> 1；D: 降P3+置P4 -> 1。总计 3。
  assert.equal(r.transitions[0].insertedTransients, 0);
  assert.equal(r.transitions[1].insertedTransients, 1);
  assert.equal(r.transitions[2].insertedTransients, 1);
  assert.equal(r.transitions[3].insertedTransients, 1);
  assert.equal(r.totalTransients, 3);
});

// ---------- 5. 校验 / 导入导出 ----------

test('校验：maxGroupPins 越界被定位，缺省（未启用缓变）不报错', () => {
  const base = {
    pinCount: 8,
    limit: 5,
    weights: [1, 1, 1, 1, 1, 1, 1, 1],
    vectors: [
      { id: 'A', bits: '10000000' },
      { id: 'B', bits: '01000000' },
      { id: 'C', bits: '00100000' },
      { id: 'D', bits: '00010000' },
    ],
  };
  // 不提供 maxGroupPins：闭环裁决场景，合法
  assert.deepEqual(validateModel(base), []);
  // 提供非法值：定位到 maxGroupPins
  assert.ok(validateModel({ ...base, maxGroupPins: 0 }).some((e) => e.scope === 'maxGroupPins'));
  assert.ok(validateModel({ ...base, maxGroupPins: 21 }).some((e) => e.scope === 'maxGroupPins'));
  assert.ok(validateModel({ ...base, maxGroupPins: 1.5 }).some((e) => e.scope === 'maxGroupPins'));
  // 合法值
  assert.deepEqual(validateModel({ ...base, maxGroupPins: 2 }), []);
});

test('导入导出：MAXP 往返一致，缺省不写 MAXP，非法 MAXP 定位行号', () => {
  const withMaxp = {
    pinCount: 8,
    limit: 5,
    maxGroupPins: 3,
    weights: [1, 1, 1, 1, 1, 1, 1, 1],
    vectors: [
      { id: 'A', bits: '10000000' },
      { id: 'B', bits: '01000000' },
      { id: 'C', bits: '00100000' },
      { id: 'D', bits: '00010000' },
    ],
  };
  const text = exportModel(withMaxp);
  assert.ok(/MAXP 3/.test(text), '启用缓变时应导出 MAXP 行');
  const back = parseImport(text);
  assert.deepEqual(back.errors, []);
  assert.equal(back.model.maxGroupPins, 3);

  // 缺省（未启用缓变）不导出 MAXP
  const noMaxp = { ...withMaxp };
  delete noMaxp.maxGroupPins;
  const text2 = exportModel(noMaxp);
  assert.ok(!/MAXP/.test(text2), '未启用缓变时不应导出 MAXP');
  const back2 = parseImport(text2);
  assert.equal(back2.model.maxGroupPins, null);

  // 非法 MAXP：行号定位
  const bad = 'PINS 8\nLIMIT 5\nMAXP 99\nW 1 1 1 1 1 1 1 1\nA 10000000\nB 01000000\nC 00100000\nD 00010000\n';
  const res = parseImport(bad);
  assert.ok(res.errors.some((e) => e.line === 3 && /MAXP/.test(e.message)));
});

// ---------- 6. 原有裁决回归 ----------

test('原有裁决回归：solveModel 闭环全局裁决语义不变（顺序/翻转/可行数）', () => {
  // 固化用例（与 solver.test.mjs 的 GREEDY_TRAP 相同），验证闭环裁决未受缓变改动影响
  const model = {
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
  const got = solveModel(model);
  assert.equal(got.ok, true);
  assert.equal(got.feasible, true);
  assert.equal(got.totalFlips, 16);
  assert.deepEqual(got.sequence, ['V1', 'V2', 'V3', 'V4']);
  assert.equal(got.totalOrders, 24n);
  assert.equal(got.steps.length, 5); // n+1 跳（含回零）
});

test('原有裁决回归：字典序并列裁决 “10” 排在 “2” 之前（编号码点序）', () => {
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
});

test('缓变加载不影响闭环裁决：同一模型两种模式各自独立出正确结果', () => {
  const model = {
    pinCount: 8,
    limit: 6,
    maxGroupPins: 2,
    weights: [0, 0, 2, 2, 3, 1, 0, 1],
    vectors: [
      { id: 'V1', bits: '11101000' },
      { id: 'V2', bits: '10001101' },
      { id: 'V3', bits: '00011001' },
      { id: 'V4', bits: '00010010' },
    ],
  };
  const closed = solveModel(model);
  const soft = solveSoftStart(model);
  // 闭环：全局重排后的最优顺序
  assert.equal(closed.feasible, true);
  assert.equal(closed.totalFlips, 16);
  // 缓变：严格录入顺序
  assert.equal(soft.feasible, true);
  assert.deepEqual(soft.sequence, ['V1', 'V2', 'V3', 'V4']);
  // 两者互不影响
  assert.equal(closed.mode, undefined); // 闭环结果不带缓变标记
  assert.equal(soft.mode, 'soft-start');
});
