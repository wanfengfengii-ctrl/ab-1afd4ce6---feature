# 扫描向量浪涌约束 · 闭环加载顺序全局裁决

芯片量产测试时，多个扫描向量若按文件顺序加载，瞬间同时置高的引脚可能越过电源浪涌限额。
本工具在页面中录入/导入 **向量、每个引脚的整数浪涌权重、浪涌限额**，**完整比较全部
n! 条闭环顺序**，生成可执行的加载顺序并逐跳展示明细。纯静态站点，无后端、无外部依赖。

## 问题模型

- 向量数量 `4 ≤ n ≤ 12`，所有向量使用同一 `8–20` 位二进制掩码（自左向右为 `P1 … Pk`）；
- 设备从 **全零安全态** 出发，每个向量恰好执行一次，最后 **回到全零态**；
- 一跳的浪涌 = 该跳中 **由 0 变 1** 的引脚权重之和（1→0 不计浪涌，保持 1 不重复计费），
  要求每一跳浪涌 `≤ 限额`；
- 裁决规则（两级，全局）：
  1. 先取 **全程翻转位数**（0→1 与 1→0 都算翻转，含收尾回零跳）最小的闭环顺序；
  2. 翻转位数并列时，取 **向量编号序列字典序**（编号字符串码点序，故 `10 < 2`）最小者；
- **禁止以逐跳最小翻转（贪心）替代全局裁决。**

## 算法：子集动态规划（精确等价于 n! 全排列穷举）

状态 `dp[S][i]` = 已访问集合 `S`、末向量为 `i` 时的最优前缀（翻转位数、编号字典序），
并单独累计到达每个状态的可行前缀数量。浪涌只依赖“上一个向量的掩码”，与更早历史无关，
因此被支配前缀的剪枝不影响最优性：

- 边代价非负且可加：翻转更多的前缀不可能反超；
- 续接序列只取决于末向量：字典序更小的前缀延长后仍然更小。

状态规模 `2^n × n`，n=12 时约 4.9 万，可在数百毫秒内完整裁决；
页面同时汇报 **闭环顺序总数 n!** 与 **满足逐跳浪涌约束的顺序数**（BigInt 精确计数）。
测试中另用一份完全独立的 n! 暴力枚举（300 组随机用例）对拍可行性、可行数、最优翻转与字典序。

## 页面功能

- 掩码位数、限额、每个引脚权重、各向量编号/掩码的表格录入；
- 文本导入/导出（`PINS` / `LIMIT` / `W`(或 `WEIGHTS`) / `编号 掩码`，支持 `#` 注释），
  导入错误按 **源文件行号** 定位；录入错误定位到具体向量行/引脚；
- 点击「执行全局裁决」在 Web Worker 中计算，逐跳展示
  **前掩码、后掩码、置高引脚（0→1，含权重）、浪涌/限额、本跳翻转、累计翻转**；
- 无解时完整比较后明确告知，并给出卡点诊断（哪些向量首跳即超限、哪些没有任何可行入边）；
- **任一编辑立刻撤下旧结论**：顶部出现「输入已变更」提示，在途的计算结果自动作废。

## 本地运行（无需 Docker）

任意静态服务器即可，例如：

```bash
npx serve .                # 或：python3 -m http.server 8080
# 打开 http://localhost:8080
```

## Docker / Docker Compose

```bash
# 构建并启动（宿主机端口可用 WEB_PORT 配置，默认 8080）
WEB_PORT=9090 docker compose up --build -d
# 健康检查：容器内 wget /healthz；编排据 healthcheck 判定 web 健康
curl http://localhost:9090/healthz      # -> ok

# verify 服务：代码测试 + 构建检查 + HTTP 冒烟，自行退出，退出码即结论
docker compose run --rm verify

# 一条命令：起站、跑 verify、verify 结束后整体退出并透传其退出码
docker compose up --build --abort-on-container-exit --exit-code-from verify
```

`verify` 服务依次执行：

1. `node --test test/solver.test.mjs` —— 单元测试 + 300 组暴力对拍 + n=12 规模 + 反贪费用例；
2. `node scripts/build-check.mjs` —— 文件齐备性、JS 语法检查、资源引用、端到端求解；
3. `BASE_URL=http://web:80 node test/smoke.mjs` —— 针对运行中容器的 HTTP 冒烟（9 项）。

全部通过退出码 `0`，任一失败非 `0`。

## 不使用 Docker 时的校验命令

```bash
node --test test/solver.test.mjs   # 代码测试（需 Node >= 20）
node scripts/build-check.mjs       # 构建检查
BASE_URL=http://localhost:8080 node test/smoke.mjs
node scripts/find-greedy-trap.mjs  # 重新搜索“贪心 != 全局最优”的固化用例
```

## 导入文件格式

```
# 注释
PINS 8
LIMIT 6
W 2 1 3 1 2 1 1 1        # P1..P8 的浪涌权重（也可写作 WEIGHTS）
V1 00101010
V2 11000001
V3 01010001
V4 10000100
```

## 目录结构

```
index.html              静态页面
css/style.css           样式
js/solver.js            校验 / 导入解析 / 子集 DP 全局裁决 / 无解诊断（无 DOM 依赖）
js/worker.js            Web Worker 包装
js/app.js               页面交互、编辑即撤结论、逐步明细渲染
test/solver.test.mjs    单元/对拍测试（含独立 n! 暴力实现）
test/smoke.mjs          HTTP 冒烟
scripts/build-check.mjs 构建检查
scripts/find-greedy-trap.mjs
Dockerfile              nginx:alpine 静态镜像（含 /healthz 与 HEALTHCHECK）
nginx.conf              站点配置
docker-compose.yml      web（端口可配 + 健康检查）与 verify（一次性，退出码给结论）
```
