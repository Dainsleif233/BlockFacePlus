# BlockFace+ 协同后端 API 契约（FastAPI 版）

> 本文件是 **冻结契约**：前端、后端、e2e 与部署文档都以此为准。
> 变更必须先改本文件，再改实现。

## 1. 总览

- 后端：FastAPI + uvicorn，Python 3.12+，环境用 `uv` 管理（`backend/pyproject.toml` + `uv.lock`）。
- 存储：SQLite（WAL，元数据）+ 本地文件系统（底图字节）。**不再依赖 EdgeOne Blob，也没有预签名直传。**
- 前端：纯静态 SPA，部署在边缘 Pages；通过构建期变量 `VITE_API_BASE_URL` 指向 VPS 后端。
- 鉴权：密码走自定义请求头 `X-BF-Room-Pwd`，**绝不进 URL / query / 日志**。
- 跨域：后端按 `BF_CORS_ORIGINS` 配置 CORS，允许方法 `GET/POST/PATCH/DELETE/OPTIONS`，
  允许头 `X-BF-Room-Pwd, Content-Type`，暴露头 `X-BF-Base-Name`。
- 错误响应统一为 `{"error": "<中文人话>"}`，HTTP 状态码语义：
  `400` 入参不合法 / `401` 密码不对 / `403` 角色不够 / `404` 房间不存在 /
  `409` 状态未就绪 / `410` 房间已过期 / `413` 体积超限 / `429` 试错太频繁。

### 1.1 URL 前缀

前端把所有请求发到 `${VITE_API_BASE_URL}` + `/api/...`。
`VITE_API_BASE_URL` 为空字符串时表示同源（本地开发经 Vite 代理）。**末尾不带斜杠。**

## 2. 端点

### 2.1 `POST /api/rooms` — 创建房间（草稿态）

请求 `application/json`：

```jsonc
{
  "baseImage": { "name": "底图.png", "type": "image/png", "width": 1920, "height": 1080 },
  "layers": [ /* RoomAvatarDraft[]，至少 1 条 */ ],
  "expiresDays": 7
}
```

响应 `201`：

```jsonc
{ "roomId": "xxxxxxxxxxxx", "editPassword": "8位", "adminPassword": "12位", "expiresAt": 1760000000000 }
```

- 房间初始状态是 `draft`；底图由 2.5 上传后才变 `ready`。
- `expiresDays` 取值 `1..BF_MAX_EXPIRY_DAYS`（默认 3650），前端 UI 提供 `3/7/14/30/90`。
- 请求体大小上限 `BF_MAX_JSON_BODY_BYTES`（默认 256MiB），超限 413。

### 2.2 `GET /api/rooms/{roomId}` — 进房快照

请求头：`X-BF-Room-Pwd`。响应 `200`：

```jsonc
{
  "room": {
    "roomId": "...",
    "doc": { "width": 1920, "height": 1080 },
    "baseImage": { "name": "底图.png", "type": "image/png", "width": 1920, "height": 1080 },
    "createdAt": 1760000000000,
    "expiresAt": 1760604800000,
    "status": "ready"
  },
  "avatars": [ /* RoomAvatarRecord[]，按 order 升序 */ ],
  "role": "editor"      // "editor" | "admin"
}
```

### 2.3 `DELETE /api/rooms/{roomId}` — 删除房间（仅管理员）

响应 `200`：`{ "ok": true }`。物理清空该房间的全部行与底图字节。

### 2.4 `PATCH /api/rooms/{roomId}/avatars` — 差量提交（唯一的写头像入口）

请求 `application/json`：

```jsonc
{
  "updates": [{ "id": "l1", "layout": { "x": 10 }, "skin": { /* PresetSkin */ },
                "expectLayoutUpdatedAt": 1760000000000, "expectSkinUpdatedAt": 1760000000000 }],
  "adds":    [ /* RoomAvatarDraft 全量一行 */ ],
  "deletes": ["l2"]
}
```

响应 `200`：`{ "results": [{ "id": "l1", "ok": true, "skinUpdatedAt": 1, "layoutUpdatedAt": 1 }] }`

三条铁律（与旧实现一致）：
1. 只写请求里真的提到的行；
2. 行内按字段域写：`layout` 补丁只覆盖布局字段，`skin` 只覆盖皮肤字段，两个版本戳各管各的；
3. 缺的键不动（不是用默认值补齐）。

角色约束：编辑者只能 `updates[].skin`；带 `layout` 一律忽略（不报错），带 `adds`/`deletes` 返回 403。
单条结果 `error` 取值：`invalid | invalid-layout | invalid-skin | not-found | exists | conflict`。

### 2.5 `POST /api/rooms/{roomId}/base` — 上传 / 更换底图

`multipart/form-data`，字段：

| 字段 | 类型 | 说明 |
| :-- | :-- | :-- |
| `file` | file | 底图字节，必填，只接受 PNG / JPEG / WebP / GIF |
| `name` | str | 原始文件名（可含中文），必填 |
| `width` | int | 画布宽（= 底图宽），必填 |
| `height` | int | 画布高，必填 |

请求头：`X-BF-Room-Pwd`。角色：草稿期编辑者或管理员皆可；房间 `ready` 后仅管理员。
客户端**不要**手写 `Content-Type`：交给浏览器带上 multipart 的 boundary，否则后端解不出表单。

