/**
 * build-check.mjs —— 静态站点构建检查（无外部依赖）：
 *   1. 关键文件存在；
 *   2. 全部 JS 通过语法检查（node --check，等价构建期解析）；
 *   3. index.html 引用的本地 css/js 资源均存在，且没有未替换的模板占位；
 *   4. 核心模块在 Node 下可直接求解（端到端冒烟一次）。
 * 任一失败以非零退出码结束。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { solveModel } from '../js/solver.js';

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
  'test/solver.test.mjs', 'test/smoke.mjs', 'scripts/build-check.mjs']) {
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
  for (const id of ['btn-solve', 'steps-body', 'stale-banner', 'weights-grid']) {
    if (!html.includes(`id="${id}"`)) failures.push(`index.html 缺少关键节点 #${id}`);
  }
}

// 4. 核心求解端到端
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
if (!result.ok || !result.feasible) failures.push('核心模块端到端求解失败');
if (result.feasible && result.totalFlips !== 16) {
  failures.push(`核心模块端到端结果异常：totalFlips=${result.totalFlips}，期望 16`);
}

if (failures.length > 0) {
  console.error('构建检查失败：');
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log(`构建检查通过：${required.length} 个关键文件、JS 语法、资源引用、端到端求解均正常`);
