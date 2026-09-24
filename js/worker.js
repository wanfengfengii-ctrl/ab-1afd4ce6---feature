/**
 * worker.js —— 在后台线程执行裁决，避免大规模穷举时阻塞页面交互。
 * 作为模块 Worker 加载（new Worker('js/worker.js', { type:'module' })）。
 * mode:
 *   'closed' —— 闭环加载顺序全局裁决（solveModel，语义保持不变）；
 *   'ramp'   —— 缓变加载：按录入顺序，逐跳全局最优分组（solveRamping）。
 */
import { solveModel, solveRamping } from './solver.js';

function stringifyBigInts(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(stringifyBigInts);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stringifyBigInts(v);
    return out;
  }
  return value;
}

self.onmessage = (e) => {
  const { model, nonce, mode } = e.data || {};
  try {
    const result = mode === 'ramp' ? solveRamping(model) : solveModel(model);
    // BigInt 无法结构化克隆，递归转为字符串后传输
    self.postMessage({ type: 'result', nonce, mode, result: stringifyBigInts(result) });
  } catch (err) {
    self.postMessage({ type: 'error', nonce, mode, message: String(err && err.stack || err) });
  }
};
