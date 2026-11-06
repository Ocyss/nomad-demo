# Nomad Blue / Green Demo

一个无后端框架的 Bun 演示。前后端均在 `src/`，不需要打包：

- `src/index.ts`：`Bun.serve`、版本 API、健康检查、WebSocket、SSE。
- `src/index.html`：HTML + Tailwind CSS CDN（需要浏览器能访问外网）。
- `src/app.js`：请求历史、协议检测、长连接及自动重连。

## 启动

```sh
mise install
bun install
mise run dev
```

打开 http://localhost:3000 。`dev` 使用 watch 重启，仅供编辑调试；部署演示使用 `mise run start`，避免把本地自动重启误当成蓝绿发布。

在两个终端分别启动（下面是 sh 环境变量语法）：

```sh
PORT=3001 DEPLOY_COLOR=blue APP_VERSION=v1 mise run start
PORT=3002 DEPLOY_COLOR=green APP_VERSION=v2 mise run start
```

直连两个端口可对比版本，但**不是流量切换**。完整蓝绿演示需要固定的反向代理入口，将 upstream 从 blue 切换到 green。代理须支持 WebSocket Upgrade，且 SSE 禁用缓冲；不要在每次发布时刷新页面，以便观察旧连接。

1. 固定入口先指向 blue，打开页面。
2. 启动 green，检查 `/health`，直连确认 `/api/version`。
3. Nomad 确认新版健康后自动晋升，入口代理更新 upstream。
4. 旧实例摘流等待 10 秒后停止，旧 WS / SSE 断开并自动重连到新版。
5. 需要回滚时部署上一版镜像（下面 deploy 命令使用 package.json 中的版本）。

## Docker 与 Nomad 发布

所有任务直接定义在 `mise.toml`，版本递增使用简短 Bun 脚本，构建/部署使用 shell + jq，无额外脚本文件。运行前执行 `mise install` 安装工具；Windows 需要可用的 Bash 环境（例如 WSL）。

`package.json` 的 `version` 使用三段数字，patch 和 minor 逢十进位：`0.0.8 → 0.0.9 → 0.1.0`，`0.9.9 → 1.0.0`，major 不设上限。这是演示用的递增规则，不是标准 SemVer 的进位规则。现有版本 `6` 对应迁移为 `0.0.6`。

`build` 通过 `depends = ["up_version"]` 先加一再构建；构建失败不会回退版本。

要求：单机 Linux / WSL 上可用的 Docker daemon、已启用 Docker 驱动的 Nomad client，默认 datacenter 为 `dc1`。构建和 Nomad client 必须使用同一个 Docker daemon，Nomad agent 需要能访问其映射端口以执行健康检查。可以通过 `IMAGE_NAME` 环境变量设置镜像名，build 和 deploy 时保持一致。

所有容器加入自定义 Docker bridge `nomad-demo`（任务依赖自动创建），不使用 Docker host 网络。Nomad 服务注册使用 `address_mode = "driver"`，两个网关直接访问应用的 **容器 IP:3000**，不再访问 `127.0.0.1:动态端口`。应用仍保留动态宿主机端口映射，仅供 Nomad 原生健康检查，因为原生检查不支持 driver 地址模式。

此网络是单机网络，不支持直接跨 Nomad client 通信。远程/多节点部署不能只推送镜像，还需要另外设计可路由的网络。

原有 502 的原因是入口容器内访问了注册的 `127.0.0.1`，它指向入口容器自身，而不是应用。首次迁移到新网络时，应用和网关都会重建，可能短暂中断。

```sh
# 首次发布：构建、部署、启动固定入口
mise run build
mise run deploy
mise run gateway           # Nginx：http://localhost:8080
mise run gateway:traefik   # Traefik：http://localhost:8081（可选，可与 Nginx 同时运行）
mise run status

# 修改 src 后：旧服务继续运行，新版健康后自动切换
mise run build
mise run deploy
mise run status
```

