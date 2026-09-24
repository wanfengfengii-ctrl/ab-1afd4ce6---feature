/**
 * ramping.test.mjs —— 缓变加载（按录入顺序、先降位再全局最优分组置高）测试。
 *
 * 关键：用一份完全独立的“有序集合划分（Fubini 数）全枚举”暴力实现对拍
 * planRiseGroups 的：
 *   - 可行性（超重 / 无法分组 / 空置高集合）；
 *   - 最少置高阶段（暂态）数；
 *   - 各阶段置高引脚 P 序列字典序决胜；
 * 保证生产代码不是逐引脚试探或贪心装箱，而是对“全部分组 × 全部阶段顺序”的全局裁决。
 *
 * 另有 solveRamping 端到端：录入顺序固定、原掩码采样、降位先于置高、
 * 暂态累计与回零；以及 MAXRISE 导入导出往返与失败原因定位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solveRamping,
  planRiseGroups,
  validateRamping,
  parseImport,
  exportModel,
  RAMP_KEYWORD,
  maskFromBits,
} from '../js/solver.js';

// ---------- 独立暴力：有序集合划分全枚举 ----------

/** 无序集合划分（限制成长式生成，每份划分恰好一次） */
function setPartitions(arr) {
  if (arr.length === 0) return [[]];
  const [x, ...rest] = arr;
  const out = [];
  for (const part of setPartitions(rest)) {
    for (let i = 0; i < part.length; i += 1) {
      out.push(part.map((b, j) => (j === i ? [...b, x] : b)));
    }
    out.push([...part, [x]]);
  }
  return out;
}

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((v, i) => {
    permutations(arr.slice(0, i).concat(arr.slice(i + 1))).forEach((p) => out.push([v, ...p]));
  });
  return out;
}

/** 有序集合划分 = 无序划分 × 块的全部排列（阶段顺序完整枚举） */
function orderedPartitions(arr) {
  const out = [];
  for (const part of setPartitions(arr)) {
    for (const perm of permutations(part)) {
      out.push(perm.map((g) => [...g].sort((a, b) => a - b)));
    }
  }
  return out;
}

function seqCmp(a, b) {
  const s = Math.min(a.length, b.length);
  for (let i = 0; i < s; i += 1) {
    const p = Math.min(a[i].length, b[i].length);
    for (let j = 0; j < p; j += 1) {
      if (a[i][j] !== b[i][j]) return a[i][j] - b[i][j];
    }
    if (a[i].length !== b[i].length) return a[i].length - b[i].length;
  }
  return a.length - b.length;
}

function brutePlan(risePinNos, weights, limit, cap) {
  const overweight = risePinNos.filter((p) => weights[p - 1] > limit);
  if (overweight.length > 0) return { feasible: false, reason: 'overweight', overweight };
  if (risePinNos.length === 0) return { feasible: true, seq: [], stages: 0 };

  let best = null;
  for (const part of orderedPartitions(risePinNos)) {
    let ok = true;
    for (const g of part) {
      if (g.length > cap) { ok = false; break; }
      let wsum = 0;
      for (const p of g) wsum += weights[p - 1];
      if (wsum > limit) { ok = false; break; }
    }
    if (!ok) continue;
    if (best === null || part.length < best.seq.length
      || (part.length === best.seq.length && seqCmp(part, best.seq) < 0)) {
      best = { seq: part, stages: part.length };
    }
  }
  return best === null ? { feasible: false, reason: 'ungroupable' } : { feasible: true, ...best };
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

// ---------- 对拍 ----------

test('随机对拍：分组裁决与 Fubini 全枚举在可行性/最少阶段数/P 序列字典序上完全一致', () => {
  const PIN = 8;
  const r = rng(0xC0FFEE);
  for (let iter = 0; iter < 1200; iter += 1) {
    const weights = Array.from({ length: PIN }, () => Math.floor(r() * 5)); // 0..4
    const limit = Math.floor(r() * 6); // 0..5
    const cap = 1 + Math.floor(r() * PIN); // 1..8
    const chosen = [];
    for (let p = 1; p <= PIN; p += 1) if (r() < 0.55) chosen.push(p);
    let mask = 0;
    for (const p of chosen) mask |= 1 << (PIN - p);

    const got = planRiseGroups(mask, PIN, weights, limit, cap);
    const want = brutePlan(chosen, weights, limit, cap);

    assert.equal(got.feasible, want.feasible,
      `iter=${iter} 可行性不一致 chosen=${chosen} cap=${cap} limit=${limit}`);

    if (!want.feasible) {
      assert.equal(got.reason, want.reason, `iter=${iter} 失败原因不一致`);
      if (want.reason === 'overweight') {
        assert.deepEqual(
          got.overloadPins.map((o) => o.pin).sort(),
          want.overweight.map((p) => `P${p}`).sort(),
          `iter=${iter} 超重引脚定位不一致`,
        );
      }
      continue;
    }

    assert.equal(got.stages, want.stages,
      `iter=${iter} 最少阶段数不一致 chosen=${chosen} cap=${cap} limit=${limit} w=${weights}`);
    const gotSeq = got.groups.map((g) => g.pinNos);
    assert.equal(seqCmp(gotSeq, want.seq), 0,
      `iter=${iter} P 序列字典序不一致 got=${JSON.stringify(gotSeq)} want=${JSON.stringify(want.seq)}`);

    // 完整性与逐组合法性
    assert.deepEqual(got.groups.flatMap((g) => g.pinNos).sort((a, b) => a - b),
      [...chosen].sort((a, b) => a - b), `iter=${iter} 未完整覆盖待置高引脚`);
    for (const g of got.groups) {
      assert.ok(g.count <= cap, `iter=${iter} 置高引脚数超新上限`);
      const wsum = g.pinNos.reduce((s, p) => s + weights[p - 1], 0);
      assert.equal(g.surge, wsum, `iter=${iter} 浪涌明细错误`);
      assert.ok(g.surge <= limit, `iter=${iter} 置高组浪涌越过既有限额`);
    }
  }
});

test('k=20 规模：全局分组在毫秒级完成且决胜为字典序最优', () => {
  const t0 = Date.now();
  const got = planRiseGroups((1 << 20) - 1, 20, Array(20).fill(1), 5, 6);
  assert.ok(Date.now() - t0 < 3000, 'k=20 分组应在 3 秒内完成');
  // 权重下界 ceil(20/5)=4 组（紧于引脚数下界 ceil(20/6)=4，相同）
  assert.equal(got.stages, 4);
  assert.deepEqual(got.groups.map((g) => g.pinNos),
    [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13, 14, 15], [16, 17, 18, 19, 20]]);

  // 限额更紧：limit=3（每组 ≤3 脚），字典序最优首组取最小可行序列 [1,2]
  const tight = planRiseGroups((1 << 20) - 1, 20, Array(20).fill(1), 3, 10);
  assert.equal(tight.stages, 7);
  assert.deepEqual(tight.groups.map((g) => g.pinNos),
    [[1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11], [12, 13, 14], [15, 16, 17], [18, 19, 20]]);
});

