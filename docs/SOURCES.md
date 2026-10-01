# 数据来源与使用边界

以下数据来源在 2026-09-21 进行过访问或数据核对。2026-10-01 重新核对了 [RailGo API 文档](https://api.railgo.dev/) 的访问条款，用于确定公开部署时禁用其在线接口，并执行了一次 12306 查询连通性检查，结果见 [验收记录](VALIDATION.md)。没有全面重新核验班次、轨道、地点数据或其他来源，原数据核实日期不因此顺延。公开网页内部接口不等于有稳定性承诺的开发者 API；网站明确保留查询失败和人工核对流程。

项目自有代码采用根目录的 [MIT License](../LICENSE)。本页列出的第三方代码、依赖、数据和在线服务分别遵循其原有许可、归属与访问条件，不因项目采用 MIT 而改变。特别是 [RailGo 坐标转换代码的原许可](../licenses/RAILGO-LICENSE.txt) 应保留，代码许可与 RailGo 在线接口的访问条件分别处理。

| 内容                     | 来源                                                                                                                               | 本项目使用方式                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 列车编号、停站、计划时刻 | [中国铁路 12306](https://www.12306.cn/)                                                                                            | 使用公开网页的车次搜索与停站查询，不登录、不查询乘客信息                                             |
| 航班机场、计划时刻、状态 | [航旅纵横公开航班查询](https://www.umetrip.com/weixin/aliPay/flightSearch.html)                                                    | 使用该页面实际调用的匿名航班号查询，不需要账户、密钥或 Cookie                                        |
| 车次线路坐标             | [RailGo](https://railgo.dev/) · [API 文档](https://api.railgo.dev/)                                                                | 仅本机默认模式使用 `mapLine`，串行请求、缓存 6 小时并保留来源；受限公开模式禁用所有 RailGo 在线接口  |
| 中文铁路站点坐标         | [chinese-railway-gtfs](https://github.com/wensimehrp/chinese-railway-gtfs)                                                         | 中文站名全等匹配，不以拼音猜测；来自 OSM 的 WGS84 坐标                                               |
| 车站电报码与同城分组     | [12306 公开站名文件](https://kyfw.12306.cn/otn/resources/js/framework/station_name.js)                                             | 中文站名、电报码、城市名及城市分组，用于停站查询和地图标签合并；不同城市同名站不会仅因名字相同被合并 |
| 机场位置                 | [OurAirports](https://ourairports.com/data/) · [CSV 镜像](https://github.com/datasets/airport-codes)                               | 公共领域数据，中国大陆机场按 IATA/ICAO 匹配                                                          |
| 国家几何底图             | [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) · [GeoJSON](https://github.com/nvkelso/natural-earth-vector) | 公共领域，随项目提供本地简约底图                                                                     |
| 铁路背景                 | [railroute-ts](https://github.com/mayurrawte/railroutes) / `@railroute-ts/china`                                                   | OpenStreetMap 铁路数据，仅作淡色背景，不用于自动选择乘坐路线                                         |
| 可选在线精细地图         | [OpenFreeMap](https://openfreemap.org/)                                                                                            | 无 Key，用户主动切换；提供 OSM 归属                                                                  |

## 查询接口

服务端只允许固定的上游来源，不接受任意代理 URL。

下列清单包含本机版可用的全部来源。受限公开模式不会请求 RailGo 的 `mapLine` 或 `getTrainMain`，列车线路仅从 12306 有序停站或手动途经点生成待确认示意；也不会调用依赖 RailGo 的同线区间回退。已有备份中的线路与来源继续按原格式读取，禁用在线接口不重写既有记录。

```text
GET https://search.12306.cn/search/v1/train/search?keyword={车次}&date={YYYYMMDD}
GET https://kyfw.12306.cn/otn/czxx/queryByTrainNo?train_no={查询结果内部编号}&from_station_telecode={始发电报码}&to_station_telecode={终到电报码}&depart_date={YYYY-MM-DD}
GET https://www.umetrip.com/gateway/api/web/flightstatus/getflightstatusbyflightno?flightNo={航班号}&flightDate={YYYY-MM-DD}&appid=&sessionId=&token=
GET https://rg-api.zenglingkun.cn/api/v2/mapLine?train={车次}
GET https://rg-api.zenglingkun.cn/api/v2/getTrainMain?trainNum={车次}
```

航旅纵横的身份参数为空；需同时核对业务状态和非空航段列表，不能把 HTTP 200 当作查到航班。取消航班在表单和批量确认列表中明确提示，由用户核对实际行程后决定是否保存。机场、时刻以计划字段展示。

RailGo 的坐标采用 GCJ-02，本项目依据其官方 [坐标转换实现](https://github.com/RailGoApps/RailGo/blob/main/scripts/coord_transform.js) 转成 WGS84 后显示。该函数按 MIT 许可使用，原许可保留在项目中。车次线路无日期维度，默认采信最新可用线路，按最新线路中的起终站截取完整曲线。12306 时刻和停站差异保留为提示，不否决已有线路；未定位的中间站不会打断主曲线。

2026-09-21 实测 G813 和 G466 的 `mapLine` 返回成功但 `train` 为空，不能视为已取得线路。G813 天津南至南京南的六站与 G1/G814 的京沪高铁几何逐站核对，两份 RailGo 记录的该区间约 902.136 公里，最大偏差约 0.2 米；这属于同一来源的交叉核对，不是独立来源验证或历史当日轨迹。本地回退使用 G1 几何并实时核对 G813 最新主数据的该段停站和投影，标为“同线区间参考”。

通用停站示意回退已扩展到其他列车，不再只限 G466/G463。专用几何和已核对的同线区间都不可用时，按 RailGo 最新停站或 12306 查询得到的有序停站生成候选曲线；起终点必须匹配、方向正确，所选区间的全部站点必须有有效 WGS84 坐标，不能跳过缺坐标的站点。重复经过同名站时需选择具体站次，不能默认取第一个同名站。候选标记为“停站连线示意”，只有用户确认后才可参与地图回放和视频；手动途经点生成的曲线另标为“手动途经点示意”。这些曲线不是沿铁路路网计算的结果，不代表实际铁轨、行驶里程或当日调度。未经核实的 CNRail 坐标和出现明显绕行的全网最短路结果没有用于行程。

没有可靠停站或有效几何时，接口返回“待补全”，不编造路线。缺少准确时刻的记录也可以经用户确认保存，待补全记录不参与回放和视频。线路来源、参考时刻和异常提示分开保存；取得几何不等于同时核实了时刻和停站差异，也不能用低质量回退替换已保存的高质量路线。

所选日期的列车查询失败时，会查询今日同车次，返回明确标记的候选停靠站和参考时刻。实际乘车日期、列车始发查询日期、参考数据日期分别保存，日期和时刻统一按北京时间处理。线路默认采用最新可用车次线路，用户请求日期与参考时刻仍单独标注，不会被误标为远期时刻已核对。用户取消或查询总预算耗尽时直接结束，不继续触发今日参考查询。

## 请求预算与取消

本机服务继续提供 `/api/train`、`/api/flight`、`/api/route`，不建立后台任务系统。下面的预算从请求开始计时，包含读取请求体、排队和上游查询；单次上游请求另有 18 秒限制，包含响应解析。

| 本机接口      | 总等待上限 |
| ------------- | ---------- |
| `/api/train`  | 75 秒      |
| `/api/flight` | 20 秒      |
| `/api/route`  | 75 秒      |

客户端可用 `X-Travel-Budget-Ms` 缩短剩余预算，不能提高服务端上限。结构化错误保留可读的 `error` 文案，并提供 `code`、`retryable`，让界面区分需调整输入、可重试和已取消。路线返回另有 `resolution.state`：`ready`、`needs-confirmation` 或 `unavailable`；有待确认的示意候选同时提供 `requiresConfirmation`。

相同查询共享进行中的请求，成功校验后再缓存：列车 1 小时、航班 15 分钟、RailGo 6 小时。失败和取消结果不缓存。RailGo 请求串行执行，启动间隔至少 1.2 秒，最多排队 24 项；前台查询优先于后台线路刷新，不抢占已经开始的上游请求。`X-Travel-Priority: background` 用于后台刷新。

关闭表单、停止匹配或连接断开会取消该调用者的订阅。仍有其他调用者等待同一请求时，共用上游请求继续；最后一个订阅取消后，移除尚未执行的队列项，并中断正在执行的上游请求。总预算到期遵循同样规则，避免一次取消影响另一段仍在匹配的行程。

## 本机诊断

`GET /api/diagnostics` 返回本次服务进程的聚合状态：各来源的最近成功时间、最近错误代码、请求成功与失败数量、正在执行的数量，以及队列和缓存大小。重启服务后这些状态重新计数。接口不返回查询 URL、缓存键、车次或航班号、日期、站名、完整行程或上游响应正文。

来源为 `available` 或最近有成功时间，仅表示曾收到 HTTP 成功且可解析的 JSON，不能证明某个日期有班次、停站匹配或轨道几何完整。查询结果仍需经过各接口的业务和几何校验；诊断状态不能作为线路真实性证据。

## 本地数据更新与来源清单

普通安装、构建和测试不运行数据更新。`scripts/prepare-data.mjs` 只读取维护者明确提供的本地原始资料，不自行联网下载，也不把生成时间当成来源核实时间。在项目根目录使用以下命令，路径和来源日期需替换为实际资料：

```sh
pnpm exec node scripts/prepare-data.mjs --stations /path/to/rail-stations.csv --station-names /path/to/station_name.js --airports /path/to/airport-codes.csv --source-date YYYY-MM-DD
```

`--output-dir` 可指定独立输出目录，默认是本项目的 `dist/data/`。输入包括铁路站点 CSV、12306 站名文件和机场 CSV；铁路背景使用已安装的 `@railroute-ts/china` 包。脚本先在内存中校验全部输入与生成结果，再写入临时目录并替换目标目录。输入或发布失败时保留原数据；未更新的底图、示例等文件原样保留。

更新生成 `stations.json`、`airports.json`、`rail-network.geojson`、`place-city-groups.json` 和 `data-sources.json`。来源清单记录来源 URL、许可说明、原始文件名、维护者提供的来源日期、生成时间、WGS84 坐标约定及条目数量；来源日期和生成时间分别记录。超出支持范围的坐标和缺少映射的城市按脚本校验规则明确处理，不猜测补齐。此次没有执行真实资料更新，因此不能把新增清单流程视为现有随包数据已经重新核实或重新生成的证据。

## 授权与公开部署边界

2026-10-01 核对的 [RailGo API 文档](https://api.railgo.dev/) 允许无需密钥的免费访问，同时约束商业收费使用并禁止公开接口中转。因此，受限公开模式必须配置 `TRIPREEL_RAILGO=disabled`，不能把 RailGo 查询藏在其他接口、后台刷新或 CDN 后继续提供。默认本机版仍仅监听 `127.0.0.1`；原坐标转换实现、来源归属和第三方许可继续保留。

公开模式保留 12306 和航旅纵横的固定来源查询，并沿用有界队列、缓存及端到端预算；这不构成对第三方服务稳定性或重新授权的保证。维护者需遵守各来源当时有效的访问条件，查询失败时保留手动录入及待补全流程，不增加任意 URL 代理。部署、CDN 与证书要求见 [部署说明](DEPLOYMENT.md)。

OpenStreetMap 派生数据归属：© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)，按 Open Database License（ODbL）使用。地图中保留可点击来源说明。代码依赖各自许可见对应包的许可文件。

`dist/data/place-city-groups.json` 包含 12306 的车站同城分组及常用机场的城市对应。机场按 IATA 精确匹配，未核对的机场城市保留为空，不按距离猜测。合并只影响总览地名标签，不改变真实起终点、坐标、路线或旅行记录。视频与交互地图使用相同的分组、轨迹和回放算法，并保留数据归属说明。
