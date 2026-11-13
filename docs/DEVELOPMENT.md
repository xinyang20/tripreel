# 开发说明

本项目默认在本机运行：Node.js HTTP 服务负责静态资源和固定来源查询，浏览器原生 JavaScript ES modules 负责界面、IndexedDB 存储、地图及视频。受限公开模式通过反向代理提供 HTTPS，仍使用同一浏览器存储结构。没有 React、Vite、TypeScript 或独立前端编译流程。用户使用说明见 [README](../README.md)，修改前阅读 [协作规则](../AGENTS.md)。

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

受限公开模式使用 `TRIPREEL_PUBLIC_ORIGIN=https://tripreel.xinyang20.cn` 和 `TRIPREEL_RAILGO=disabled`，不改变监听地址。公开来源用于限定允许的 Host/Origin；不能通过任意 `X-Forwarded-Host` 或用户请求动态扩大允许列表。反向代理需保留公开 Host 与浏览器 Origin，服务端强制禁止全部 RailGo 在线轨道及主数据分支。默认读取 OSM 本地白名单，未覆盖时使用允许的 12306 停站示意，不回退 RailGo。环境变量变更后需重启进程，完整配置见 [部署说明](DEPLOYMENT.md)。

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

未标路径的前端模块位于 `dist/`，服务端和维护脚本另行注明：

| 模块                                                       | 职责                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `app.js` / `index.html` / `styles.css`                     | 页面初始化、行程列表、交互和可选 WebMCP 工具                 |
| `controls.css`                                             | 原生表单控件、选中标识、焦点和展开菜单的共享样式             |
| `domain.js` / `repository.js` / `store.js`                 | 统一实际日期与行程身份、记录可用性、事务存储、迁移和页面状态 |
| `editor*.js` / `batch-*.js`                                | 单段及批量会话、草稿、匹配、字段来源与主线／候选确认         |
| `draft-validation.js`                                      | 恢复及继续草稿前的结构校验，允许未完成输入                   |
| `selectors.js` / `library-ui.js`                           | 统一筛选范围、旅程、备份预览及详情                           |
| `routes.js`                                                | 后台线路刷新及版本保护，不修改用户时刻                       |
| `rail-providers.js`                                        | 来源能力、默认／临时选择、版本及草稿查询缓存约束             |
| `performance.js`                                           | 显式启用的有界分段计时                                       |
| `html.js`                                                  | 默认转义的界面标记模板 `safe`、可信片段 `raw` 和 `esc`       |
| `map*.js` / `camera-fit.js` / `replay.js`                  | 共享几何、地名、取景、自由视角、已行驶路线和回放节奏         |
| `vehicles.js`                                              | 三维列车和飞机模型、姿态计算与绘制                           |
| `video-options.js` / `video-export.js` / `video-layout.js` | 导出范围、预算、隐私呈现、编码、遮挡避让与资源释放           |
| `server.mjs` / `scripts/request-scheduler.mjs`             | 固定来源查询、预算、共享请求、取消、缓存及队列               |
| `scripts/rail-*.mjs` / `scripts/train-reference.mjs`       | 铁路几何与区间校验、停站示意及参考日期                       |
| `scripts/import-rail-osm.mjs` / `scripts/rail-data/`       | OSM 原始关系、独立证据清单与显式离线导入                     |

`controls.css` 在布局样式之后加载，覆盖静态及动态生成的原生控件。下拉框用 `appearance: base-select` 渐进增强展开菜单与选中标识，保留浏览器的键盘、表单及可访问性语义；不支持此能力的浏览器保留统一的闭合外观和系统选项菜单，参见 [MDN 可定制下拉框](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Customizable_select)。日期、时间、地点建议和视频播放仍使用浏览器原有交互。维护时同时检查禁用、错误、键盘焦点、窄屏及强制颜色模式，基础输入样式用低特异性选择器，避免覆盖状态反馈。

`styles.css` 开头的 `:root` 定义表面、边框、文字、操作、飞行、状态颜色和字号、圆角、阴影变量，`controls.css` 引用同一套变量。文件按基础元素、通用组件、顶栏、行程列表与卡片、地图、回放、弹窗、编辑器、批量录入、数据与详情、视频、线路更新提示分段，响应式规则集中在末尾的 1500px、1050px、760px 三个媒体查询中。中文文字不小于 12px，说明文字使用 `--muted` 或更深的颜色。地图取景和地名避让读取标题、工具栏、回放栏和图例的实际位置，调整这些元素的布局后需复核取景。

