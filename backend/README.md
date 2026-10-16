# BlockFace+ 协同后端（FastAPI）

纯前端拼图工具的多人协同房间服务：**FastAPI + SQLite + 本地文件系统**，跑在普通 VPS 上。
前端静态产物留在边缘 Pages，通过构建期变量 `VITE_API_BASE_URL` 指向这里。

接口契约是冻结的，见仓库 [docs/collab-api.md](../docs/collab-api.md) —— 改代码之前先改契约。

## 快速开始

```bash
cd backend
uv sync                          # 建 .venv + 装依赖 + 生成 uv.lock
uv run uvicorn bfp.main:app --reload --port 8088
```

```bash
curl http://127.0.0.1:8088/api/health   # {"ok":true,"version":"0.2.0"}
curl http://127.0.0.1:8088/api/config   # 公开上限，供运维核对生效值（前端产物的预检阈值是构建期常量，见 src/core/collab/api.ts）
```

也可以 `uv run python -m bfp` 自启（主机/端口取 `BF_HOST` / `BF_PORT`）。

## 目录结构

```
backend/
├── pyproject.toml          hatchling + src 布局，包名 bfp；bfp-ops 控制台脚本在这里声明
├── .env.example            全部环境变量与默认值（只有这里列的变量会被读取）
├── src/bfp/
│   ├── main.py             create_app + lifespan + CORS + 错误处理器 + /api/health、/api/config
│   ├── __main__.py         python -m bfp
│   ├── config.py           Settings（环境变量 → 不可变配置对象）
│   ├── db.py               aiosqlite 单连接 + WAL + 写锁 + transaction()
│   ├── schema.sql          rooms / room_base / avatars / room_throttle
│   ├── security.py         scrypt 哈希与校验、密码生成、房间号、失败限流
│   ├── normalize.py        与旧实现同口径的归一化（夹取区间、只认白名单 data URI）
│   ├── storage.py          底图字节落盘（临时文件 + os.replace 原子写）
│   ├── rooms.py            POST/GET/DELETE /api/rooms
│   ├── avatars.py          PATCH /api/rooms/{id}/avatars（差量提交）
│   ├── base.py             GET/POST /api/rooms/{id}/base
│   ├── sweep.py            后台清扫 + delete_room
│   ├── ops.py              bfp-ops 命令行
│   └── errors.py           ApiError 与 {"error": "..."} 统一形状
└── tests/                  pytest + httpx ASGITransport，每个用例独立临时数据目录
```

## 环境变量

全部变量、默认值与含义见 [.env.example](.env.example)，也可以直接读 `GET /api/config`。
两条最容易踩的：

- `BF_DATA_DIR`（默认 `./data`）：**相对路径一律相对 backend/ 目录解析**，与启动时的 cwd 无关。
  也就是说默认值永远落在 `backend/data`。生产建议写绝对路径（如 `/var/lib/blockface-plus`）。
  库文件固定在 `{BF_DATA_DIR}/bfp.sqlite3`，底图固定在 `{BF_DATA_DIR}/base/{roomId}.{ext}`。
- 非法整数会让服务**起不来**并打印中文原因（fail fast）。宁可起不来，也不要带着错配置跑。

## 数据与存储

| 表 | 用途 |
| :-- | :-- |
| `rooms` | 房间身份：房间号、创建/过期时间、两个密码的 scrypt 哈希与长度 |
| `room_base` | 底图指针 + 画布尺寸 + 房间状态（`draft` / `ready`） |
| `avatars` | 一个头像一行：布局列 + 皮肤 JSON + 两个版本戳（`skin_updated_at` / `layout_updated_at`） |
| `room_throttle` | 按房间的密码试错计数与锁定截止时间 |

- SQLite 开 WAL、`busy_timeout=5000`、`foreign_keys=ON`；单连接 + 写锁，所有写路径都走 `transaction()`。
- 底图字节**不进数据库**，落 `{BF_DATA_DIR}/base/{roomId}.{ext}`；写入是"临时文件 → fsync → os.replace"，
  所以不会出现"库里指针指向半张图"。同一间房同一后缀只有一个文件，换底图会覆盖并清掉其它后缀。
- 备份 = 拷 `BF_DATA_DIR` 整个目录（库 + base/）。热备份时先 `sqlite3 bfp.sqlite3 ".backup ..." ` 或直接停服。

## 运维命令行

`bfp-ops` 由 `uv sync` 装进 `.venv`，也可以在仓库根用 `uv run --directory backend bfp-ops ...`。

```bash
bfp-ops list [--json]                  # 所有房间：状态 / 层数 / 过期时间
bfp-ops inspect <roomId> [--json]      # 单房间详情（含底图文件是否真的在盘上）
bfp-ops delete <roomId> --yes          # 删房间（不加 --yes 直接拒绝）
bfp-ops sweep [--dry-run]              # 立刻清扫：过期房 + 超时草稿房
```

全局 `--data-dir DIR` 可覆盖 `BF_DATA_DIR`（放在子命令前或后都行）。
退出码：`0` 成功、`1` 房间不存在、`2` 用法或确认开关缺失。

后台清扫由 `BF_SWEEP_INTERVAL_SECONDS`（默认 1800 秒，`0` 关闭）驱动，
启动时先扫一轮，关停时优雅取消。

## 测试

```bash
cd backend
uv run pytest -q
```

每个用例用独立的 `tmp_path` 作为 `BF_DATA_DIR`，直接通过 httpx 的 `ASGITransport` 打 app
（不起真进程、不占端口），覆盖建房校验、草稿→上传→就绪全链路、差量提交的权限与版本冲突、
底图上传下载与体积上限、密码试错限流、过期与清扫、非法房间号等。

## 安全要点

- 密码只在创建响应里出现一次；库里只有 `scrypt$n$r$p$salt$hash`，校验用 `hmac.compare_digest`。
  校验前先按长度筛（编辑 8 位 / 管理员 12 位），长度不对的尝试零成本，也不占 CPU。
- scrypt 是阻塞的 CPU 活，全部 `asyncio.to_thread` 丢出事件循环。
- 密码只走 `X-BF-Room-Pwd` 请求头，绝不进 URL / query / 日志。
- 房间号先按 `^[A-Za-z0-9_-]{6,64}$` 校验再进 SQL 与文件路径，杜绝路径穿越。
- 底图类型按**字节魔数**判定，不信客户端声明的 Content-Type；响应带 `X-Content-Type-Options: nosniff`。
- CORS 按 `BF_CORS_ORIGINS` 配置；本应用不用 cookie，所以 `allow_credentials` 恒为 `False`。

## 生产部署

systemd + nginx 的样例文件在仓库 [deploy/](../deploy/) 下，部署步骤见 [docs/deploy-vps.md](../docs/deploy-vps.md)。

```bash
uv sync --frozen --no-dev          # 生产只装主依赖，不装 pytest/httpx
.venv/bin/uvicorn bfp.main:app --host 127.0.0.1 --port 8088
```