test('稳定决胜专项：最少组数并列时严格按阶段 P 序列字典序', () => {
  // cap=2,limit=3；w(P1)=2,w(P2)=2,w(P3)=1。
  // 可行对 {1,3}/{2,3}；2 组的可行有序划分中字典序最小 = [[1],[2,3]]
  const got = planRiseGroups(maskFromBits('11100000'), 8, [2, 2, 1, 0, 0, 0, 0, 0], 3, 2);
  assert.equal(got.stages, 2);
  assert.deepEqual(got.groups.map((g) => g.pinNos), [[1], [2, 3]]);
});

test('单引脚权重大于限额：定位到具体引脚（独占一组也越限）', () => {
  const got = planRiseGroups(maskFromBits('10100000'), 8, [9, 1, 6, 1, 1, 1, 1, 1], 5, 2);
  assert.equal(got.feasible, false);
  assert.equal(got.reason, 'overweight');
  assert.deepEqual(got.overloadPins, [{ pin: 'P1', weight: 9 }, { pin: 'P3', weight: 6 }]);
});

test('空置高集合：无置高阶段（该跳可能只有降位）', () => {
  const got = planRiseGroups(0, 8, Array(8).fill(1), 0, 1);
  assert.equal(got.feasible, true);
  assert.equal(got.stages, 0);
  assert.deepEqual(got.groups, []);
});

// ---------- solveRamping 端到端 ----------

const baseRamp = () => ({
  pinCount: 8,
  limit: 3,
  maxRisePins: 1,
  weights: [1, 1, 1, 1, 1, 1, 1, 1],
  vectors: [
    { id: 'A', bits: '11000000' },
    { id: 'B', bits: '01100000' },
    { id: 'C', bits: '01110000' },
    { id: 'D', bits: '00000000' },
  ],
});