回放节奏由 `replay.js` 计算：有完整线路的列车按时刻表在已匹配线路的经停站停留，进出站按加减速曲线行驶；未匹配、缺时刻或时序错乱的经停站被忽略，不切断线路也不推断停站。飞机在起降段加减速。`tripPosition` 返回 `track`（线路索引和已行驶公里数）或 `arc`（弧线与已飞比例）。`vehicles.js` 据此生成六节车厢沿线路排列的列车和按航向、爬升角摆放的飞机，低缩放时按屏幕最小尺寸放大并加宽车身，放大到真实尺寸后恢复比例；模型以米为单位、相对载具位置绘制，深度范围围绕载具重新分配，几何沿 y 轴镜像以抵消地图投影的镜像。`map-scene.js` 的 `setReplayFrame` 把同一帧交给主地图和视频地图，并用 `line-gradient` 与加粗弧线显示已行驶部分；`#map` 的 `data-vehicle`、`data-travelled` 仅供回归检查。

提示信息 `#toast` 是 `popover="manual"` 元素，每次显示都重新进入浏览器顶层，弹窗打开时仍可见；不支持 popover 的浏览器只切换隐藏样式。触屏设备在页面内启用 MapLibre `cooperativeGestures`，地图全屏时关闭；窄屏加载地图后收起紧凑版权栏。用 `innerHTML` 生成标记时使用 `html.js` 的 `safe` 模板，插值默认转义，嵌套的 `safe` 片段和数组不重复转义，`null`、`undefined`、`false` 不输出；需要比较或缓存的标记先转成字符串。

数据库仍使用 `travel-trace` v2，旧数据键 `travel-trace.v1` 和备份标识属于兼容性约定，不随品牌改名。正式记录、路线、草稿、分组和救援内容分别存储。所有页面存储操作经异步 `store.js` 调用，必须等待成功再关闭确认界面；并发版本检查在事务内执行。

`repository.subscribeCommits` 在提交成功后提供数据版本和受影响 ID，`readChanges` / `readTrips` 定向读取；store 按 ID 合并并复用未变记录与几何引用。通知乱序、版本缺口、旧格式或读取时版本已经前进时使用完整快照恢复。保存时仍在事务内以全部轻量身份和时间字段校验冲突，仅加载受影响记录的完整路线；首次读取仍包含全部历史，没有实现历史按需加载。`assignGroup` 使用仅元数据事务。默认来源由异步 `loadPreferences` / `savePreferences` 写入独立 meta 项，不提升行程数据版本或重绘地图。

轻量索引保存在 v2 的 `meta/trip-identities`，只包含身份、时间、分组等标量，随记录和 `datasetRevision` 原子提交。正常保存不读取其他记录的主线、历史或候选几何。旧 v2 库首次写入、旧页面写入造成的版本变化、索引缺失或损坏会在事务中重新建立索引；数据库版本及原有路线存储格式不变。

`rail-providers.js` 负责服务器能力约束与默认/临时来源选择；`performance.js` 仅在显式设置 `globalThis.__tripreelPerformance` 时记录有界分段耗时。列表按 ID 复用卡片，筛选状态立即更新、DOM 按帧合并；几何与时间线签名分开。筛选范围、记录顺序及示例／个人模式未变时，编号、时刻和分组等元信息更新保留回放进度；范围或排序变化仍重新开始。相机使用全点精确约束、完整投影检查和有界缓存；回放使用累计距离索引。视频在录制前准备全部镜头并分片让出主线程。

`prepareReadOnlyTrip` 建立可信的递归只读记录边界，视频快照可共享通过该边界的几何，只复制呈现所需字段；外部可变输入仍须复制，不携带完整历史或候选几何。仅检查 `Object.isFrozen()` 不足以判断记录已经通过此边界，应使用 `isReadOnlyTrip`。

主线确认和候选接受是独立状态；直接保存、只改时刻及恢复旧草稿不能静默接受新候选。行程身份使用实际日期，查询日期不能替代；旧记录中的日期矛盾保留并提示，不能阻止无关保存。绘制和取景共用完整路线几何，兼容合法旧版 `legs`，不连接未记录的行程间隙。

## 本机接口与请求控制

