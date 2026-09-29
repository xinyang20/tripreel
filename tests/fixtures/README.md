`g1802-railgo.json` 是 2026-09-21 从 RailGo `https://rg-api.zenglingkun.cn/api/v2/mapLine?train=G1802` 获取的公开车次线路快照，仅用于回归验证。线路数据来源和使用条件见[数据来源](../../docs/SOURCES.md)。

此快照在西安北之后存在约 250 米的片段接缝，南京南至西安北的乘坐区间完整。测试确保区间外接缝不否决已乘坐区间，站点投影不把接缝误作真实铁轨，且自动更新能修复已有记录。

`g813-railgo.json`、`g1-railgo.json` 和 `g813-main-railgo.json` 是同日 RailGo `mapLine?train=G813`、`mapLine?train=G1` 与 `getTrainMain?trainNum=G813` 的公开响应。用于验证 G813 缺少坐标时，只能在已核对的天津南至南京南京沪高铁区间使用共线参考；不能据此替换南京南以南的不同线路。停站变化和偏离也必须停止回退。

`g466-railgo.json` 为同日 `mapLine?train=G466` 的响应，只有最新停站。用于核对示意曲线必须连续经过西安北、商丘、阜阳西、合肥、南京南等实际停站，并且不可标为真实铁路。
