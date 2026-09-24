/**
 * build-check.mjs —— 静态站点构建检查（无外部依赖）：
 *   1. 关键文件存在；
 *   2. 全部 JS 通过语法检查（node --check，等价构建期解析）；
 *   3. index.html 引用的本地 css/js 资源均存在，且没有未替换的模板占位；
 *   4. 核心模块在 Node 下可直接求解（两种模式各端到端冒烟一次）。
 * 任一失败以非零退出码结束。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solveModel, solveRamping } from '../js/solver.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const required = [
  'index.html',
  'css/style.css',
  'js/solver.js',
  'js/app.js',
  'js/worker.js',
  'Dockerfile',
  'docker-compose.yml',
  'nginx.conf',
];

for (const rel of required) {
  if (!existsSync(join(root, rel))) failures.push(`缺少文件：${rel}`);
}

// 2. JS 语法检查
for (const rel of ['js/solver.js', 'js/app.js', 'js/worker.js',
  'test/solver.test.mjs', 'test/ramping.test.mjs', 'test/smoke.mjs', 'scripts/build-check.mjs']) {
  const file = join(root, rel);
  if (!existsSync(file)) continue;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures.push(`语法检查失败 ${rel}: ${String(err.stderr || err.message).trim()}`);
  }
}

// 3. index.html 资源引用
if (existsSync(join(root, 'index.html'))) {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^https?:\/\//.test(ref) || ref.startsWith('data:')) continue;
    const target = join(root, ref.replace(/^\.?\//, ''));
    if (!existsSync(target)) failures.push(`index.html 引用了不存在的资源：${ref}`);
  }
  for (const marker of ['{{', '}}', 'undefined', 'TODO']) {
    if (html.includes(marker)) failures.push(`index.html 含未处理标记：${marker}`);
  }
  for (const id of ['btn-solve', 'steps-body', 'stale-banner', 'weights-grid',
    'max-rise-pins', 'ramp-jumps', 'result-ramp-feasible']) {
    if (!html.includes(`id="${id}"`)) failures.push(`index.html 缺少关键节点 #${id}`);
  }
}

// 4a. 闭环模式核心求解端到端（原有裁决回归）
const sample = {
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
const result = solveModel(sample);
if (!result.ok || !result.feasible) failures.push('闭环模式端到端求解失败');
if (result.feasible && result.totalFlips !== 16) {
  failures.push(`闭环模式端到端结果异常：totalFlips=${result.totalFlips}，期望 16`);
}

// 4b. 缓变模式端到端：录入顺序固定、采样掩码不变、暂态链完整
const rampSample = {
  pinCount: 8,
  limit: 3,
  maxRisePins: 1,
  weights: [1, 1, 1, 1, 1, 1, 1, 1],
  vectors: [
    { id: 'A', bits: '11000000' }, // 0 -> A：升 P1,P2，cap=1 → 2 个置高暂态，无降位
    { id: 'B', bits: '01100000' }, // 降 P1（1 暂态），升 P3（1 暂态）
    { id: 'C', bits: '01110000' }, // 升 P4（1 暂态）
    { id: 'D', bits: '00000000' }, // 降 P2,P3,P4（1 暂态）
  ],
};
const ramp = solveRamping(rampSample);
if (!ramp.ok || !ramp.feasible) failures.push('缓变模式端到端求解失败');
if (ramp.feasible) {
  if (ramp.totalGroups !== 4) failures.push(`缓变模式置高组数异常：${ramp.totalGroups}，期望 4`);
  if (ramp.totalTransients !== 6) failures.push(`缓变模式暂态总数异常：${ramp.totalTransients}，期望 6`);
  if (JSON.stringify(ramp.order) !== JSON.stringify(['A', 'B', 'C', 'D'])) {
    failures.push('缓变模式必须严格按录入顺序执行');
  }
  // 每个正式采样点掩码 = 向量原掩码
  ramp.jumps.forEach((j, i) => {
    if (j.targetBits !== rampSample.vectors[i].bits) {
      failures.push(`缓变模式第 ${i + 1} 跳采样掩码偏离原向量掩码`);
    }
    // 每组不越浪涌、不超引脚上限
    j.stages.filter((s) => s.kind === 'rise').forEach((s) => {
      if (s.surge > 3 || s.count > 1) failures.push(`缓变模式置高组越界：${JSON.stringify(s)}`);
    });
  });
  if (ramp.returnJump.targetBits !== '00000000' || ramp.returnJump.stages.length !== 0) {
    failures.push('缓变模式回零跳异常（末向量已为全零，不应有暂态）');
  }
}

// 4c. 缓变失败原因定位：超重引脚 + 录入行号
const rampBad = {
  pinCount: 8,
  limit: 3,
  maxRisePins: 2,
  weights: [5, 1, 1, 1, 1, 1, 1, 1],
  vectors: [
    { id: 'A', bits: '01000000' },
    { id: 'B', bits: '11000000' }, // B 需要置高 P1（w=5 > 3）
    { id: 'C', bits: '01000000' },
    { id: 'D', bits: '00000000' },
  ],
};
const rampFail = solveRamping(rampBad);
if (rampFail.ok !== true || rampFail.feasible !== false) {
  failures.push('缓变模式应在超重引脚时判失败');
} else if (rampFail.failures.length !== 1 || rampFail.failures[0].vectorId !== 'B'
  || rampFail.failures[0].reason !== 'overweight'
  || JSON.stringify(rampFail.failures[0].overloadPins) !== JSON.stringify([{ pin: 'P1', weight: 5 }])) {
  failures.push(`缓变模式失败定位异常：${JSON.stringify(rampFail.failures)}`);
}

if (failures.length > 0) {
  console.error('构建检查失败：');
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`构建检查通过：${required.length} 个关键文件、JS 语法、资源引用、两种模式端到端求解均正常`);
