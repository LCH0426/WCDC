# AGENTS.md

面向在本仓库中继续开发的 agent。项目名为 **WCDC**，仓库地址 `https://github.com/LCH0426/WCDC`。这里只记录“看代码不容易快速推断出来”的上下文、构建方法和约束。用户要求不要额外写 README / 自述文档；本文件是用户明确要求维护的 agent 上下文。

## 1. 项目结构

- `apps/server/`：Rust 后端（axum + tokio + SQLite），同时提供 API、静态前端、转码、图片转换和归档日志。
- `crates/quark-core/`：夸克网盘核心逻辑、账号、下载、存储（crate 名保留 Quark，因为对接的是夸克协议）。
- `crates/quark-store/`：SQLite 持久化。
- `crates/quark-protocol/`：夸克接口协议类型。
- `web/`：React 19 + Vite + HeroUI 前端。
- `packaging/fnos/wcdc/`：飞牛 fnOS 的 fpk 打包目录。
- `dist/`：发布产物，已 gitignore，不要提交。

品牌 / 命名约定：

- 产品名、页面标题、侧边栏标题、fpk `display_name`：`WCDC`
- 后端 package / 二进制：`wcdc-server`
- 前端 package：`wcdc-frontend`
- 默认数据目录：`wcdc`
- SQLite：`wcdc.db`
- 会话 Cookie：`wcdc_session`
- 飞牛 appname：`wcdc`，网关 `/app/wcdc`
- 环境变量前缀：`WCDC_`（旧 `QUARK_WEB_*` 不再读取）
- 发布文件：`WCDC-<version>-windows-x64.exe`、`WCDC-<version>-linux-x64`、`WCDC-<version>-x86.fpk`

前端在编译时通过 `rust-embed` 嵌入后端二进制：

```rust
#[derive(rust_embed::RustEmbed)]
#[folder = "../../web/dist"]
struct WebAssets;
```

因此 **任何前端改动都必须先 `npm run build`，再重新编译 Rust**，否则发布二进制里仍是旧页面。`WCDC_STATIC_DIR` 仅用于开发时从磁盘读取前端。

## 2. 常用开发命令

```bash
# 前端依赖与构建
cd web
npm ci
npm run build          # tsc --noEmit && vite build

# 后端（开发）
cd ..
cargo run -p wcdc-server

# 后端测试（当前 40 个测试，含图片转换和 QSV 参数测试）
cargo test -p wcdc-server
```

默认监听 `127.0.0.1:8787`，数据目录为系统默认的 `wcdc` 目录。首次访问需要注册站点密码。

CI 中必须先构建前端再编译 Rust：`web/dist` 被 gitignore，`rust-embed` 在干净 checkout 中找不到它会导致 Rust 任务失败。`.github/workflows/ci.yml` 的 rust job 已加入 `npm ci && npm run build`。

SQLite：`crates/quark-store/src/lib.rs` 使用 WAL + `synchronous=NORMAL` + `wal_autocheckpoint=4000`。如果日志出现 `INSERT INTO transfer_parts ... elapsed=3.6s`，优先检查数据目录所在磁盘（HDD 自旋、NAS 网络盘、WAL checkpoint）和并发传输数；不要把它误判为 SQL 写错。分片完成仍会逐片落库，这是断点续传所需的持久化。

开发时可用独立数据目录和端口，避免污染用户数据：

```bash
WCDC_BIND=127.0.0.1:8785 \
WCDC_DATA_DIR="$TEMP/wcdc-dev-data" \
cargo run -p wcdc-server
```

## 3. 发布构建矩阵

三个产物必须分别构建、分别校验：

| 产物 | 目标 | 关键点 |
|---|---|---|
| Windows 单文件 | `x86_64-pc-windows-msvc` | 静态 CRT |
| Linux 单文件 | `x86_64-unknown-linux-musl` | musl 静态链接 |
| 飞牛 fpk | `x86_64-unknown-linux-musl` | 仅 x86_64，包内嵌 Linux 二进制 |

### 3.1 前端（所有版本共用）

```bash
cd web
npm ci
npm run build
cd ..
```

### 3.2 Windows 单文件

在 Windows + MSVC 工具链下：

