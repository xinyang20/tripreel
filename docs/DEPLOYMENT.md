# 公开部署说明

本文说明 `tripreel.xinyang20.cn` 的受限公开模式、源站运行方式、CDN 与 HTTPS 配置，以及发布后的检查步骤。配置示例和命令本身不代表已经上线；实际可用性、证书签发和续期结果需要分别检查。

公开模式停用全部 RailGo 在线接口，默认使用 OSM 本地参考轨道。当前白名单仅覆盖 G1 在沧州西、德州东、曲阜东、南京南之间的同向子区间；映射到期或未覆盖时提供 12306 停站示意或待补全结果，不回退 RailGo。保留手动与批量录入、时刻查询、航班示意、备份恢复、地图回放和浏览器内视频导出。OSM 参考、停站及手动示意均须明确确认，不代表历史当日轨迹。来源条款见 [数据来源](SOURCES.md)。本轮新增功能仅完成本地开发，本文不表示已更新线上部署。

## 运行结构

源站访问链路为浏览器、Nginx、Node 服务；接入 CDN 后，由 CDN 在浏览器和源站之间转发。Nginx 负责源站 HTTPS，Node 始终监听 `127.0.0.1:4173`，不直接对公网开放。个人记录仍保存在访问浏览器的 IndexedDB；此部署不提供账号、云同步或服务端个人数据库。

| 项目          | 配置                                                     |
| ------------- | -------------------------------------------------------- |
| 公开来源      | `https://tripreel.xinyang20.cn`                          |
| 发布目录      | `/opt/tripreel/releases/<release>/`                      |
| 当前版本      | `/opt/tripreel/current`，指向一个发布目录的符号链接      |
| 运行用户      | `tripreel`，不允许交互登录                               |
| Node 运行时   | `/opt/tripreel/runtime/node-v24.14.0-linux-x64/bin/node` |
| 环境文件      | `/etc/tripreel.env`                                      |
| systemd 服务  | `tripreel.service`                                       |
| HTTP 验证目录 | `/var/www/tripreel-acme`                                 |

这些路径属于本次部署约定；其他服务器应相应调整。可复用仓库中的 [systemd unit](../deploy/tripreel.service)、[环境配置](../deploy/tripreel.env.example)、[Nginx 配置](../deploy/nginx.conf) 和 [续期钩子](../deploy/renewal-hook.sh)。项目不需要 Python 或服务器视频转码，不安装开发用浏览器作为站点运行依赖。不要把个人记录、备份、视频、浏览器配置、访问凭据或证书私钥放进发布目录或 Git 仓库。

## 应用配置

环境文件包含以下公开配置：

```dotenv
TRIPREEL_PUBLIC_ORIGIN=https://tripreel.xinyang20.cn
TRIPREEL_RAILGO=disabled
```

`TRIPREEL_PUBLIC_ORIGIN` 指定唯一公开 HTTPS 来源，不能填写通配符或根据请求头动态扩展。公开模式在服务端强制禁用 RailGo，即使请求显式填写 `provider: railgo` 也会在访问上游之前拒绝；环境仍显式保留 `TRIPREEL_RAILGO=disabled`。列车轨道、主数据、同线区间回退与后台刷新均不得发出 RailGo 请求。本机不设置公开来源时初始默认 RailGo。

发布包需包含 `dist/data/rail-corridors.json`，并保留公开的 ODbL 数据下载和 [原始资料及重建说明](../scripts/rail-data/NOTICE.md)。运行时仅读取本地索引，不访问 OSM 或公共 Overpass。白名单有效期按北京时间动态检查，不因服务器重启或重新构建延长。上线验收须检查 `/api/capabilities` 的来源、默认值、覆盖范围和版本，同时验证一条覆盖区间及一条未覆盖区间；数据过期后，新查询不能继续返回该已核验轨道候选，已确认的旧主线按原版本保留，不随到期重写。

Node 保留 Host/Origin 校验、请求体限制、固定上游、有界请求队列和总预算。Nginx 应向应用传递该站点的 Host，并保留浏览器 Origin；不要把所有请求的 Origin 都改写成本站来源，否则会绕过应用的来源检查。不要新增任意 URL 代理或为了公开部署改成监听 `0.0.0.0`。

systemd 使用上述专用 Node 运行时、`WorkingDirectory=/opt/tripreel/current` 和 `EnvironmentFile=/etc/tripreel.env`，以 `tripreel` 用户启动 `server.mjs`。`ExecStart` 使用相对入口 `node server.mjs`，避免 `current` 符号链接与 Node 解析后的真实模块路径不同，导致直接执行判断失效。发布文件和运行时由 root 管理，应用运行用户只需读取代码与数据；临时文件留在受限临时目录。服务失败后自动重启，日志通过 journal 查询，不记录完整行程或上游查询参数。

```sh
systemctl status tripreel --no-pager
journalctl -u tripreel -n 50 --no-pager
```

环境文件或服务配置修改后需重启应用；修改 systemd unit 后还需先执行 `systemctl daemon-reload`。

## Nginx 与 CDN

源站为该域名配置独立虚拟主机，其他站点配置保持独立。HTTP 的 `/.well-known/acme-challenge/` 从 `/var/www/tripreel-acme` 读取，其他普通 HTTP 请求转到 HTTPS。HTTPS 代理到 `http://127.0.0.1:4173`，上游等待时间需覆盖应用最长 75 秒预算，例如设置为 90 秒；应用自己的预算不会因此延长。

