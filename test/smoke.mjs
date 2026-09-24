/**
 * smoke.mjs —— HTTP 冒烟测试（针对运行中的静态站点）。
 * BASE_URL 环境变量指定被测地址：
 *   - 本地：  BASE_URL=http://localhost:8080 node test/smoke.mjs
 *   - Compose：BASE_URL=http://web:80（由 verify 服务注入）
 * 退出码 0 全部通过，非 0 表示冒烟失败。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

async function get(path) {
  const res = await fetch(BASE + path, { redirect: 'manual' });
  return res;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

console.log(`HTTP 冒烟目标：${BASE}`);

await check('首页 GET / 返回 200 且包含关键节点', async () => {
  const res = await get('/');
  assert(res.status === 200, `状态码 ${res.status}`);
  assert(/text\/html/.test(res.headers.get('content-type') || ''), 'content-type 非 text/html');
  const html = await res.text();
  for (const token of ['<!DOCTYPE html>', 'id="btn-solve"', 'id="steps-body"',
    'js/app.js', 'css/style.css']) {
    assert(html.includes(token), `首页缺少 ${token}`);
  }
});

await check('首页包含缓变加载模式切换、置高上限录入与两套缓变结论容器', async () => {
  const res = await get('/');
  const html = await res.text();
  for (const token of ['name="mode"', 'value="ramp"', 'id="max-rise-pins"',
    'id="result-ramp-feasible"', 'id="result-ramp-infeasible"', 'id="ramp-jumps"']) {
    assert(html.includes(token), `首页缺少缓变模式节点 ${token}`);
  }
});

await check('闭环裁决关键节点（steps-body / 无解诊断）仍然保留', async () => {
  const res = await get('/');
  const html = await res.text();
  for (const token of ['id="result-feasible"', 'id="result-infeasible"', 'id="inf-diagnosis"']) {
    assert(html.includes(token), `首页缺少原有闭环节点 ${token}`);
  }
});

await check('app.js 中加载了后台 Worker（js/worker.js）', async () => {
  const res = await get('/js/app.js');
  const js = await res.text();
  assert(/worker\.js/.test(js), 'app.js 未引用 worker.js');
});

await check('worker.js 同时分发闭环裁决与缓变加载两种模式', async () => {
  const res = await get('/js/worker.js');
  const js = await res.text();
  assert(/solveRamping/.test(js), 'worker.js 未接入缓变加载 solveRamping');
  assert(/solveModel/.test(js), 'worker.js 丢失原有闭环 solveModel');
});

await check('健康检查端点 /healthz 返回 200 ok', async () => {
  const res = await get('/healthz');
  assert(res.status === 200, `状态码 ${res.status}`);
  const body = (await res.text()).trim();
  assert(body === 'ok', `响应体为 "${body}"，期望 ok`);
});

await check('样式表可访问且 MIME 为 text/css', async () => {
  const res = await get('/css/style.css');
  assert(res.status === 200, `状态码 ${res.status}`);
  assert(/text\/css/.test(res.headers.get('content-type') || ''),
    `content-type=${res.headers.get('content-type')}`);
});

const served = [];
for (const path of ['/js/solver.js', '/js/app.js', '/js/worker.js']) {
  await check(`脚本 ${path} 可访问且为 JS MIME`, async () => {
    const res = await get(path);
    assert(res.status === 200, `状态码 ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    assert(/javascript/.test(ct), `content-type=${ct}（模块 Worker 需要 JS MIME）`);
    served.push([path, await res.text()]);
  });
}

await check('容器内提供的 js/solver.js 与测试所测源码逐字节一致', async () => {
  const entry = served.find(([p]) => p === '/js/solver.js');
  assert(entry, '未取到 /js/solver.js');
  const local = readFileSync(join(root, 'js/solver.js'), 'utf8');
  assert(entry[1] === local, '服务端文件与仓库源码不一致');
});

await check('不存在的路径返回 404（无通配回落到 200）', async () => {
  const res = await get('/definitely-missing-' + Date.now());
  assert(res.status === 404, `状态码 ${res.status}`);
});

console.log(`\n冒烟结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length > 0) {
  console.error('失败项：');
  failures.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('HTTP 冒烟全部通过');
