# 京沪试点原始资料与维护

取得及核对日期：2026-10-02。这里仅包含公开轨道资料与车次核对事实，没有个人行程。轨道来自 OpenStreetMap，车次径路与停站分别核验，没有使用 RailGo 数据为本试点背书。

## 文件与归属

- `jinghu-356778.osm` 是 [OSM relation 356778 的完整 JSON 响应](https://www.openstreetmap.org/api/0.6/relation/356778/full.json)保留的节点、way、relation 数据，文件内容为 JSON，非 OSM XML。为减少无关贡献者个人标识，移除了 `user`、`uid`、`changeset` 字段，保留元素 ID、版本、编辑时间、标签、节点与成员关系。关系版本为 268，编辑时间为 2026-09-24T22:42:54Z。
- 轨道数据和派生数据归属 **© OpenStreetMap contributors**，按 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)提供；[OSM 版权及归属说明](https://www.openstreetmap.org/copyright)。根目录 MIT 仅适用于项目代码，不能替代轨道数据许可。公开使用派生数据库时保留归属和 ODbL 条件；本目录保留可重建来源，`dist/data/rail-corridors.json` 是可下载的派生数据。
- `jinghu-pilot.json` 是人工核实清单，指定股道 seed way、区间站点、里程范围、有限车次名单、证据及有效期。导入脚本不从全网最短路推断车次路径。
- `g1-stops-2026-10-02.json` 是当次 [12306 停站查询](https://kyfw.12306.cn/otn/czxx/queryByTrainNo?train_no=24000000G10L&from_station_telecode=VNP&to_station_telecode=AOH&depart_date=2026-10-02)的站名和时刻事实摘录，供核对证据，不是可复用的全量时刻数据库许可。内部车次标识来自同日[车次查询](https://search.12306.cn/search/v1/train/search?keyword=G1&date=20261002)，更新时不得沿用旧内部标识。

## 实际覆盖与证据边界

OSM 原始关系包括京沪高铁双线；导入器只沿指定 seed 所在的连续、无分岔一股轨道截取天津南至南京南，生成 1472 个 WGS84 点。不声明列车在车站内实际使用哪一股道，也不声明历史乘车日的真实轨迹。

独立径路依据为上海市口岸服务办公室 2026-01-19 的[铁路运行图报道](https://kab.sww.sh.gov.cn/xwzx/001001/20260119/625b851e-c841-4e09-b411-9f8cd4ce44e8.html)，其中将 G32/G1 列入京沪高铁大站标杆列车；2026-10-02 取得的 12306 完整停站表另行核对实际停站。当前 G1 完整停站为北京南、沧州西、德州东、曲阜东、南京南、苏州北、上海虹桥，**不停天津南**。本试点只允许 G1 在沧州西、德州东、曲阜东、南京南之间的同向合法子区间。查询时仍须完整停站序列相同，结果始终是需要用户预览确认的 `corridor` 参考。不能据线路经过推断其他站有该车次停靠。

G813 已核对同日停站，但尚无足以保留的独立车次全区间径路证据，因此未进入 OSM 白名单。天津南—南京南的整个服务区间尚未覆盖，不应宣称完成全部车次替代。

## 更新与导入

在临时文件中取得新数据并审阅后，再替换这里的来源；普通构建不访问 OSM，公开网站请求也不访问 OSM 或 Overpass。单次完整关系下载可用：

```sh
curl --fail --location --max-time 60 'https://www.openstreetmap.org/api/0.6/relation/356778/full.json' --output /tmp/tripreel-jinghu-full.json
```

下载不代表白名单已重新核实。应核对关系的连续性和站点、独立车次径路证据、当次 12306 完整停站、核对日期与版本，再修改清单。保留 ODbL 归属与原始来源。已保留资料可离线重复构建：

```sh
pnpm exec node scripts/import-rail-osm.mjs --osm scripts/rail-data/jinghu-356778.osm --manifest scripts/rail-data/jinghu-pilot.json --output dist/data/rail-corridors.json
```

导入先校验坐标、成员完整性、分岔、站序投影、区间长度及白名单证据，成功后仅替换明确指定的输出文件；失败保留旧输出。它不会自动选择其他线路或调用 RailGo。

每条车次映射必须有 `validFrom` / `validUntil`，到期日不得晚于核实日后 30 天。首版有效日期为 2026-10-02 至 2026-11-01（按北京时间日期判断，含首尾）。服务运行跨过到期日也会停用映射，无需重启；未生效、过期或完整停站变化时，有可靠停站则降为需确认的停站示意，否则保留待补全状态。查询历史行程也只能取得当前有效的线路参考；已经确认保存的旧主线不会自动改写。重新构建、重新下载或在线停站匹配不会自动延长证据有效期，必须重新核实并更新版本和日期。
