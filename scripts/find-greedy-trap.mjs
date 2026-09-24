/**
 * find-greedy-trap.mjs —— 搜索“最近邻逐跳贪心”与全局最优裁决不一致的用例。
 * 运行：node scripts/find-greedy-trap.mjs
 * 找到后可把输出的 JSON 固化到 test/solver.test.mjs 的 GREEDY_TRAP。
 */
import { solveModel, hopSurge, popCount, maskFromBits } from '../js/solver.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

function greedyOrder(model) {
  const masks = model.vectors.map((v) => maskFromBits(v.bits));
  const remaining = new Set(masks.keys());
  let prev = 0;
  const seq = [];
  while (remaining.size > 0) {
    let pick = null;
    for (const j of remaining) {
      if (hopSurge(prev, masks[j], model.pinCount, model.weights) > model.limit) continue;
      const d = popCount(prev ^ masks[j]);
      if (pick === null
        || d < pick.d
        || (d === pick.d && model.vectors[j].id < model.vectors[pick.j].id)) {
        pick = { j, d };
      }
    }
    if (pick === null) return { seq, dead: true };
    seq.push(model.vectors[pick.j].id);
    prev = masks[pick.j];
    remaining.delete(pick.j);
  }
  return { seq, dead: false };
}

for (let seed = 1; seed < 100000; seed += 1) {
  const r = rng(seed);
  const n = 4;
  const pinCount = 8;
  const weights = Array.from({ length: pinCount }, () => Math.floor(r() * 4));
  const used = new Set();
  const vectors = [];
  for (let i = 0; i < n; i += 1) {
    let bits;
    do {
      bits = Array.from({ length: pinCount }, () => (r() < 0.45 ? '1' : '0')).join('');
    } while (used.has(bits));
    used.add(bits);
    vectors.push({ id: `V${i + 1}`, bits });
  }
  const limit = Math.floor(r() * 6) + 1;
  const model = { pinCount, limit, weights, vectors };
  const got = solveModel(model);
  if (!got.feasible) continue;
  const greedy = greedyOrder(model);
  if (greedy.dead || greedy.seq.join(',') !== got.sequence.join(',')) {
    console.log(JSON.stringify({ seed, model, global: got.sequence, greedy: greedy.seq }, null, 2));
    process.exit(0);
  }
}
console.error('未找到反贪费用例');
process.exit(1);
