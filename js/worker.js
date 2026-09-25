/**
 * worker.js —— 在后台线程执行裁决，避免穷举时阻塞页面交互。
 * 作为模块 Worker 加载（new Worker('js/worker.js', { type:'module' })）。
 *
 * 支持两种模式：
 *   - mode 默认（闭环裁决）：solveModel，完整比较全部 n! 条闭环顺序；
 *   - mode === 'soft-start'（缓变加载）：solveSoftStart，按当前录入顺序规划暂态。
 * 两者共用同一份录入模型，互不影响；任一编辑都会撤下旧报告（由 app 侧 nonce 控制）。
 */
import { solveModel, solveSoftStart } from './solver.js';

self.onmessage = (e) => {
  const { model, nonce, mode } = e.data || {};
  try {
    const result = mode === 'soft-start' ? solveSoftStart(model) : solveModel(model);
    // BigInt 无法结构化克隆，转为字符串传输（缓变模式无这两个字段，置 null）
    const payload = {
      ...result,
      totalOrders: result.totalOrders != null ? result.totalOrders.toString() : null,
      feasibleOrders: result.feasibleOrders != null ? result.feasibleOrders.toString() : null,
    };
    self.postMessage({ type: 'result', nonce, mode, result: payload });
  } catch (err) {
    self.postMessage({ type: 'error', nonce, message: String(err && err.stack || err) });
  }
};
