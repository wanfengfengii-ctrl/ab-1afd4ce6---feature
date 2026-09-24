/**
 * worker.js —— 在后台线程执行全局裁决，避免 n=12 穷举时阻塞页面交互。
 * 作为模块 Worker 加载（new Worker('js/worker.js', { type:'module' })）。
 */
import { solveModel } from './solver.js';

self.onmessage = (e) => {
  const { model, nonce } = e.data || {};
  try {
    const result = solveModel(model);
    // BigInt 无法结构化克隆，转为字符串传输
    const payload = {
      ...result,
      totalOrders: result.totalOrders != null ? result.totalOrders.toString() : null,
      feasibleOrders: result.feasibleOrders != null ? result.feasibleOrders.toString() : null,
    };
    self.postMessage({ type: 'result', nonce, result: payload });
  } catch (err) {
    self.postMessage({ type: 'error', nonce, message: String(err && err.stack || err) });
  }
};
