# Linux 支持说明

`WCDC` 的后端是 Rust（tokio + axum + reqwest/rustls + sqlx/sqlite），前端资源在编译时嵌入二进制，Windows 和 Linux 使用同一套代码。`dist/` 中提供静态链接 musl 的 Linux 单文件；也可以在 Linux 本机构建，或从 Windows 通过 `cargo-zigbuild` 交叉编译。

## 构建与运行（Ubuntu / Debian）

```bash
sudo apt update
sudo apt install -y build-essential pkg-config curl git

# Rust（如果尚未安装）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node.js 20+（nvm 或 NodeSource 均可）

git clone <this repo> WCDC
cd WCDC/web
npm install
npm run build
cd ..
cargo build --release -p wcdc-server
./target/release/wcdc-server

# 或构建静态 musl 单文件（需要 cargo-zigbuild + zig）
cargo zigbuild --release -p wcdc-server --target x86_64-unknown-linux-musl
# 产物：target/x86_64-unknown-linux-musl/release/wcdc-server
```

打开 `http://127.0.0.1:8787`。第一次启动会创建：

- 数据目录：`$XDG_DATA_HOME/wcdc`，通常是 `~/.local/share/wcdc`
- 默认下载目录：`<数据目录>/downloads`
- `volumes.json`：可选的快捷存储盘列表

## 磁盘枚举

Linux 下 `/api/storage/roots` 会：

1. 总是返回 `/`；
2. 读取 `/proc/mounts`，过滤 `proc/sysfs/tmpfs/devtmpfs/cgroup/overlay/squashfs/...` 等伪文件系统；
3. 返回真实挂载点（ext4/xfs/btrfs/nfs/cifs/zfs/fuse 等），并按挂载点去重；
4. 使用 `statvfs`（经 `fs2`）读取容量与可用空间。

因此普通磁盘、数据盘、NAS 挂载（NFS/CIFS）、SSHFS/rclone 挂载都会出现在“全部磁盘 / 挂载点”列表中。若某个目录没有出现在列表里，可以直接在路径输入框中输入绝对路径（例如 `/srv/media/Quark`）回车前往。

Windows 对应枚举 `C:\`..`Z:\` 盘符。

## 权限

服务进程只能写入运行用户有权限的目录：

```bash
sudo mkdir -p /srv/media/Quark
sudo chown -R quark:quark /srv/media/Quark
# 如果使用 systemd 的 User=quark
```

`/`、`/home` 等根目录通常显示“不可写”，这是正常的；进入有权限的子目录后即可选择。

SELinux（Fedora/RHEL）或 AppArmor（Ubuntu）可能限制服务写入某些路径，必要时为服务进程配置相应策略，或把下载目录放到服务自己的数据目录下。

## 站点登录与日志

- 第一次启动后访问 `http://127.0.0.1:8787`，页面只显示“设置访问密码”；注册后所有 API 才可用。
- 密码使用 Argon2id 哈希保存在 `<数据目录>/wcdc.db` 的 `settings.web_password_hash`。
- 站点会话在内存中，重启服务后需要重新输入密码；夸克账号 Cookie 不受影响。
- 「服务器文件 / 已下载文件 / 日志 / 设置」在站点登录后即可使用；「夸克网盘 / 传输中心 / 回收站」还需要扫码绑定夸克账号。
- 日志页面读取内存中最近 3000 条，同时追加写入 `<数据目录>/server.log`；日志文件超过 5 MB 会在下次启动时轮换为 `server.log.1`。
- 忘记密码：停止服务后执行
  ```bash
  sqlite3 ~/.local/share/wcdc/wcdc.db \
    "DELETE FROM settings WHERE key='web_password_hash';"
  ```
  然后重新启动并注册。该操作不会删除夸克账号、任务或下载文件。

## systemd 示例

```ini
[Unit]
Description=WCDC (Quark Drive web UI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=quark
Group=quark
WorkingDirectory=/opt/wcdc
Environment=WCDC_BIND=127.0.0.1:8787
Environment=WCDC_DATA_DIR=/var/lib/wcdc
ExecStart=/opt/wcdc/wcdc-server
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
# 允许写入自己的数据目录与下载目录
ReadWritePaths=/var/lib/wcdc /srv/media/Quark

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wcdc
sudo journalctl -u wcdc -f
```

如果前面用 Nginx/Caddy 反向代理，请加上认证与 HTTPS。服务端默认只监听 `127.0.0.1`。

## 与 Windows 的差异

| 项目 | Windows | Linux |
| --- | --- | --- |
| 磁盘列表 | `C:\`..`Z:\` | `/` + `/proc/mounts` 中的真实挂载点 |
| 默认数据目录 | `%APPDATA%\wcdc` | `$XDG_DATA_HOME/wcdc` 或 `~/.local/share/wcdc` |
| 路径分隔符 | `\` | `/` |
| 可执行文件 | `wcdc-server.exe` | `wcdc-server` |
| Cookie 文件权限 | 依赖用户目录 ACL | 0600 |

前端不做任何路径拼接，所有路径都来自后端，因此两种平台的目录浏览、默认位置、下载落盘逻辑一致。

## 验证

```bash
# 健康检查
curl http://127.0.0.1:8787/api/health

# 查看磁盘/挂载点
curl http://127.0.0.1:8787/api/storage/roots

# 浏览目录
curl "http://127.0.0.1:8787/api/storage/browse?path=/srv/media"

# 单元测试
cargo test -p quark-protocol -p quark-core
```
