# 开发说明

本项目保持本机应用结构：Node.js HTTP 服务负责静态资源和固定来源查询，浏览器原生 JavaScript ES modules 负责界面、IndexedDB 存储、地图及视频。没有 React、Vite、TypeScript 或独立前端编译流程。用户使用说明见 [README](../README.md)，修改前阅读 [协作规则](../AGENTS.md)。

## 环境与日常命令

要求 Node.js `>=22`，包管理器锁定为 `pnpm@10.32.1`。先检查 `package.json`、`pnpm-lock.yaml` 和现有 `node_modules/`，复用环境；项目不需要 Python。所有命令在仓库根目录执行。

| 任务                   | 命令                                        |
| ---------------------- | ------------------------------------------- |
| 首次安装或恢复锁定依赖 | `pnpm install --frozen-lockfile`            |
| 准备浏览器运行库       | `pnpm run build`                            |
| 启动本机服务           | `pnpm run start`                            |
| 开发启动               | `pnpm run dev`，与 `start` 相同，无自动重启 |
| Node 测试              | `pnpm run test`                             |
| ESLint 和格式检查      | `pnpm run check`                            |
| 隔离浏览器回归         | `pnpm run test:browser`                     |
| 合成性能基线           | `pnpm run benchmark`                        |

**`dist/` 是前端源码目录，不是可清空的构建产物。** 构建脚本只从已安装依赖复制 MapLibre/Three 运行库到 `dist/vendor/` 并检查少量入口，不编译前端，也不重建地点数据。

服务固定监听 `127.0.0.1:4173`，没有地址或端口环境变量。修改浏览器模块后刷新即可；修改 `server.mjs` 或其导入的共享模块后需要重启。在启动终端按 `Ctrl+C` 停止。开发验证不应占用或改写用户正在使用的页面和浏览器数据。

## 目录与模块

```text
tripreel/
├── README.md                 用户使用说明
├── LICENSE                   项目自有代码的 MIT 许可
├── AGENTS.md                 开发与代理协作规则
├── docs/                     开发、数据来源、验收及仓库说明
├── licenses/                 第三方许可
├── dist/                     前端源码和公开运行数据
├── scripts/                  构建、数据整理、查询及性能工具
├── tests/                    Node 与隔离浏览器回归
├── server.mjs                本机 HTTP 服务
├── package.json              命令与运行环境要求
├── pnpm-lock.yaml            依赖锁文件
└── 启动途映.command          macOS 启动入口
```

下表中的前端模块均位于 `dist/`：

| 模块                                                       | 职责                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `app.js` / `index.html` / `styles.css`                     | 页面初始化、行程列表、交互和可选 WebMCP 工具                 |
| `domain.js` / `repository.js` / `store.js`                 | 统一实际日期与行程身份、记录可用性、事务存储、迁移和页面状态 |
| `editor*.js` / `batch-*.js`                                | 单段及批量会话、草稿、匹配、字段来源与主线／候选确认         |
| `draft-validation.js`                                      | 恢复及继续草稿前的结构校验，允许未完成输入                   |
| `selectors.js` / `library-ui.js`                           | 统一筛选范围、旅程、备份预览及详情                           |
| `routes.js`                                                | 后台线路刷新及版本保护，不修改用户时刻                       |
| `map*.js` / `camera-fit.js` / `replay.js`                  | 共享几何、地名、取景、自由视角和回放                         |
| `video-options.js` / `video-export.js` / `video-layout.js` | 导出范围、预算、隐私呈现、编码、遮挡避让与资源释放           |
| `server.mjs` / `scripts/request-scheduler.mjs`             | 固定来源查询、预算、共享请求、取消、缓存及队列               |
| `scripts/rail-*.mjs` / `scripts/train-reference.mjs`       | 铁路几何与区间校验、停站示意及参考日期                       |

数据库仍使用 `travel-trace` v2，旧数据键 `travel-trace.v1` 和备份标识属于兼容性约定，不随品牌改名。正式记录、路线、草稿、分组和救援内容分别存储。所有页面存储操作经异步 `store.js` 调用，必须等待成功再关闭确认界面；并发版本检查在事务内执行。

主线确认和候选接受是独立状态；直接保存、只改时刻及恢复旧草稿不能静默接受新候选。行程身份使用实际日期，查询日期不能替代；旧记录中的日期矛盾保留并提示，不能阻止无关保存。绘制和取景共用完整路线几何，兼容合法旧版 `legs`，不连接未记录的行程间隙。

## 本机接口与请求控制

| 接口                   | 用途                                 | 服务端总预算   |
| ---------------------- | ------------------------------------ | -------------- |
| `GET /api/train`       | 列车停站与时刻查询，含允许的参考降级 | 75 秒          |
| `GET /api/flight`      | 单日期航班查询                       | 20 秒          |
| `POST /api/route`      | 实际乘坐区间的路线解析               | 75 秒          |
| `GET /api/diagnostics` | 进程内聚合连接、队列及缓存状态       | 不执行外部查询 |