test('solveRamping：录入顺序固定、先降位后分组置高、原掩码采样、暂态累计与回零', () => {
  const model = baseRamp();
  const got = solveRamping(model);
  assert.equal(got.ok, true);
  assert.equal(got.feasible, true);
  assert.deepEqual(got.order, ['A', 'B', 'C', 'D']);
  // A: 升 P1,P2（cap=1 -> 2 组，无降位）= 2 暂态
  // B: 降 P1 + 升 P3 = 2；C: 升 P4 = 1；D: 降 P2,P3,P4 = 1；末态全零无回零暂态
  assert.equal(got.totalGroups, 4);
  assert.equal(got.totalTransients, 6);

  const [a, b, c, d] = got.jumps;
  assert.equal(a.transientCount, 2);
  assert.deepEqual(a.stages.map((s) => s.kind), ['rise', 'rise']);
  assert.deepEqual(a.stages[0].pins, ['P1']);
  assert.deepEqual(a.stages[1].pins, ['P2']);
  assert.equal(a.targetBits, '11000000');

  assert.equal(b.transientCount, 2);
  assert.equal(b.stages[0].kind, 'fall');
  assert.deepEqual(b.stages[0].pins, ['P1']);
  assert.equal(b.stages[0].bits, '01000000'); // 降位后 = 前后掩码交集
  assert.equal(b.stages[1].kind, 'rise');
  assert.deepEqual(b.stages[1].pins, ['P3']);
  assert.equal(b.targetBits, '01100000');
  assert.equal(b.cumulativeTransients, 4);

  assert.equal(c.transientCount, 1);
  assert.deepEqual(c.fallPins, []);
  assert.equal(d.transientCount, 1);
  assert.deepEqual(d.stages[0].pins, ['P2', 'P3', 'P4']);

  // 每个正式采样掩码就是向量本身（采样点不被缓变改变）
  got.jumps.forEach((j, i) => assert.equal(j.targetBits, model.vectors[i].bits));
  // 回零：D 已为全零，无需回零暂态
  assert.equal(got.returnJump.prevBits, '00000000');
  assert.equal(got.returnJump.targetBits, '00000000');
  assert.deepEqual(got.returnJump.stages, []);
});

test('solveRamping：末向量非零时回零跳含一次统一降位暂态', () => {
  const model = baseRamp();
  model.vectors[3] = { id: 'D', bits: '00010000' };
  const got = solveRamping(model);
  assert.equal(got.feasible, true);
  assert.equal(got.returnJump.stages.length, 1);
  assert.equal(got.returnJump.stages[0].kind, 'fall');
  assert.deepEqual(got.returnJump.stages[0].pins, ['P4']);
  assert.equal(got.returnJump.targetBits, '00000000');
});

test('solveRamping 失败：定位超重引脚、录入行号与前后掩码，并继续分析其余跳', () => {
  const model = {
    pinCount: 8,
    limit: 3,
    maxRisePins: 2,
    weights: [5, 1, 1, 1, 1, 1, 1, 1],
    vectors: [
      { id: 'A', bits: '01000000' },
      { id: 'B', bits: '11000000' }, // 升 P1(w=5) > 3
      { id: 'C', bits: '01000000' },
      { id: 'D', bits: '00000000' },
    ],
  };
  const got = solveRamping(model);
  assert.equal(got.ok, true);
  assert.equal(got.feasible, false);
  assert.equal(got.failures.length, 1);
  const f = got.failures[0];
  assert.equal(f.vectorIndex, 1);
  assert.equal(f.vectorId, 'B');
  assert.equal(f.reason, 'overweight');
  assert.deepEqual(f.overloadPins, [{ pin: 'P1', weight: 5 }]);
  assert.equal(f.prevBits, '01000000');
  assert.equal(f.targetBits, '11000000');
  // A/C/D 三跳仍然完成规划并给出
  assert.equal(got.jumps.length, 3);
  assert.deepEqual(got.jumps.map((j) => j.vectorId), ['A', 'C', 'D']);
});

test('参数校验：maxRisePins 越界/缺失被定位，且通用校验仍然生效', () => {
  const m = baseRamp();
  m.maxRisePins = 0;
  assert.ok(validateRamping(m).some((e) => e.scope === 'maxRisePins'));
  m.maxRisePins = 9;
  assert.ok(validateRamping(m).some((e) => e.scope === 'maxRisePins'));
  m.maxRisePins = 2;
  m.vectors = m.vectors.slice(0, 2); // 向量数不足同样报错
  assert.ok(validateRamping(m).some((e) => e.scope === 'vectors'));
  // solveRamping 对非法输入返回 ok:false
  const bad = baseRamp();
  bad.maxRisePins = 'x';
  assert.equal(solveRamping(bad).ok, false);
});

test(`导入导出：${RAMP_KEYWORD} 指令往返；缺省指令时向后兼容`, () => {
  const text = [
    'PINS 8',
    'LIMIT 3',
    'W 1 1 1 1 1 1 1 1',
    `${RAMP_KEYWORD} 2`,
    'A 11000000',
    'B 01100000',
    'C 01110000',
    'D 00000000',
  ].join('\n') + '\n';
  const { model, errors } = parseImport(text);
  assert.deepEqual(errors, []);
  assert.equal(model.maxRisePins, 2);
  assert.equal(exportModel(model), text);

  // 旧格式（无 MAXRISE）仍可导入，字段为 null，导出结果与旧格式逐字节一致
  const legacy = text.replace(`${RAMP_KEYWORD} 2\n`, '');
  const r2 = parseImport(legacy);
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.model.maxRisePins, null);
  assert.equal(exportModel(r2.model), legacy);

  // MAXRISE 超过位数报错并带行号（追加在向量行之后，第 8 行）
  const bad = legacy + `${RAMP_KEYWORD} 9\n`;
  const r3 = parseImport(bad);
  assert.ok(r3.errors.some((e) => e.line === 8 && new RegExp(RAMP_KEYWORD).test(e.message)));
});
