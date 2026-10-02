# GitHub 仓库与发布

项目名称：途映 · TripReel。公开仓库：[xinyang20/tripreel](https://github.com/xinyang20/tripreel)。

## 当前状态

本目录是独立源码目录，保留原生 JavaScript、Node、MapLibre、Three.js 及 pnpm 锁文件。源码仍在 `dist/`，使用说明在 [README.md](../README.md)，贡献流程在 [CONTRIBUTING.md](../CONTRIBUTING.md)，维护规则在 [AGENTS.md](../AGENTS.md)，详细说明在 `docs/`，第三方许可在 `licenses/`。

旧开发目录保留其 Git 历史和私人文件。由于旧提交曾含个人行程示例，新目录从已整理的当前快照建立发布用历史，不把旧提交复制进公开仓库。测试中的私人日期组合已替换为合成数据；公开车次几何夹具保留，仅用于回归，不代表任何人的真实出行记录。

改名只更新品牌和文件名。IndexedDB 名称 `travel-trace`、旧版键 `travel-trace.v1`、备份格式和 HTTP 接口继续兼容；保持同一浏览器与 `http://127.0.0.1:4173` 即可继续使用既有记录。换源码目录不会移动或上传浏览器数据。

本地 `main` 分支通过 `origin` 同步源码。当前源码不包含 GitHub Actions CI，验证在本机执行。本地提交不会自动更新远程仓库，需单独推送；判断远程状态应检查实际推送结果。

## 仓库内容

纳入源码、测试、合成示例、公开运行数据、文档、许可证和锁文件。`dist/data/` 是运行所需的数据文件；`dist/vendor/` 是构建生成的第三方浏览器运行库，使用 `pnpm run build` 恢复。

OSM 参考轨道的派生数据位于 `dist/data/rail-corridors.json`，原始对象、核实清单与归属位于 `scripts/rail-data/`，维护方法见 [试点说明](../scripts/rail-data/NOTICE.md)。提交数据更新时一并保留对应来源、版本、证据及 ODbL 条件；这些公开资料不属于个人行程，也不受根目录 MIT 重新授权。

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

单元、服务与浏览器回归使用模拟上游，不访问真实列车与航班查询，也不启动网站部署。真实 Safari/QuickTime 和视频长片验收记录见 [VALIDATION.md](VALIDATION.md)，自动测试成功不能替代实际播放验证。Node.js 要求 `>=22`，pnpm 版本由 `package.json` 的 `packageManager` 指定。

## 克隆与后续上传

在其他目录取得项目：

```sh
gh repo clone xinyang20/tripreel
cd tripreel
pnpm install --frozen-lockfile
pnpm run build
```

本地修改完成并验证后，先核对改动，按功能暂存具体文件并提交。下例仅演示 README 单文件修订，实际文件和说明须对应本次修改：

```sh
git status --short
git diff -- README.md
git add README.md
git diff --cached --check
git diff --cached
git commit -m "docs: clarify local setup instructions"
```

跨模块改动可分批提交，但每批需包含运行所需的关联模块和数据。沿用近期提交的英文 Conventional Commit 风格，正文记录变化及实际验证；提交后再次检查 `git status --short` 和 `git log --oneline -3`。本地提交不代表已经推送或部署。

需要同步到公开仓库时，再单独推送：

```sh
git push origin main
```

推送前确认提交不含私人文件，并先同步远程新增提交；不要用强制推送覆盖。没有自动开启 Pages、网站托管或公网 API 代理。

## 开源许可

项目自有代码采用 [MIT License](../LICENSE)。复制或分发相关代码时保留其版权与许可声明。

第三方代码、依赖、数据和在线服务仍遵循各自的许可、归属与访问条件，根目录 MIT 许可不替换这些条件。保留 [RailGo 原许可](../licenses/RAILGO-LICENSE.txt) 及 [SOURCES.md](SOURCES.md) 的来源说明；开源代码不代表取得第三方数据的重新授权。公开部署须采用禁用全部 RailGo 在线接口的受限模式，并配置固定公开来源、反向代理和 HTTPS，具体要求见 [部署说明](DEPLOYMENT.md)，不能直接发布默认本机查询代理。
