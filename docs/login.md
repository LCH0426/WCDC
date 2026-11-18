# 夸克扫码登录机制

本文记录 `WCDC` / `quark-protocol` 实际使用的登录流程。实现代码：

- `crates/quark-protocol/src/auth.rs` — 二维码申请、轮询、票据交换
- `crates/quark-protocol/src/session.rs` — Cookie 容器与轮换
- `crates/quark-core/src/lib.rs` — 登录会话编排、账号落库

## 1. 申请二维码 token

```http
GET https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin
    ?client_id=532
    &v=1.2
    &request_id=<uuid-v4>
Accept: application/json, text/plain, */*
Referer: https://pan.quark.cn/
User-Agent: <桌面 Chrome UA>
```

响应关键字段：

```json
{
  "status": 2000000,
  "data": { "members": { "token": "sta..." } }
}
```

- `status != 2000000` 视为申请失败。
- `data.members.token` 是二维码 token。
- 这是一个带 Cookie Jar 的 `reqwest::Client`，后续轮询和票据交换必须复用同一个 Jar。

## 2. 生成二维码内容

```text
https://su.quark.cn/4_eMHBJ
  ?token=<token>
  &client_id=532
  &ssb=weblogin
  &uc_param_str=
  &uc_biz_str=S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0
```

前端用 `qrcode.react` 把这段 URL 画成二维码。二维码有效期约 **180 秒**（`QR_LOGIN_TTL_MS`），由服务端同时做超时控制。

## 3. 轮询扫码状态

```http
GET https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken
    ?client_id=532
    &v=1.2
    &token=<token>
    &request_id=<每次新的 uuid>
```

`status`（可能在顶层，也可能在 `data.status`）含义：

| 值 | 含义 |
| --- | --- |
| `50004001` | 等待扫码 / 等待确认 |
| `50004002` | 二维码已过期 |
| `2000000` | 已确认，`data.members.service_ticket` 为一次性票据 |

前端每 1.2 秒调用一次后端 `GET /api/login/qr/{sessionId}`；后端内部再向夸克轮询。服务端到达 `expiresAt` 后会直接返回 `expired`，并丢弃该会话。

## 4. 用票据换 Cookie

```http
GET https://pan.quark.cn/account/info?st=<service_ticket>&lw=scan
```

这一步的响应体不是重点，重点是响应头里的 `Set-Cookie`。Cookie Jar 会收集：

- `__pus`、`__puus`（登录态核心；`__puus` 会随请求轮换）
- `__uid`、`__kps`、`__kp`、`__uidc`
- `b-user-id`、`is_star`

随后把 Jar 中这些 Cookie 拼成 `name=value; ...`，交给 `Session::from_cookie_header`。只要存在非空的 `__pus` 或 `__puus` 就认为已登录。

如果 `st` 无效，`account/info` 会返回 `{"success": false, "code": ..., "msg": ...}`，后端会把它当作登录失败，而不是继续使用空会话。

## 5. 后续网盘请求

所有网盘 API 都带同一串 Cookie，并固定加：

```text
Origin: https://pan.quark.cn
Referer: https://pan.quark.cn
Cookie: __pus=...; __puus=...; __uid=...
```

域名与路径：

- `https://drive.quark.cn/1/clouddrive/...`
- `https://drive-pc.quark.cn/1/clouddrive/...`
- 查询参数固定 `pr=ucpro&fr=pc`

每次响应后都会执行 `Session::apply_headers`，如果响应里又下发了新的 `__puus` 等 Cookie，就更新内存会话；`quark-core` 会把最新 Cookie 写回加密/本地凭据文件（`secrets.json`，Unix 下 0600）。

## 6. 会话与账号

- 登录成功后调用 `GET /1/clouddrive/member` 和 `/account/info` 获取昵称、头像、会员类型、容量。
- 账号以 `uid` 为 ID 落库；没有 `uid` 时用 Cookie 的 SHA-256 前缀生成本地 ID。
- Cookie 不写入 SQLite，只写入数据目录下的 `secrets.json`；数据库只存 `cookie_ref`。
- 应用重启后从 SQLite 恢复账号，从 `secrets.json` 读回 Cookie；只有在接口返回 401/31001 等鉴权错误时才需要重新扫码。

## 7. 为什么浏览器拿不到 Cookie

二维码申请、轮询、票据交换、Cookie 收集全部在 Rust 服务端完成。浏览器只拿到：

```json
{ "sessionId": "...", "qrUrl": "https://su.quark.cn/4_eMHBJ?token=...", "expiresAt": 179... }
```

这样避免了跨域、CORS 和把登录 Cookie 暴露给前端脚本。

## 8. 本地验收

```bash
curl -X POST http://127.0.0.1:8787/api/login/qr
# 用返回的 qrUrl 生成二维码并扫码
curl http://127.0.0.1:8787/api/login/qr/<sessionId>
```

未扫码时返回 `{"state":"waiting"}`；成功后返回 `{"state":"success","account":{...}}`，同时 `/api/bootstrap` 的 `accounts` 会多出账号。