| 路径或设置                      | 要求                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `/api/*`                        | CDN 和 Nginx 都不缓存，不缓存成功或错误响应，不只按 URL 路径合并查询   |
| `/.well-known/acme-challenge/*` | 直接回源到验证目录，不缓存、不鉴权，不经过应用接口                     |
| HTML、JavaScript、CSS           | 遵循源站缓存策略；文件名未带版本，每次发布需使旧版本失效，避免混用模块 |
| 回源 Host 和 TLS SNI            | 使用 `tripreel.xinyang20.cn`，与源站虚拟主机和证书一致                 |
| 请求方法与内容                  | 允许应用需要的 GET 和 POST，保留 JSON 请求体及预算、优先级请求头       |
| 连接保护                        | 外层设置适当速率和请求体限制，保留应用原有校验，不对其他站点扩大规则   |

用户已配置 CDN 不能替代上述逐项检查。尤其要确认 CDN 没有缓存 `/api/train`、`/api/flight`、`/api/route` 和 `/api/diagnostics`，也没有给长时线路查询设置低于应用预算的连接超时。

## Let's Encrypt 证书与续期

CDN 边缘证书用于浏览器到 CDN；源站证书用于 CDN 到 Nginx，两者分别配置和续期。源站使用 Let's Encrypt 并不表示 CDN 会自动获取或更新同一张证书；浏览器看到有效边缘证书也不能证明源站已启用并验证 HTTPS。回源应启用证书验证并使用正确的 SNI。

本部署使用 HTTP-01 webroot 验证。签发前先在验证目录放置临时测试文件，从公开域名的 HTTP 验证路径确认能取得相同内容，再删除测试文件。必须保留该路径的 HTTP 可达性供续期使用；不要依赖只有初次签发时才存在的临时代理规则。

使用系统已安装的 Certbot，签发命令形如：

```sh
certbot certonly --webroot --webroot-path /var/www/tripreel-acme --domain tripreel.xinyang20.cn
```

证书成功签发后，Nginx 使用 `/etc/letsencrypt/live/tripreel.xinyang20.cn/fullchain.pem` 和同目录下的 `privkey.pem`。这些文件由证书工具管理，不复制进项目或暴露给静态服务。加载证书前运行 `nginx -t`，成功后再重新加载 Nginx。

启用 Certbot 的系统续期定时器，并配置仅在续期成功后执行的部署钩子，先运行 `nginx -t`，成功后执行 `systemctl reload nginx`。保留现有服务器的其他证书任务，不创建互相重叠的续期计划。检查定时器及演练续期：

```sh
systemctl list-timers --all
certbot renew --cert-name tripreel.xinyang20.cn --dry-run --run-deploy-hooks
```

只有演练成功才能记录“续期验证通过”；证书签发成功、定时器存在和续期成功是不同检查结果。CDN 如单独管理边缘证书，还需在其控制台检查边缘续期机制。

## 发布和回退

先在本机完成相关测试，以及 `pnpm run test`、`pnpm run build`、`pnpm run check`。交互变化执行隔离浏览器回归，不能把线上用户记录当作验证数据。发布时使用已锁定的依赖和项目运行数据；`dist/` 是源码目录，不能作为普通构建输出清空。

本次采用本机构建后同步：按 `packageManager` 和锁文件准备依赖，执行 `pnpm run build`，将已审核源码、锁文件、项目运行数据、许可及生成的 `dist/vendor/` 一起放进新的发布目录。服务器运行仅依赖专用 Node 运行时和这些文件，无需安装 pnpm 或 `node_modules/`。若选择在服务器上构建，则需先准备指定 pnpm 版本，执行 `pnpm install --frozen-lockfile` 与 `pnpm run build`。

同步时使用明确的项目文件清单，不上传本地输出、测试浏览器配置、`.git`、个人文件或凭据；打包时排除 macOS 扩展属性。准备完成后，再把 `current` 切换到新版本并重启 `tripreel.service`，不要边覆盖当前版本边提供服务。

检查新进程、源站和 CDN 后才记录发布成功。若新版本失败，把 `current` 切回之前仍完整保留的版本并重启，再重复检查。回退服务器代码不会恢复或删除浏览器的个人记录，也不能逆转已经发生的客户端数据迁移；涉及存储格式变化时应另行规划兼容策略。

## 上线检查

发布后分别记录以下结果，不用单个首页 HTTP 200 代替整站验收：

1. `tripreel.service` 正常运行，Node 只监听回环地址，Nginx 配置检查通过；未知 Host 或跨站 Origin 不能绕过应用限制。
2. 分别检查源站和 CDN 域名的 HTTPS，确认主机名、证书链和有效期；HTTP 按预期跳转，ACME 验证文件仍可独立访问。
3. 确认公开模式实际生效，RailGo 没有在线请求；停站示意、手动途经点、航班、待补全和失败提示保留预期行为。
4. 检查 `/api/*` 返回不缓存，CDN 未返回旧接口响应；新页面加载的模块来自同一发布版本。
5. 使用合成行程和隔离浏览器验证添加、确认、保存、刷新后恢复、备份导入导出、地图及视频；不读取或改写用户真实浏览器记录。
6. 检查续期定时器、成功部署钩子及 `certbot renew --dry-run --run-deploy-hooks`；保留结果和尚未验证的范围。

若第三方查询暂时失败，应区分“部署不可达”和“上游没有可用结果”，不能把待补全记录或示意路线描述成已核实的班次轨迹。

## 从本机迁移记录

`http://127.0.0.1:4173`、`http://localhost:4173` 与 `https://tripreel.xinyang20.cn` 分别拥有独立存储，HTTP 和 HTTPS 也不共用记录。上线不会自动搬运本机数据。

在原浏览器和原地址打开途映，导出完整 JSON 备份；随后在 HTTPS 站点导入，核对恢复预览后确认保存。保留原备份直到确认记录、分组和线路完整。更换浏览器、设备或清理网站数据后，同样需要备份恢复。视频不能代替 JSON 备份，服务器没有可代为找回的个人副本。