- `nomad/app.nomad.hcl`：1 个正式实例 + 1 个 canary，新版连续健康 5 秒后自动晋升。部署命令等待结果，不需要指定颜色或执行 promote。
- `nomad/gateway.nomad.hcl`：Nginx 根据 Nomad 原生服务注册中的 `live` 标签生成 upstream，使用 SIGHUP 平滑 reload；canary 的 `preview` 标签不接收正式流量。
- `nomad/traefik.nomad.hcl`：同样按 `live` 筛选，Nomad 模板生成动态 TOML，Traefik file provider 自动监听变化。无需挂载 Docker socket、连接 Nomad HTTP API 或启用管理面板。支持 WebSocket 和 SSE，关闭响应转发缓冲。
- 网关任选一个，也可同时运行进行对比。两个入口均为明文 HTTP，未配置 TLS。
- 首次启动 Traefik 需要拉取 `traefik:v3.6`。若 allocation 停留在 pending，用 `nomad alloc status <ID>` 检查拉取错误；Docker Hub DNS 不可用时先修复 Docker 的网络/DNS，执行 `docker pull traefik:v3.6` 成功后再重试 `mise run gateway:traefik`。这与应用的 bridge 网络或路由无关。
- 自动晋升后，旧实例先注销服务，再等待 `shutdown_delay = "10s"`，给 Nginx 更新 upstream 留出时间，然后发送 SIGTERM。这也消除了缺少 shutdown_delay 的警告。
- 旧 WS / SSE 最终会断开并自动重连，不会永久保留两套环境。摘流等待降低切换失败风险，但入口模板更新与停止实例并非原子操作，本配置用于演示，不保证严格零丢请求。
- 每次 `build` 使用 `shuf` 从内联的 17 种 Tailwind 鲜艳色系中随机选色，通过 `DEPLOY_COLOR` 写入镜像。同一镜像的颜色固定，随机允许重复；也可用 `DEPLOY_COLOR=violet mise run build` 指定颜色。颜色直接取环境变量，不校验、不维护额外色板文件。`shuf` 由 Linux / WSL 的 GNU coreutils 提供。
- HTML 在服务启动时生成一次，固定页面主题和「页面加载时版本」；旧页面不会随接口响应热更主题或结构，刷新或新开页面才看到新版。HTTP 状态和历史色块仍展示实际响应版本；WS / SSE 自动重连到新实例，状态与日志仅对颜色名称着色。失败请求使用红色 ×。
- 颜色仅用于可视化，实际切流由 Nomad 服务标签决定。
- 本地入口为 HTTP/1.1；浏览器 HTTP/2 演示仍需按下文配置 TLS。

## 指定版本与回滚

```sh
mise run deploy            # 默认部署 package.json 中的版本
mise run deploy 0.2.1      # 部署指定 tag，可回退到旧镜像
mise run deploy --help
```

参数直接作为镜像 tag 使用，不校验版本格式，也可传 `demo-preview` 这样的 tag。

指定版本不需要 Nomad 历史 job：它将当前 `nomad/app.nomad.hcl` 与指定镜像 tag 组合，提交一次部署，仍经过 canary 健康检查和自动晋升。本地没有镜像时先尝试 `docker pull`；镜像既不在本地也不在仓库时会失败，不会提交 job。它不会重新 build，也不会修改 package.json。

这与 `nomad job revert nomad-demo <job版本号>` 不同：后者依赖 Nomad 保存的历史，恢复当时完整的 job 配置；job 版本号不是 `0.2.1` 这样的应用版本。按 tag 部署仅回退镜像，继续使用当前 job 的环境变量、资源和网络配置；不会回滚数据库或外部状态。请保留旧 tag，不要用新内容覆盖发布过的 tag。

## 运维任务

```sh
mise run images                   # 列出 IMAGE_NAME 对应的本地镜像和版本
mise run images:remove 0.2.1      # 确认后删除指定 tag，不使用强制删除
mise run images:prune             # 确认后仅清理本项目未使用且无 tag 的镜像
mise run status                   # 查看实例及部署健康状态
mise run history                  # 查看 Nomad job 配置历史
mise run logs                     # 最近一次应用 allocation 的标准输出
mise run logs:error               # 最近一次应用 allocation 的错误输出
mise run stop                     # 确认后停止应用，保留 job 历史与网关
```

清理不会运行全局 `docker system prune`，不会删除容器、卷或网络。`images:prune` 按 Dockerfile 的 `org.opencontainers.image.title=nomad-demo` 标签筛选，只处理无 tag 的残留；旧版未带该标签的镜像不会被自动清理，所有带版本 tag 的镜像均保留。镜像仍被容器引用时 Docker 可能拒绝删除，应先确认相关容器是否可清理，不要强制删除运行中的版本。日志任务不持续跟踪；排查指定实例时使用 `nomad alloc logs [-stderr] <allocation-id> app`。