响应 `200`：

```jsonc
{ "ok": true, "doc": { "width": 1920, "height": 1080 },
  "baseImage": { "name": "底图.png", "type": "image/png", "width": 1920, "height": 1080 } }
```

同一个房间、同一个后缀只对应一个存储文件；换底图是**覆盖 + 清理其它后缀**，不留孤儿文件。

### 2.6 `GET /api/rooms/{roomId}/base` — 取底图字节

请求头：`X-BF-Room-Pwd`。响应 `200` 为原始字节，响应头：

- `Content-Type: <底图 MIME>`
- `X-BF-Base-Name: <percent-encoded UTF-8 文件名>`（响应头不允许非 ASCII，前端 `decodeURIComponent` 解回）
- `X-Content-Type-Options: nosniff`
- `Cache-Control: private, max-age=60`

草稿态（底图未上传）返回 `409`。

### 2.7 `GET /api/health`

响应 `200`：`{ "ok": true, "version": "0.2.0" }`。无需鉴权，供反代/监控探活。

### 2.8 `GET /api/config`

响应 `200`（无需鉴权，只回公开上限，供前端展示与运维自查）：

```jsonc
{
  "version": "0.2.0",
  "expiryDays": [3, 7, 14, 30, 90],
  "maxExpiryDays": 3650,
  "maxLayers": 10000,
  "maxBaseImageBytes": 134217728,
  "maxSkinDataUrlChars": 32000000,
  "maxJsonBodyBytes": 268435456,
  "maxDocSize": 65536,
  "minLayerSize": 1,
  "maxLayerSize": 262144,
  "maxAvatarName": 512,
  "maxPosition": 10000000
}
```

## 3. 数据结构

### RoomAvatarRecord
```ts
{ id, name, x, y, size, rotation, opacity, overlay, flipH, visible, order,
  skin: PresetSkin | null, skinUpdatedAt: number, layoutUpdatedAt: number }
```

### RoomAvatarDraft
`RoomAvatarRecord` 去掉 `skinUpdatedAt` / `layoutUpdatedAt`（版本戳由服务端生成）。

### PresetSkin
```ts
{ dataUrl: string /* data:image/(png|jpeg|webp);base64,... */, width: number, height: number,
  isCustomImage?: boolean, frontOnly?: boolean }
```

### LayoutPatch
可选键：`name, x, y, size, rotation, opacity, overlay, flipH, visible, order`。没带的键服务端一律不动。

## 4. 上限（放宽后的默认值，全部可用环境变量覆盖）

| 环境变量 | 默认值 | 旧 EdgeOne 版本 | 说明 |
| :-- | --: | --: | :-- |
| `BF_MAX_LAYERS` | 10000 | 512 | 一间房最多多少行头像 |
| `BF_MAX_SKIN_DATA_URL_CHARS` | 32000000 | 1500000 | 单条内嵌皮肤 data URI 字符数 |
| `BF_MAX_BASE_IMAGE_BYTES` | 134217728 (128MiB) | 10485760 | 底图字节上限 |
| `BF_MAX_DOC_SIZE` | 65536 | 8192 | 画布边长上限 |
| `BF_MAX_POSITION` | 10000000 | 32768 | 图层坐标绝对值上限 |
| `BF_MIN_LAYER_SIZE` / `BF_MAX_LAYER_SIZE` | 1 / 262144 | 16 / 4096 | 图层尺寸区间 |
| `BF_MAX_AVATAR_NAME` | 512 | 200 | 头像名长度 |
| `BF_MAX_JSON_BODY_BYTES` | 268435456 (256MiB) | 6MiB（平台硬限） | JSON 请求体上限 |
| `BF_MAX_EXPIRY_DAYS` | 3650 | 14 | 过期天数上限 |
| `BF_AUTH_WINDOW_SECONDS` | 60 | 60 | 失败限流窗口 |
| `BF_AUTH_MAX_FAILS` | 20 | 10 | 窗口内允许的失败次数 |
| `BF_DRAFT_TTL_SECONDS` | 86400 | — | 建房后没传底图的草稿房多久清理 |
| `BF_SWEEP_INTERVAL_SECONDS` | 1800 | — | 后台清扫间隔（0 = 关闭） |

其它环境变量：

| 变量 | 默认值 | 说明 |
| :-- | :-- | :-- |
| `BF_DATA_DIR` | `./data` | SQLite 与底图字节的根目录（生产建议 `/var/lib/blockface-plus`） |
| `BF_CORS_ORIGINS` | `*` | 逗号分隔的来源白名单，生产建议填 Pages 域名 |
| `BF_HOST` / `BF_PORT` | `127.0.0.1` / `8088` | 仅 `python -m bfp` 自启时使用 |
| `BF_TRUSTED_HOSTS` | `*` | 逗号分隔 |

## 5. 本地开发与部署

```bash
# 后端（默认 127.0.0.1:8088）
cd backend
uv sync
uv run uvicorn bfp.main:app --reload --port 8088

# 前端（Vite 把 /api 代理到 127.0.0.1:8088）
pnpm dev
```

部署细节见 [deploy-vps.md](deploy-vps.md)。