`createTravelServer(...)` 可注入模拟上游并监听临时端口，供测试使用；正常启动仍固定本机地址。请求保留 Host/Origin 校验和请求体限制，不接受任意上游 URL。

线路返回通过 `resolution.state` 区分 `ready`、`needs-confirmation`、`unavailable`，待确认示意同时带有 `requiresConfirmation`。错误保留可读 `error`、稳定 `code` 和 `retryable`，界面据此提示调整输入、重试或取消。

预算包含排队、查询和回退，单次上游请求最多 18 秒；客户端通过 `X-Travel-Budget-Ms` 传递剩余预算，不能提高服务端上限。客户端普通列车／路线请求为 80 秒、航班为 25 秒，并受父级期限约束。单行完整匹配最多 150 秒，一批最多五分钟；取消或总期限到达后不再启动回退。

成功结果经过校验后才进入缓存：列车 1 小时、航班 15 分钟、RailGo 6 小时。RailGo 串行请求、间隔至少约 1.2 秒、最多 24 个等待项。相同查询共享请求，只有全部订阅取消才终止共用上游；`X-Travel-Priority: background` 让后台刷新低于主动查询。空结果和异常结果不能作为成功结果长期缓存。

诊断状态只表示连接与解析状态，不保证某段轨道完整或某日存在班次；不返回个人行程或查询明细。接口来源、字段语义和授权边界见 [数据来源](SOURCES.md)。

## 本地验证

当前不配置 GitHub Actions CI。业务逻辑变更先运行相关测试，再执行：

```sh
pnpm run test
pnpm run build
pnpm run check
```

交互、地图或视频变更还需运行浏览器回归：

```sh
pnpm run test:browser
```

Node 测试使用本地夹具、`fake-indexeddb`、模拟上游和临时回环端口，不依赖真实来源当天可用性。浏览器回归默认使用已安装的 Chrome，由 Playwright 启动 `scripts/browser-server.mjs`，固定在 `127.0.0.1:43717` 使用合成数据和隔离上下文。测试结束自动关闭测试服务；不能复用用户的 4173 页面或真实记录。

若使用软件 WebGL，先准备锁定 Playwright 版本对应的 Chromium，再运行：

```sh
pnpm exec playwright install chromium
TRAVEL_TEST_SOFTWARE_GL=1 pnpm run test:browser
```

浏览器失败截图和 trace 写入 `output/playwright/results/`，HTML 报告位于 `playwright-report/`，均不提交到 Git。近五分钟长片不属于常规回归，可单独执行：

```sh
TRAVEL_VIDEO_LONG=1 pnpm exec playwright test tests/browser/video.spec.mjs --grep '@near-limit'
```

Safari 和 QuickTime 验收须使用真实应用，自动化 WebKit 或 Chrome 解码不能代替。视觉验证需区分桌面、390px 窄屏、全屏、2D/3D 和自由视角；视频需检查实际导出、预览、取消、格式回退和首尾画面。已有结果及未覆盖范围见 [验收记录](VALIDATION.md)，外部来源核实日期不因本地测试通过而更新。

性能基线使用临时回环端口、独立浏览器及合成的 1 千／1 万／15 万路线点和 500 段记录，结果写入 `output/performance-baseline.json`。与其他图形测试串行执行，记录浏览器及图形后端；软件渲染结果不能外推为用户硬件表现。方法和已有瓶颈见 [性能基线](PERFORMANCE.md)。

文档或低影响样式变更只做相应检查，不新增重复测试。只格式化自己修改的文件，例如：

```sh
pnpm exec prettier --write README.md docs/DEVELOPMENT.md
```

`pnpm run format` 会处理整个项目的受管范围，仅在明确需要全量格式化时使用，避免改写并行工作。第三方运行库、大型数据文件及本地输出由现有忽略规则排除。

## 数据更新与提交

普通安装、构建和测试不生成真实地点数据。更新资料前确认原始来源、坐标系、许可和实际取得日期，再显式提供输入：

```sh
pnpm exec node scripts/prepare-data.mjs --stations /path/to/rail-stations.csv --station-names /path/to/station_name.js --airports /path/to/airport-codes.csv --source-date YYYY-MM-DD
```

脚本先完整校验，再一起发布，失败保留原数据；`--output-dir` 可指定输出目录。它不能独立重建全部数据，不自行联网获取输入。`scripts/make-demo.mjs` 会请求运行中的本机服务并覆盖公共示例，仅在有意更新示例时执行，不能写入个人行程。

提交前核对文件范围，不包含个人记录、备份、视频、浏览器配置、依赖目录及旧仓库历史；保留锁文件，避免无关依赖升级。使用步骤变更同步 README，模块职责变更同步 AGENTS，数据来源或授权变更同步 SOURCES。仓库内容及许可边界见 [仓库说明](GITHUB.md)。