## 连续小说与断线演示

WS / SSE 每 200 ms 输出 3 个字，使用同一段循环小说。每段携带 `storyId`、`offset`、`next`、`text`；游标是字符位置，不是服务器启动时间。`src/story.ts` 中的内容跨版本一致时，新实例可以从任意游标继续输出，无需共享内存。它演示的是可重放数据源；真实业务需要持久化事件日志或数据库，不应据此假定连接迁移能保证消息不丢。

1. 小说默认自动续传，不提供额外开关。点击任一通道的「模拟断线」，小说显示断线/恢复标记，重连 URL 带上次已收到的 `next`；重复和缺字应保持为 0。
2. 保留旧页面，构建并部署新版。HTTP 状态每 500 ms 更新，WS / SSE 断线后自动续传，但旧页面的主题与静态版本标识不变。
3. 新开页面与旧页面对比：页面主题、静态元素属于各自加载时的版本，连接则可以访问同一个新版后端。刷新会加载新版 HTML，并从头开始小说。
4. 旧实例的长连接在 10 秒摘流窗口内仍可能出字，页面标识「旧连接仍存活」。只有真正断线后才开始统计恢复时间；收到新连接第一段时停止计时。

前端每 200 ms 重试，超过 1500 ms 无消息主动重连；后台标签页计时器节流或网络异常仍可能使实际耗时更长。网关模板更新等待为 100–300 ms，Nginx / Traefik 的上游连接超时为 1 秒，Traefik 配置合并窗口为 200 ms。这些是演示参数，不是生产环境的重试策略。

小说内容变更会改变 `storyId`，页面明确提示并从头开始，不把两个不同故事伪装为连续输出。每个通道仅显示最近 1500 字，保留最近 30 条连接日志。

修改网关配置后，重新执行 `mise run gateway` 或 `mise run gateway:traefik`；修改服务后执行 `mise run build`、`mise run deploy`。已有浏览器页面需要刷新一次以载入本次新增的前端逻辑，此后的版本切换无需刷新。

## 现场修改 API

修改 `src/index.ts` 顶部的 `snapshot()` 中的 `message` 或增加字段，再发布新版本即可。所有通道都带有相同的版本和实例标识。

| 配置                   | 默认值                          | 说明                                |
| ---------------------- | ------------------------------- | ----------------------------------- |
| `PORT`                 | `3000`                          | 监听端口，主机为 `0.0.0.0`          |
| `DEPLOY_COLOR`         | 镜像构建时随机选择；本地为 cyan | Tailwind 鲜艳色系名称，部署无需设置 |
| `APP_VERSION`          | package.json version            | 发布版本                            |
| `NOMAD_ALLOC_ID`       | 主机名                          | 自动标识 Nomad 实例                 |
| `TLS_CERT` / `TLS_KEY` | 不设置                          | 同时设置以启用原生 HTTPS            |

接口：`GET /health`、`GET /api/version`、`GET /api/events`、`/ws`（WebSocket）。收到 SIGTERM / SIGINT 时健康检查转为 503，关闭长连接并等待请求完成，最多等待 5 秒。Nomad 的 `kill_timeout` 应大于 5 秒；入口摘流应先于停止实例。长连接不会自动迁移，客户端通过重连找到新版本。

## HTTP/2

使用 Bun 1.4.4 验证，`Bun.serve({ http2: true })` 是实验性 API。保留 HTTP/1.1，以支持 WebSocket Upgrade；不支持 WebSocket over HTTP/2。

默认明文监听支持 HTTP/2 prior knowledge，可用支持 HTTP/2 的 curl 验证：

```sh
curl --http2-prior-knowledge -v http://localhost:3000/api/version
```

浏览器通常不会对明文 HTTP 使用 HTTP/2。使用本机信任的开发证书（例如 mkcert 生成）：

```sh
TLS_CERT=./localhost.pem TLS_KEY=./localhost-key.pem mise run start
```

打开 https://localhost:3000 ，页面右上角应显示 `h2`。也可在反向代理终止 TLS 并开启 HTTP/2，此时标识的是**浏览器到代理**的协议，不代表代理到 Bun 的协议。Tailwind CDN 仅适合演示用途。

## 验证

```sh
mise run typecheck
mise run test
```

测试覆盖健康检查、静态资源、版本 API、SSE、WebSocket 回显与原生明文 HTTP/2。