```bash
RUSTFLAGS="-C target-feature=+crt-static" \
cargo build --release -p wcdc-server --target x86_64-pc-windows-msvc

cp target/x86_64-pc-windows-msvc/release/wcdc-server.exe \
   dist/WCDC-<version>-windows-x64.exe
```

PowerShell：

```powershell
$env:RUSTFLAGS="-C target-feature=+crt-static"
cargo build --release -p wcdc-server --target x86_64-pc-windows-msvc
Copy-Item target/x86_64-pc-windows-msvc/release/wcdc-server.exe `
  dist/WCDC-<version>-windows-x64.exe
```

### 3.3 Linux musl 单文件

需要 `x86_64-unknown-linux-musl` 目标和 `cargo-zigbuild` + `zig`：

```bash
rustup target add x86_64-unknown-linux-musl
cargo install cargo-zigbuild
# 另需安装 zig（当前验证过 0.16.0）

cargo zigbuild --release -p wcdc-server --target x86_64-unknown-linux-musl

cp target/x86_64-unknown-linux-musl/release/wcdc-server \
   dist/WCDC-<version>-linux-x64
```

注意 `cargo-zigbuild` 的参数不是 `cargo zigbuild --version`，不要用它判断是否安装。

### 3.4 飞牛 fpk

**fpk 必须是 gzip 压缩的 tar，不能是普通 tar。** 普通 tar 会被飞牛识别为“不是有效 fpk 文件”。同时 manifest 里的 `checksum` 是 `app.tgz` 的 MD5，不能沿用旧值。

使用官方 fnpack 1.2.3 生成，再修正 Windows 下的 0666 权限：

```bash
# 下载一次即可
curl -L -o fnpack.exe https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64

cargo zigbuild --release -p wcdc-server --target x86_64-unknown-linux-musl
cp target/x86_64-unknown-linux-musl/release/wcdc-server \
   packaging/fnos/wcdc/app/bin/wcdc-server