| 接口                    | 用途                                           | 服务端总预算   |
| ----------------------- | ---------------------------------------------- | -------------- |
| `GET /api/train`        | 列车停站与时刻查询，含允许的参考降级           | 75 秒          |
| `GET /api/flight`       | 单日期航班查询                                 | 20 秒          |
| `POST /api/route`       | 实际乘坐区间的路线解析                         | 75 秒          |
| `GET /api/diagnostics`  | 进程内聚合连接、队列及缓存状态                 | 不执行外部查询 |
| `GET /api/capabilities` | 部署模式、可选／默认来源、覆盖、版本及刷新能力 | 不执行外部查询 |

`createTravelServer(...)` 可注入模拟上游并监听临时端口，供测试使用；正常启动仍固定本机地址。请求保留 Host/Origin 校验和请求体限制，不接受任意上游 URL。公开模式的外层代理不得缓存 `/api/*`，也不把聚合诊断误当成用户个人数据同步接口。

线路返回通过 `resolution.state` 区分 `ready`、`needs-confirmation`、`unavailable`，待确认参考或示意同时带有 `requiresConfirmation`。错误保留可读 `error`、稳定 `code` 和 `retryable`，界面据此提示调整输入、重试或取消。

铁路 `POST /api/route` 的可选 `provider` 仅接受 `railgo | osm-local`；本机默认前者，公开默认后者。`/api/capabilities` 保留 `railgoEnabled`，另返回 `defaultRailProvider`、`railProviders`、覆盖与版本及来源级自动刷新能力。缓存隔离来源和数据版本。`routeProvider` 表示请求选择的通道，即使降级为 12306 示意也保留；实际归属及标签须结合 `routeSource` 和 `quality`，不能仅靠 provider 将示意标成 OSM 轨道。`routeDataVersion` 和 `routeEvidence` 随候选、历史、草稿及备份保存，旧记录缺少这些字段仍兼容。

草稿的 `providerDataVersion` 进入前端缓存键，同版本恢复保留接受，来源或版本变化清除缓存与候选授权并要求重查，显式 `dataVersion: null`（包括有效白名单到期）也会在重新读取能力后撤销 OSM 轨道候选，但能力未知或旧协议省略版本字段不触发撤销，也不改写正式旧主线的 `routeDataVersion`、几何与时刻。

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

可直接复用已安装的 Chrome 使用软件 WebGL：

```sh
TRAVEL_TEST_CHANNEL=chrome TRAVEL_TEST_SOFTWARE_GL=1 pnpm run test:browser
```

启用 `TRAVEL_TEST_SOFTWARE_GL=1` 时，已有锁定 Playwright 对应 Chromium 的环境可省略 `TRAVEL_TEST_CHANNEL`，让测试使用该 Chromium。默认不设置软件图形变量时仍使用 Chrome 默认图形后端，报告中的实际 renderer 才是判断依据。

只运行相关浏览器用例时直接调用已安装的 Playwright，参数示例：

```sh
pnpm exec playwright test tests/browser/journey.spec.mjs --grep '390px|桌面地图总览'
```

浏览器失败截图和 trace 写入 `output/playwright/results/`，HTML 报告位于 `playwright-report/`，均不提交到 Git。近五分钟长片不属于常规回归，可单独执行：

```sh
TRAVEL_VIDEO_LONG=1 pnpm exec playwright test tests/browser/video.spec.mjs --grep '@near-limit'
```

Safari 和 QuickTime 验收须使用真实应用，自动化 WebKit 或 Chrome 解码不能代替。视觉验证需区分桌面、390px 窄屏、全屏、2D/3D 和自由视角；视频需检查实际导出、预览、取消、格式回退和首尾画面。已有结果及未覆盖范围见 [验收记录](VALIDATION.md)，外部来源核实日期不因本地测试通过而更新。

性能基线使用临时回环端口、独立浏览器及合成的 1 千／1 万／15 万路线点和 500 段记录，结果写入 `output/performance-baseline.json`。与其他图形测试串行执行，记录浏览器及图形后端；软件渲染结果不能外推为用户硬件表现。方法、优化前后结果及剩余限制见 [性能记录](PERFORMANCE.md)。

OSM 轨道导入由 `scripts/import-rail-osm.mjs` 读取显式 `--osm`、`--manifest`、`--output`，检查原始关系版本、连续性、方向、站点投影、长度及证据有效期，成功后才替换输出。清单的 `sourceDate`、`checkedDate` 必须是实际取得/核实日期；不能用重建日期顺延白名单。输入、命令和 ODbL 归属见 [试点维护说明](../scripts/rail-data/NOTICE.md)。该流程不属于普通 build。

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
