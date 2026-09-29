# GitHub 上传准备

项目名称：途映 · TripReel。仓库名：`tripreel`。目标账号：`xinyang20`。用户选择的可见性：公开。

## 当前状态

本目录是独立源码目录，保留原生 JavaScript、Node、MapLibre、Three.js 及 pnpm 锁文件。源码仍在 `dist/`，使用文档在根目录 `README.md`，维护规则在 `AGENTS.md`，详细说明在 `docs/`，第三方许可在 `licenses/`。

旧开发目录保留其 Git 历史和私人文件。由于旧提交曾含个人行程示例，新目录从已整理的当前快照建立发布用历史，不把旧提交复制进公开仓库。测试中的私人日期组合已替换为合成数据；公开车次几何夹具保留，仅用于回归，不代表任何人的真实出行记录。

改名只更新品牌和文件名。IndexedDB 名称 `travel-trace`、旧版键 `travel-trace.v1`、备份格式和 HTTP 接口继续兼容；保持同一浏览器与 `http://127.0.0.1:4173` 即可继续使用既有记录。换源码目录不会移动或上传浏览器数据。

本次范围是准备上传。GitHub 仓库的创建和推送命令见下方，尚未执行；GitHub Actions 也尚未在远程运行。

## 仓库内容

纳入源码、测试、合成示例、公开运行数据、文档、许可证、锁文件和 CI 配置。`dist/data/` 是运行所需的数据文件；`dist/vendor/` 是构建生成的第三方浏览器运行库，使用 `pnpm run build` 恢复。

`.gitignore` 排除依赖、运行库副本、个人行程文本、备份、视频、截图与追踪输出、浏览器配置、环境文件、私钥和编辑器临时文件。忽略规则只作用于未跟踪文件，因此不要主动使用 `git add -f` 上传这些材料。

## 本地验证

在项目根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
pnpm run test
```

需要本机 Chrome 的浏览器回归：

```sh
pnpm run test:browser
```

CI 对 Node 22 和 24 执行静态检查、构建和单元/服务测试，全部使用模拟上游；不访问真实列车与航班查询，也不启动网站部署。真实 Safari/QuickTime 和视频长片验收记录见 [VALIDATION.md](VALIDATION.md)，不会用 CI 成功替代实际播放验证。

工作流配置依据 [actions/checkout](https://github.com/actions/checkout)、[actions/setup-node](https://github.com/actions/setup-node) 和 [pnpm/action-setup](https://github.com/pnpm/action-setup) 的官方使用说明。pnpm 版本继续由 `package.json` 的 `packageManager` 指定。

## 创建并上传

准备好实际发布时，在新目录中执行：

```sh
gh auth status
git status --short
gh repo create xinyang20/tripreel --public --source=. --remote=origin --description '途映 · 把走过的路，映成故事。个人火车与飞机旅行轨迹、地图回放和视频导出。'
git push -u origin main
```

如果同名远程仓库已经存在，先核对内容与归属，再设置远程地址；不要用强制推送覆盖。没有自动开启 Pages、网站托管或公网 API 代理。

## 许可状态

目前没有为项目自有代码选定开源许可证。本次整理不自行添加 MIT 等授权；公开可见性与选择开源许可是两件不同的事。第三方代码和数据仍按其原有许可与来源说明处理，见 [SOURCES.md](SOURCES.md) 与 [RailGo 许可](../licenses/RAILGO-LICENSE.txt)。