cd packaging/fnos/wcdc
# fnpack.exe 放在仓库根目录时
../../../fnpack.exe build
python -I ../repack_fpk.py wcdc.fpk
```

`fnpack build` 会生成 gzip fpk，并做这些事：

- 生成内层 `app.tgz`，包含 `bin/`、`ui/` 和 `config/`
- 在 manifest 末尾写入 `checksum = <app.tgz 的 MD5>`
- 外层包含 `app.tgz`、`cmd/`、`config/`、`ICON.PNG`、`ICON_256.PNG`、`manifest`、`wizard/`

`packaging/fnos/repack_fpk.py` 只做两件事：

1. 把 `bin/wcdc-server` 设为 `0755`，其他文件设为 `0644`，目录 `0755`，并去掉 `.gitkeep`；
2. 用新的 `app.tgz` 重新计算 MD5，更新 manifest 的 `checksum`，再写回 **gzip** 外层包。

不要再用“手动普通 tar 打包”的方式生成 fpk。

`.gitattributes` 已强制 `*.sh`、`packaging/fnos/*/cmd/*`、`config/*`、`manifest` 使用 LF。打包前仍要确认这些文件没有 CRLF，否则 fnOS 上的 `#!/bin/bash\r` 会启动失败：

```bash
python -I -c "import pathlib; [p.write_bytes(p.read_bytes().replace(b'\r\n', b'\n')) for p in pathlib.Path('packaging/fnos/wcdc/cmd').iterdir() if p.is_file()]"
```

打包后复制并生成校验和：

```bash
cp packaging/fnos/wcdc/wcdc.fpk \
   dist/WCDC-<version>-x86.fpk

sha256sum dist/WCDC-<version>-windows-x64.exe \
          dist/WCDC-<version>-linux-x64 \
          dist/WCDC-<version>-x86.fpk > dist/SHA256SUMS.txt
```

## 4. 飞牛 fnOS 包的关键约定

`packaging/fnos/wcdc/manifest`：

- `appname=wcdc`
- `platform=x86`（只做 x86_64）
- `ctl_stop=true`
- `desktop_uidir=ui`
- `desktop_applaunchname=wcdc.Application`
- `disable_authorization_path=false`：允许用户在飞牛应用设置中授权目录
- `os_min_version=1.1.3100`

`config/privilege`：

- `run-as=package`
- 用户/组 `wcdc`
- `join-groups=["video","render"]`，用于访问核显设备

`config/resource`：

- 数据共享目录 `wcdc/downloads`

`app/ui/config`：

- 入口类型 `iframe`
- `gatewayPrefix: "/app/wcdc"`
- `gatewaySocket: "app.sock"`
- `url: "/app/wcdc"`

`cmd/main` 启动 Unix Socket 服务，并导出：

```bash
WCDC_DATA_DIR="${TRIM_PKGVAR}"
WCDC_UNIX_SOCKET="${TRIM_APPDEST}/app.sock"
WCDC_GATEWAY_PREFIX="/app/wcdc"
WCDC_COOKIE_PATH="/app/wcdc"
WCDC_FNOS_MODE=1
WCDC_ALLOWED_PATHS="${TRIM_DATA_ACCESSIBLE_PATHS}:${TRIM_DATA_SHARE_PATHS}"
```

服务端对应行为：

- `WCDC_GATEWAY_PREFIX`：外层的 `router()` 用 `Router::nest(prefix, base)` 挂载。不要用 `Router::layer` 改写 URI，`layer` 在路由匹配之后执行，无法让 `/app/wcdc/api/...` 命中 API 路由。
- `WCDC_UNIX_SOCKET`：监听 `/var/apps/<appname>/target/app.sock`，权限 0666。
- `WCDC_COOKIE_PATH`：会话 Cookie 必须限定在 `/app/wcdc`，否则飞牛网关下登录会跳到错误路径。
- `WCDC_FNOS_MODE=1`：
  - 侧边栏隐藏“服务器文件”和“终端”；
  - 直接访问 `/server-files`、`/terminal` 重定向到 `/downloads`；
  - 终端 WebSocket 直接返回 403 `terminal_disabled`；
  - 存储浏览、下载目标、转码扫描/输出、图片扫描/输出只能使用 `WCDC_ALLOWED_PATHS` 中的授权目录；
  - 授权目录之外统一返回 400，提示“该路径不在飞牛应用已授权的文件夹内”。
- 网关请求的跨域判断要信任 `X-Forwarded-Host` / `X-Real-Host` 和 `X-Trim-*` 头；Unix Socket 请求本身也按同源处理。否则飞牛桌面 iframe 会 403。

登录后跳转必须使用 `APP_BASE`（见 `web/src/lib/base.ts`），不能写死 `/downloads`。历史上飞牛网关下登录后 nginx 403 就是这个原因。

## 5. 多版本飞牛包（独立安装、并行共存）

飞牛用 `appname` 作为应用唯一标识。要让两个版本同时安装，必须使用不同的 `appname`，不能只改 `version`。

复制一份打包目录：

```bash
cp -r packaging/fnos/wcdc packaging/fnos/wcdc-beta
```

在副本中至少修改：

1. `manifest`
   - `appname=wcdc-beta`
   - `display_name=WCDC Beta`
   - `version=<new-version>`
   - `desktop_applaunchname=wcdc-beta.Application`
2. `app/ui/config`
   - JSON 键改为 `wcdc-beta.Application`
   - `gatewayPrefix` / `url` 改为 `/app/wcdc-beta`
   - `gatewaySocket` 保持 `app.sock`（每个应用有自己的 `TRIM_APPDEST`）
3. `cmd/main`
   - `GATEWAY_PREFIX="/app/wcdc-beta"`
4. `config/resource`
   - 数据共享目录改为 `wcdc-beta/downloads`
5. 图标、`wizard`、`cmd` 生命周期脚本按需保留或修改。
6. 打包输出改为 `packaging/fnos/wcdc-beta/wcdc-beta.fpk`，发布文件名建议 `wcdc-beta-<version>-x86.fpk`。

这样安装后：

- 桌面有两个独立入口；
- 数据目录、Socket、Cookie path、授权目录、共享目录互不覆盖；
- 升级 beta 不会影响正式版，反之亦然。

如果要改正式版版本号但保持同一应用，只改 `manifest.version` 即可，`appname` 不能变，否则会被飞牛当成新应用。

## 6. 视频转码关键实现

- 扫描：`apps/server/src/transcode/media.rs`
  - 支持按源编码筛选。
  - `ScanRequest.min_size_bytes` / 前端 `minSizeBytes`：只处理大于该大小的文件；默认 0/空 = 不限制。
  - `ScanResult.skipped_by_size` 返回被大小条件排除的数量。
  - 扫描进度：`ScanTracker` + `GET /api/transcode/scan/progress`，返回 `processed/total/cacheHits/...`；前端每 400ms 轮询。
  - 扫描结果持久化：`<数据目录>/transcode-last-scan.json`，`GET /api/transcode/scan/last` 恢复；前端同时保存选中路径到 localStorage，离开页面再回来不会重新扫描。
  - 视频扫描同样在后台任务中执行，切换标签/断开请求不会中断；前端重新进入时通过 progress 接口恢复扫描进度。
  - 扫描加速：
    1. 按文件大小预过滤，避免对明显不符合条件的文件启动 ffprobe。
    2. `scan_cache` 跨扫描保留，按 `路径 + 文件大小 + mtime` 复用上次 ffprobe 结果；未变化文件 `cacheHits` 增加、tookMs 接近 0。
    3. ffprobe 并发数按 CPU 核数动态调整，范围 4–12（`available_parallelism().clamp(4, 12)`）。
  - 任务创建复用同一份 `scan_cache` 的媒体信息，避免再次 ffprobe。
- 命令构造：`apps/server/src/transcode/command.rs`  - QSV 编码器（尤其是 `av1_qsv`）的像素格式必须是 `nv12` / `p010le`，不能是 `yuv420p`。之前 `Error while opening encoder ... av1_qsv` 的根因就是统一 `format=yuv420p`。现在 QSV 分支输出 `format=nv12`。
  - CPU 核心限制：`cpu_threads` 在输入前作为解码线程数写入一次，软件编码器在 `-c:v` 后再写入一次；硬件编码器不追加 encoder threads。
  - 硬件编码器打开失败（stderr 包含 `Error while opening encoder` 等）且没有输出时，自动切换到目标编码的软件编码器重试一次。用于驱动声明了 `av1_qsv` 但 GPU 实际不支持 AV1 编码的情况。
  - 创建任务前会先做一次 `self_test::verify_encoder` 单帧预检（按 encoder/accel/device/ffmpeg 缓存 5 分钟）。预检失败会直接改用软件编码，不再先启动一个注定失败的硬件任务。
  - 典型情况：Intel 核显只支持 AV1 解码、FFmpeg 仍报告 `av1_qsv`/`av1_vaapi`，预检会识别并回退到 `libsvtav1`。
  - CRF/CQ/global_quality/qp 映射见 `append_quality_args`。
  - 帧率：`fps` 为空/0 保持源帧率；固定值通过 `fps=24`、`fps=24000/1001` 等滤镜重采样。前端提供原始、24/25/30/60、自定义。
- 任务：`apps/server/src/transcode/job.rs`
  - 临时文件 `.part`，成功后替换；勾选删除原文件时复用原文件名并在成功后删除源文件。
  - 进度、ETA、速度、GPU 利用率通过 SSE `/api/transcode/events`。
  - 全部暂停：Unix 用 `SIGSTOP`，Windows 用 `NtSuspendProcess`；全部继续用 `SIGCONT` / `NtResumeProcess`。排队任务通过 `watch` 暂停调度。
  - API：`POST /api/transcode/jobs/pause-all`、`/resume-all`、`/cancel-all`；`GET /api/transcode/queue` 返回 `{paused,running,queued}`。
  - 断点恢复：排队/运行中的任务写入 `<数据目录>/transcode-jobs.json`，重启后自动重新入队。已完成的文件不会重复；中断中的单个文件会从开头重新转码（没有做分片级续传）。
  - 暂停状态是全局的，取消全部会同时清除暂停状态。
- 能力页：
  - 只展示能用于本页编码的加速器（vaapi/qsv/nvenc/amf/mf/videotoolbox/rkmpp/v4l2m2m）；Vulkan/OpenCL/DRM/d3d12va/nvdec 等不再显示。
  - 编解码矩阵按显卡分类，行是编码/解码，列固定为 H.264/H.265/AV1/VP9/VP8；绿勾支持、红叉不支持，CPU 软件支持单独一张表。
  - 能力列表不再包含 Apple ProRes、H.263、Theora。
- Intel Linux GPU 使用率：优先读 `gpu_busy_percent`；i915/xe 没有该文件时扫描 `/proc/*/fdinfo` 的 `drm-engine-*` busy 纳秒并做差分，来源标记为 `fdinfo`。

## 7. 图片转 WebP 实现

- 后端：`apps/server/src/images.rs`
- API：
  - `POST /api/images/scan`
  - `GET|POST|DELETE /api/images/jobs`
  - `POST /api/images/jobs/{id}/cancel`
  - `POST /api/images/jobs/{id}/retry`
  - `GET /api/images/events`（SSE）
- 前端：`web/src/components/ImageConvertPanel.tsx`，入口在转码页的“格式转换”标签。
- 编码器：`zenwebp` 纯 Rust 实现；解码常见格式使用 `image` crate。
- 支持 JPEG、PNG/APNG、GIF、BMP、TIFF、ICO、TGA、PNM、QOI、HDR、EXR、DDS、Farbfeld。`.webp` 源文件跳过。
- GIF/APNG 多帧会编码为动画 WebP。
- 默认：质量 80，有损；输出 `原文件名.webp`；转换成功后删除原图。
- 无损模式：使用 `LosslessConfig::new()`，**忽略质量滑块**；前端的质量输入会禁用。无损输出像素精确。
- 目标文件已存在时使用 `原文件名-2.webp` 等后缀，不覆盖已有文件。
- `cpuThreads` 会限制同时进行的图片编码数；`concurrency` 是上限。
- 图片任务与 ffmpeg 无关，即使没有 ffmpeg 也能使用“格式转换”标签。
- 全部完成后前端汇总源大小、输出大小和节省比例/字节数。
- 全部暂停/继续/取消：`POST /api/images/jobs/pause-all`、`/resume-all`、`/cancel-all`；`GET /api/images/queue`。暂停只阻止后续文件启动，正在编码的当前图片会完成。
- 扫描结果持久化：`<数据目录>/images-last-scan.json`，`GET /api/images/scan/last`；前端选中项存 localStorage。
- 图片扫描缓存：内存 `scan_cache` 按“路径 + 大小 + mtime”复用上次尺寸信息；重启后从 last-scan 初始化。`ImageScanResult.cacheHits` 和扫描进度都会显示缓存命中数。
- 图片扫描进度：`GET /api/images/scan/progress`；扫描在后台任务中执行，切换标签/断开请求不会中断，完成后写入 last-scan。
- 断点恢复：活动图片任务写入 `<数据目录>/image-jobs.json`，重启后自动恢复；已完成/输出已存在的图片跳过。
- 稳定性：转换有 256MB 文件上限、16384 尺寸上限、50MP 像素上限、动画 2000 帧/200MP 上限；`spawn_blocking` 内用 `catch_unwind` 将 panic 转成单任务失败，不拖垮服务。

### 7.1 转换归档日志

- 后端：`apps/server/src/history.rs`，`HistoryService` 由 `main` 创建并注入转码/图片服务。
- 持久化：`<数据目录>/conversion-history.json`，原子写入（先 `.json.tmp` 再 rename），最多保留 200 条批次，每批最多 500 条文件明细。
- 每批记录包含：kind（video/image）、设置摘要、开始/结束时间、总耗时、文件数、成功/失败/取消数、总源大小、总输出大小、节省字节/百分比、逐文件状态和错误。
- 视频批次监控在 `TranscodeService::create_jobs` 中启动；图片批次在 `ImageService::create_jobs` 中启动。监控每 400–500ms 检查一次，全部任务结束后写入归档。
- API：
  - `GET /api/history?limit=200`
  - `DELETE /api/history`
- 前端：`web/src/components/HistoryPanel.tsx`，转码页“归档日志”标签；即使没有 ffmpeg 也可查看。
- 任务列表会通过断点文件恢复；归档是跨重启保留的批次摘要。恢复的任务不会重新挂上原来的批次监控，极端情况下这一批可能没有新的归档记录。

**许可证提醒**：`zenwebp 0.4.6` 的许可证是 `AGPL-3.0-only OR LicenseRef-Imazen-Commercial`。当前项目是 MIT；将 zenwebp 静态链接进发布二进制并分发时，需要评估 AGPL 合规或购买商业授权。不要在未确认的情况下移除本说明。

## 8. 飞牛模式与安全约束

- 终端功能**必须**在“只允许内网访问”开启时才可用；服务端和前端都要检查。
- 飞牛模式下终端后端也必须拒绝，不能只靠隐藏菜单。
- 飞牛模式下所有用户可指定路径的 API 都要过 `ensure_allowed_path`：
  - 下载目标
  - 服务器文件浏览/下载/新建目录
  - 转码扫描/输出
  - 图片扫描/输出
- 授权路径来自 `TRIM_DATA_ACCESSIBLE_PATHS` 和 `TRIM_DATA_SHARE_PATHS`，用 `:` 分隔（Windows 开发环境用 `;`）。
- 没有授权目录时不要回退到全盘访问，应返回明确错误。
- 不要 kill 用户正在运行的正式服务（尤其 8787）；测试用独立端口和独立数据目录。
- 用户明确说过“不要写 md 文件我不会去看”。除非用户像本次一样明确要求写 agent 上下文，不要新增/更新 README 或说明文档。

## 9. 测试清单

提交前至少执行：

```bash
cd web && npm run build
cd .. && cargo test -p wcdc-server
```

手工冒烟重点：

1. 独立启动后注册/登录，确认新前端已嵌入（侧边栏显示 WCDC，存在“格式转换”和“归档日志”标签）。
2. 扫描视频设置最小大小，确认 `skippedBySize` 和界面提示正确；扫描过程中进度条/已分析数量更新；第二次扫描 `cacheHits > 0` 且明显更快。
3. 软件转码设置 CPU 核心限制，确认 ffmpeg 命令包含两处 `-threads` 且任务成功。
4. 转码中点击“全部暂停”，进度应停止；点击“全部继续”后继续；“全部取消”后所有活动任务变为已取消。
5. 强制选择设备不支持的硬件编码器（例如 N 卡机器选 `av1_amf`），任务创建后应直接显示软件编码器（如 `libsvtav1`），不应先产生一次硬件打开失败。
6. 图片页在暂停状态下新建任务应保持排队，继续后完成。
7. QSV 机器上选择 AV1 QSV，确认不再出现 `format=yuv420p`；如果驱动不支持，任务创建阶段就应改为软件编码。
8. 能力页不显示 Vulkan/OpenCL/DRM；编解码矩阵只有 H.264/H.265/AV1/VP9/VP8，按显卡分组，绿勾/红叉；Intel Linux 转码时 GPU 使用率不应一直为 —。
9. 图片扫描能排除 `.webp`，转换后生成 `RIFF....WEBP`，勾选删除时源文件消失，动画 GIF/APNG 帧数保留。
10. 视频/图片扫描完成后离开页面再回来，结果和选择应恢复；重启服务后 `/api/*/scan/last` 仍返回上次结果。
11. 运行中的视频/图片任务重启服务后应自动恢复；已完成文件不重复，中断文件从头重做。
12. 完成一批视频/图片后，归档日志出现一条记录，包含数量、总耗时、大小变化和逐文件明细；重启服务后记录仍在。
13. 飞牛模式：侧边栏无“服务器文件/终端”；直连路由重定向；终端 WS 403；授权目录外全部 400。
14. 飞牛网关：登录后跳转不丢 `/app/<appname>`，刷新 iframe 不白屏。

## 10. 当前发布产物

`dist/` 中的正式产物（已 gitignore，不随源码仓库提交）：

- `WCDC-<version>-windows-x64.exe`
- `WCDC-<version>-linux-x64`
- `WCDC-<version>-x86.fpk`
- `SHA256SUMS.txt`

每次重新构建后都要重新生成 `SHA256SUMS.txt`，不要沿用旧校验和。GitHub 仓库只提交源码、打包目录和 AGENTS.md，不上传 `dist/`、`target/`、`web/node_modules`、`web/dist` 或本地 Cookie/日志。
