<!-- BlockFace+ · Copyright 2026 Dainsleif · Apache License 2.0 -->
# BlockFace+ · 自建 VPS 部署指南（FastAPI 后端 + 边缘 Pages 前端）

> 接口、上限、错误码的**定义**在 [collab-api.md](collab-api.md)（冻结契约）；本文只回答「怎么把它跑起来」。
> 所有命令都可以照抄 —— 需要替换的地方（域名、仓库地址、用户名）都写成了 `api.example.com` 这种显眼的样子。
>
> 部署形态：**一台普通 VPS 跑后端（uvicorn 只听回环，nginx 对外），前端静态产物留在边缘 Pages。**

```
浏览器
  │  ① 静态资源（html/js/css）          ┌─ 边缘 Pages（dist/ 产物，CSP 里放行 api 域名）
  ├───────────────────────────────────▶│
  │  ② fetch https://api.example.com/api/...
  ▼
nginx（TLS + client_max_body_size 256m + 透传 X-BF-Room-Pwd）
  │  proxy_pass http://127.0.0.1:8088
  ▼
uvicorn（FastAPI 应用，单进程）
  │
  ▼
/var/lib/blockface-plus/
  ├─ bfp.sqlite3     SQLite（WAL）：房间、头像行、密码哈希、限流状态
  └─ base/           底图字节（一间房一个文件：{房间号}.{后缀}）
```

**为什么这么拆**：底图与皮肤都是用户素材，单条最大可以到 128MiB（底图）与 32M 字符（内嵌皮肤），
这种体量走云函数会一路撞平台硬限；放到自己的 VPS 上，限制只剩「磁盘」和「你愿意在 nginx 上放开多大请求体」。
静态产物留在边缘 Pages 则是因为它本来就该在那儿 —— 一个 CDN 就能解决的问题不必占用后端带宽。

---

## 0. 前置条件

- 一台 Debian 12 / Ubuntu 22.04+ 的 VPS（其它发行版同理，包管理命令自己换）
- 一个指向它的域名，例：`api.example.com`
- root 或 sudo
- 磁盘：日常十人用量是几十 MB 量级；单张底图上限 128MiB、单条头像上限 32M 字符，所以按「你会传多大的图」估，给 `/var/lib` 留 10～20GB 很宽裕。

---

## 1. 服务器准备

### 1.1 基础包

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nginx sqlite3
```

`sqlite3` 命令行不是运行时依赖，是给**备份**（`VACUUM INTO`）和**排错**（`PRAGMA integrity_check`、`.tables`）用的。

### 1.2 建一个只跑服务的系统账号

```bash
# 这个 home 不是给人登录用的，是给 uv 放「托管 Python 解释器」的，必须有
sudo useradd --system --create-home --home-dir /home/blockface --shell /usr/sbin/nologin blockface
# 代码目录（数据目录交给 systemd 的 StateDirectory 自动建，见第 4 节）
sudo install -d -o blockface -g blockface -m 0755 /srv/blockface-plus
```

uvicorn 是要暴露在公网上的网络服务，不该以 root 跑。给它一个 `nologin` 的系统账号，
出事时的影响面就只有 `/srv/blockface-plus` 和 `/var/lib/blockface-plus` 这两块。
需要以这个身份手工执行运维命令时用 `sudo -u blockface ...`，不要为了省事给它开登录 shell。

### 1.3 安装 uv

```bash
# 官方安装脚本。UV_INSTALL_DIR 让它装进 /usr/local/bin —— systemd 那份 unit 才能直接找到它
curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh
uv --version
```

不加 `UV_INSTALL_DIR` 时脚本默认装到 `~/.local/bin`，systemd 以固定 PATH 启动进程，**找不到它**。
真装到别处了就把 unit 里 `ExecStart` 的 `/usr/local/bin/uv` 换成绝对路径。

uv 会自己下载合适的 CPython（`backend/pyproject.toml` 要求 3.12+），**不需要** apt 装 Python。
发行版自带 3.11 也能跑，只是 uv 会另下一份托管解释器（这也是 1.2 那个 home 目录存在的理由）。

---

## 2. 拉代码并同步依赖

```bash
# 目标目录必须不存在或为空；这一步以 blockface 身份做，免得后面还要 chown 一遍
sudo -u blockface git clone https://github.com/Dainsleif233/BlockFace.git /srv/blockface-plus

cd /srv/blockface-plus
sudo -u blockface env HOME=/home/blockface /usr/local/bin/uv sync --frozen --no-dev --directory backend
```

- `--frozen`：严格按 `uv.lock` 装，不许顺手更新锁文件。生产机上「跑的就是锁文件里那一套」这条线不能松。
- `--no-dev`：只装 `[project.dependencies]`（fastapi / uvicorn / aiosqlite / python-multipart / pydantic），
  不装 `[dependency-groups] dev` 里的 pytest / httpx 那套。服务器上没有任何东西需要它们。
- `env HOME=/home/blockface`：sudo 默认会重置环境，而 uv 的托管解释器与缓存都按 HOME 定位；显式给上比猜它读了谁的 `.bashrc` 靠谱。
- `--directory backend`：等价于先 `cd backend`，这样命令在仓库根目录就能跑（README 的脚本表里也是这个写法）。

同步完确认环境真的建出来了：

```bash
ls -l /srv/blockface-plus/backend/.venv/bin/python   # 是个软链接，指向 uv 托管的那份 python 3.12+
```

> 以后的升级都是同一个动作：`git pull` → 上面那条 `uv sync --frozen --no-dev` → `systemctl restart`。
>
> 想在服务器上跑一遍后端自己的测试（可选，装了 dev 组才跑得动）：
> `sudo -u blockface env HOME=/home/blockface /usr/local/bin/uv sync --frozen --directory backend && sudo -u blockface /usr/local/bin/uv run --directory backend pytest -q`。
> 跑完不用手工收拾：下一次 `systemctl restart` 时 `ExecStart` 里的 `--no-dev` 会再把那套测试依赖摘掉。

---

## 3. 环境变量：`/etc/blockface-plus/api.env`

样例文件是 [deploy/blockface-plus.env.example](../deploy/blockface-plus.env.example)，每一项的中文解释都写在样例里。
后端仓库里另有一份 [backend/.env.example](../backend/.env.example) 与 [backend/README.md](../backend/README.md)，
列的是同一套变量（给「只跑后端、不碰部署」的人看），两份没有口径差异 —— 真对不上时以 `backend/src/bfp/config.py` 为准。

```bash
sudo install -d -m 0750 -o root -g blockface /etc/blockface-plus
sudo install -m 0640 -o root -g blockface deploy/blockface-plus.env.example /etc/blockface-plus/api.env
sudoedit /etc/blockface-plus/api.env        # 至少改 BF_DATA_DIR 与 BF_CORS_ORIGINS
```

改完**必须重启**服务：systemd 的 `EnvironmentFile` 只在进程启动时读一次，`reload` 不会重读。

```bash
sudo systemctl restart blockface-plus-api
```

### 3.1 变量逐项说明

带「默认值」的那列就是**不写时的行为**。标 ★ 的两个是必须改的。

| 变量 | 默认值 | 含义与什么时候要动它 |
| :-- | :-- | :-- |
| ★ `BF_DATA_DIR` | `./data` | SQLite 与底图的根目录。生产固定 `/var/lib/blockface-plus`，必须与 unit 里的 `StateDirectory=blockface-plus` 一致（systemd 就是按这个名字建目录并授权的）。放在代码目录里，迟早会被某次 `git clean` 或重新部署顺手带走。 |
| ★ `BF_CORS_ORIGINS` | `*` | 逗号分隔的浏览器来源白名单，**只写 scheme+host+port，不带路径、不带结尾斜杠**。同一个 Pages 站点有多个域名（自定义域 + 平台域）就都写上。默认 `*` 只适合本机联调。 |
| `BF_TRUSTED_HOSTS` | `*` | 允许的 Host 头，逗号分隔。走 nginx 时可以收成后端域名；守着 IP 直连 uvicorn 的场景才需要它。 |
| `BF_MAX_LAYERS` | `10000` | 一间房最多多少行头像（旧版本 512）。这个值决定一次进房要读多少行，影响的是**进房速度**而不是容量。 |
| `BF_MAX_SKIN_DATA_URL_CHARS` | `32000000` | 单条内嵌皮肤的 data URI 字符数。皮肤是内嵌在行里的，加大它等于加大数据库（与每次进房的响应体）。 |
| `BF_MAX_BASE_IMAGE_BYTES` | `134217728`（128MiB） | 底图字节上限。**改大必须同步改 nginx 的 `client_max_body_size`**。 |
| `BF_MAX_JSON_BODY_BYTES` | `268435456`（256MiB） | JSON 请求体上限（旧云函数版本受平台硬限只有 6MiB）。批量首刷几千行头像时它才是天花板；**同样受 nginx `client_max_body_size` 约束**。 |
| `BF_MAX_DOC_SIZE` | `65536` | 画布边长上限。 |
| `BF_MAX_POSITION` | `10000000` | 图层坐标绝对值上限。 |
| `BF_MIN_LAYER_SIZE` / `BF_MAX_LAYER_SIZE` | `1` / `262144` | 图层尺寸区间。 |
| `BF_MAX_AVATAR_NAME` | `512` | 头像名长度上限（名字每次进房都会回给所有人，留上限是防灌字节）。 |
| `BF_MAX_EXPIRY_DAYS` | `3650` | 建房时可选的最长过期天数（前端 UI 只给 3/7/14/30/90）。 |
| `BF_AUTH_WINDOW_SECONDS` | `60` | 密码试错限流窗口。 |
| `BF_AUTH_MAX_FAILS` | `20` | 窗口内允许的失败次数，超了回 429。按**房间**计数，不是按 IP。 |
| `BF_DRAFT_TTL_SECONDS` | `86400` | 建了房但一直没传底图的草稿房，多久算废弃。 |
| `BF_SWEEP_INTERVAL_SECONDS` | `1800` | 后台清扫间隔，设 `0` 完全关掉。 |
| `BF_HOST` / `BF_PORT` | `127.0.0.1` / `8088` | 只在不用 systemd、直接 `python -m bfp` 自启时生效；unit 里把 `--host/--port` 写在 `ExecStart` 上，所以这里改了不影响 systemd。 |

### 3.2 三个容易踩的语法坑

1. **这是 systemd 的 EnvironmentFile，不是 shell 脚本**：一行一个 `KEY=VALUE`，不要写 `export`、不要写 `$(...)`；
   systemd 也不会展开 `$别的变量`，值写什么就是什么。
2. **行尾注释会被算进值里**：只有**整行**以 `#` 或 `;` 开头才被当成注释。
   `BF_CORS_ORIGINS=https://a.example.com  # 我的站点` 得到的是后面连着注释的一整串，
   CORS 会直接失效而且看不出原因 —— 注释请单独占一行。
3. **引号会被去掉，别把它当保险**：systemd 支持 shell 风格的引号（`BF_CORS_ORIGINS="*"` 与 `BF_CORS_ORIGINS=*` 等价），
   所以加引号不会出错；但也正因为会被去引号，值里真要带引号时得写成 `\"` 转义。
   这份样例与 `deploy/blockface-plus.env.example` 一律不加引号，省得纠结。

---

## 4. systemd 常驻

```bash
sudo install -m 0644 deploy/blockface-plus-api.service /etc/systemd/system/blockface-plus-api.service
sudoedit /etc/systemd/system/blockface-plus-api.service   # 核对 User 与 /srv/blockface-plus 路径
sudo systemctl daemon-reload
sudo systemctl enable --now blockface-plus-api
systemctl status blockface-plus-api --no-pager
```

日常三条：

```bash
sudo systemctl restart blockface-plus-api        # 改完 api.env 或拉完代码
journalctl -u blockface-plus-api -f              # 实时看日志
journalctl -u blockface-plus-api -n 200 --since "-30min" --no-pager
```

启动后先在**服务器本机**确认后端是活的（这一步不经过 nginx，能立刻把「后端问题」和「反代问题」分开）：

```bash
curl -s http://127.0.0.1:8088/api/health     # {"ok":true,"version":"..."}
curl -s http://127.0.0.1:8088/api/config     # 上限快照 —— 顺手确认环境变量真的生效了
```

```bash
# 万一没起来：看它到底听没听端口、数据目录权限对不对
sudo ss -ltnp | grep 8088
sudo ls -ld /var/lib/blockface-plus /var/lib/blockface-plus/base
```

### 4.1 unit 里几个决定的理由

- **`StateDirectory=blockface-plus`**：让 systemd 声明式地建出 `/var/lib/blockface-plus`、按 `User=` 授权，
  并自动加进 `ProtectSystem=strict` 的白名单。好处是「目录权限」不再依赖文档里那几条 `chown` 命令 ——
  换台机器、改个用户名都不会漏。若你手工建过这个目录，systemd 会把它 chown 成服务账号，属正常。
- **`ProtectHome=read-only` 而不是 `true`**：`true` 会把 `$HOME` 变成空目录，而 uv 托管的 Python 解释器就住在
  `/home/blockface/.local/share/uv/python/...`，`backend/.venv/bin/python` 只是指向它的软链接 ——
  藏掉 `$HOME` 等于把解释器一起藏掉，服务会以「找不到文件」起不来。`read-only` 保留了可读、仍然禁止乱写。
  （想用 `ProtectHome=true` 也行：把 `UV_PYTHON_INSTALL_DIR` 指到 `/var/cache/blockface-plus/python`，
  并在第 2 节 `uv sync` 时用同一个变量，让运行期和安装期看到同一份解释器。）
- **`listen 127.0.0.1` + `--workers 1`**：前者让 uvicorn 只对回环开放，对外只有 nginx 一个入口。
  后者是刻意的：一个 worker 就是一个进程，房里的写路径全靠"单进程内单连接 + 应用层写锁"把并发写消掉
  （见 `backend/src/bfp/db.py`）。多开 worker 后，跨进程的写确实还有数据库层的 `BEGIN IMMEDIATE` +
  `busy_timeout` 兜着，但读-改-写序列会多出真实的等待与超时可能（日志里的 `database is locked` 就是这么来的），
  而这套服务本来就没有高写入压力 —— 拿复杂度换这点吞吐不划算。
  真要横向扩容，先给写路径设计明确的乐观锁 + 重试策略，再动这个数字。
- **`uv run --frozen --no-dev` 而不是直接调 `.venv/bin/uvicorn`**：依赖清单变了以后一次 restart 就能对齐环境，
  `--no-dev` 保证服务器上永远装不上那套只在开发/CI 才需要的测试依赖。
  启动路径上想完全不要 uv（更快、更少活动部件）就把 `ExecStart` 换成 unit 里注释掉的那一行 ——
  但那样「环境是否对齐」就完全交给人记得去 sync 了。
  需要知道的边界：环境已经同步好时，`uv run` 只做一次毫秒级校验、**不联网**；只有锁文件/依赖变了、
  环境还没同步时，它才会在启动现场构建项目包 —— 那一步要联网，这也正是 7.4 把 `uv sync` 排在
  `restart` 之前的原因（先联网同步，再离线重启）。

---

## 5. nginx 反向代理

```bash
sudo install -m 0644 deploy/nginx-blockface-plus.conf /etc/nginx/sites-available/blockface-plus.conf
sudo ln -sfn /etc/nginx/sites-available/blockface-plus.conf /etc/nginx/sites-enabled/blockface-plus.conf
sudo rm -f /etc/nginx/sites-enabled/default      # 免得默认站点抢同一个 80 端口
sudoedit /etc/nginx/sites-available/blockface-plus.conf   # 改 server_name
sudo nginx -t && sudo systemctl reload nginx
```

### 5.1 这份配置在做什么，为什么

1. **`client_max_body_size 256m`** —— 与 `BF_MAX_JSON_BODY_BYTES` 默认值 268435456 字节**恰好相等**
   （nginx 的 `256m` = 256×1024×1024 = 268435456），也与 128MiB 的 `BF_MAX_BASE_IMAGE_BYTES` 兼容。
   这是最容易漏的一步：nginx 不放开，请求**根本到不了**后端，客户端收到的是 nginx 的纯文本 413，
   而不是后端那份 `{"error": "..."}`。**看报错长什么样，就知道是谁拦的。**
   改这两个上限时记得给 multipart 留余量：底图那次 POST 的整体体积是「图片字节 + 表单字段 + boundary」，
   后端自己留了 1MiB 的余量，nginx 这边也应当比 `BF_MAX_BASE_IMAGE_BYTES` 略大一点。
2. **`proxy_request_buffering off`** —— 默认行为是 nginx 先把整个请求体收完再连上游：传一张 128MiB 底图，
   就等于先在 nginx 的临时目录里落一份 128MiB 的文件。关掉之后字节边到边转发给 uvicorn，
   省一次磁盘往返，也顺手消灭「`/var/lib/nginx` 被塞满」这类故障。
3. **透传 `X-BF-Room-Pwd`** —— 后端只认请求头里的密码（绝不接受 query 里的），注释里也写了为什么值得显式写一行。
   `log_format` 里**不要**加这个头：那等于把房间密码抄进磁盘。
4. **响应侧不开缓存** —— 底图是私有内容，`Cache-Control: private, max-age=60` 由后端下发，反代不要再叠一层。

### 5.2 HTTPS（可选但跨域时基本必做）

Pages 是 https，浏览器对「https 页面请求 http 后端」是硬拦的（混合内容），所以后端也得有 TLS：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com --redirect
```

certbot 会自己改写这份配置（加 443 的 server 块、填证书路径、把 80 上的请求 301 过去）并 reload nginx，
之后自动续期由它装的 systemd timer 负责。后端**不需要任何改动**：它照旧只听回环的明文 HTTP，
TLS 在 nginx 这一层终止，`X-Forwarded-Proto` 就是告诉后端「对外其实是 https」的那一行。

### 5.3 验证反代与跨域

```bash
curl -s https://api.example.com/api/health

# 模拟浏览器为「带自定义头的 POST」发的那次预检
curl -si -X OPTIONS https://api.example.com/api/rooms \
  -H 'Origin: https://你的-pages-域名' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-bf-room-pwd' | head -20
```

响应里 `access-control-allow-origin` 要等于你填的那个来源，`access-control-allow-headers` 里要有
`x-bf-room-pwd` 和 `content-type`。缺哪个就回去查 `BF_CORS_ORIGINS`（来源必须**逐字符**相等：
多一个结尾斜杠、写成 http、带了路径，都会被判定为不允许）。

### 5.4 替代方案：同源部署（一个域名既发前端又反代 /api）

跨域是要付代价的：多一次 preflight、CSP 要多放行一个来源、密码头要跨域。
如果这个项目基本只有你自己用，最省事的是让 nginx 直接托管前端产物、同域转发 `/api`：

```bash
# 本地构建，把 dist/ 传上去（VITE_API_BASE_URL 留空 = 同源）
pnpm build
rsync -av --delete dist/ blockface@你的服务器:/srv/blockface-plus-web/dist/
```

nginx 侧用样例文件末尾那段注释里的 server 块（`root` + `try_files ... /index.html` + `location /api/`）。
此时：

- `BF_CORS_ORIGINS` 不再是必需项（同源请求不触发 CORS），但**别把它设成 `*` 就以为万事大吉**，
  收成自己的域名仍然更安全；
- 前端构建**不要**设 `VITE_API_BASE_URL`；
- 前端换了新版本要记得同步 `index.html` 与 `assets/`（`--delete` 会清掉旧文件），
  否则浏览器拿着旧壳子去请求已删除的带 hash 资源，表现为白屏。

---

## 6. 前端：构建产物发到边缘 Pages

### 6.1 构建

```bash
pnpm install

# (a) 跨域直连 VPS：把后端地址烧进产物
VITE_API_BASE_URL=https://api.example.com pnpm build

# (b) 同源反代：什么都不设
pnpm build
```

Windows PowerShell 里没有行内环境变量语法，写成两行：

```powershell
$env:VITE_API_BASE_URL = "https://api.example.com"
pnpm build
```

要点：

- 这个变量是**构建期**被烧进产物的（不是运行时读的），**改后端地址必须重新 `build`**；
- 空值或不设 = 同源，产物的请求会打到 `https://你的-pages-域名/api/...`（只有 5.4 那种同源部署才该这样）。
  **注意它不会报错，只会静默退化成同源**：如果你选的是 (a) 跨域直连 VPS 却忘了设这个变量，
  表现是所有接口 404 —— 不是后端挂了，是请求压根没离开 Pages 的域名。部署完先在浏览器 Network 面板看一眼请求打到哪个域名；
- 本地联调想把 `/api` 代理到别的机器（比如局域网里另一台跑后端的机器），用 `BF_DEV_API_TARGET`：
  `BF_DEV_API_TARGET=http://192.168.1.10:8088 pnpm dev`。它只影响 dev / preview 两个开发期服务器，与生产构建无关；
- 末尾斜杠由 `vite.config.ts` 统一去掉，你写不写都行；
- 别把它写进 `.env.production` 提交 —— 那等于把「这个仓库默认指向我的服务器」固化进版本库，换个人 clone 下来就带上了。放 CI 的环境变量里。

**部署前先二选一，别混着来**：

- **(a) 跨域直连 VPS**：构建时设 `VITE_API_BASE_URL=https://api.example.com`，
  同时把 Pages 的域名填进后端 `BF_CORS_ORIGINS`（注意事项见 6.3）；
- **(b) 同源反代**：不设这个变量，由边缘 Pages 或 nginx 把 `/api` 反代到 `127.0.0.1:8088`（做法见 5.4）。

设了变量却按同源部署 → 请求会直接打到 `https://api.example.com`（此时必须已经配好 CORS 与 TLS）；
不设变量却按跨域部署 → 请求会打到 Pages 自己的 `/api` 上，得到 404。

### 6.2 发布

`pnpm build` 的产物在 `dist/`（`index.html`、`assets/`、`favicon.svg`）。边缘 Pages 的发布都是同一件事：
**把 `dist/` 整个目录当成站点根传上去**。

- 本项目是纯静态 SPA，没有服务端渲染、没有平台专属函数，所以 Cloudflare Pages、Netlify 或任何静态托管都适用；
- 在平台控制台的「构建配置」里填构建命令 `pnpm build`、输出目录 `dist`；也可以本地构建好再上传目录；
- 路由上只有 `?room=xxx` 这种查询串，没有 history 路由，因此**不需要** SPA 回退规则；
  如果平台强制要求填一条 rewrite，就填 `/* → /index.html`；
- `vite.config.ts` 里 `base: './'` 让资源用相对路径引用，所以放在子路径下也能正常加载。

### 6.3 跨域与 CSP 注意事项

- **CORS 白名单**：`BF_CORS_ORIGINS` 必须写 Pages 的**最终域名**。平台的预览部署每次都会给一个新域名，
  要么把这些域名也加进白名单，要么预览时把 `VITE_API_BASE_URL` 指到本机后端。
- **CSP**：生产构建会把 `Content-Security-Policy` 注入 `index.html` 的 `<meta>`（实现见 `vite.config.ts`），
  其中 `connect-src` 需要包含后端 origin —— `vite.config.ts` 会从 `VITE_API_BASE_URL` 自动提取并加上，
  所以**改了后端地址一定要重新构建**，否则产物里的 CSP 还停在旧域名上。
  被 CSP 拦下的表现是控制台明确写出 `Content Security Policy` 字样，和 CORS 报错长得不一样，别混。
- **preflight 是省不掉的**：密码走自定义请求头 `X-BF-Room-Pwd`，跨域时浏览器一定会先发一次 `OPTIONS`。
  不要去 nginx 上给 `OPTIONS` 加长时间缓存 —— 这里没有值得省的东西。
- **别把密码塞进 URL**：契约规定密码只走请求头，既是为了不进 nginx access_log，也是为了不留在浏览器历史里。

---

## 7. 备份与运维

### 7.1 只备份两样东西

```
/var/lib/blockface-plus/bfp.sqlite3     SQLite：房间、头像行、密码哈希、限流状态
/var/lib/blockface-plus/base/           底图字节：一间房一个文件（{房间号}.{后缀}）
```

**不要直接 `cp bfp.sqlite3`**：WAL 模式下最近的提交还在 `bfp.sqlite3-wal` 里，
单拷主库会丢掉最后一批写入，甚至拷到一个写到一半的页。用 SQLite 自带的在线备份：

```bash
sudo install -d -m 0750 -o blockface -g blockface /var/backups/blockface-plus

# VACUUM INTO：在一个读事务里把整库重写成一份新文件
sudo -u blockface sqlite3 /var/lib/blockface-plus/bfp.sqlite3 \
  "VACUUM INTO '/var/backups/blockface-plus/bfp-$(date +%F).sqlite3'"

# 底图目录单独打包（-C 切根目录，包里的路径就是 base/...）
sudo tar -C /var/lib/blockface-plus -czf /var/backups/blockface-plus/base-$(date +%F).tar.gz base
```

`VACUUM INTO` 的三点好处：不阻塞写入（WAL 允许读写并发）、产物是自洽的单文件（不需要配套的 `-wal`/`-shm`）、
顺带整理了碎片。注意目标文件**必须不存在**，按日期命名天然满足。

一条每日 cron（`crontab -e`，或 `/etc/cron.d/blockface-plus`）：

```cron
15 4 * * * root sqlite3 /var/lib/blockface-plus/bfp.sqlite3 "VACUUM INTO '/var/backups/blockface-plus/bfp-$(date +\%F).sqlite3'" && tar -C /var/lib/blockface-plus -czf /var/backups/blockface-plus/base-$(date +\%F).tar.gz base && find /var/backups/blockface-plus -type f -mtime +14 -delete
```

（cron 里 `%` 必须写成 `\%`。）

**诚实说明这个备份的一致性边界**：数据库与底图目录不是同一个原子快照，两条命令之间隔了几百毫秒。
真要在这中间建了房，最坏结果是某间房的底图文件没进包 —— 恢复后该房间退化成「底图 404/409」，
读路径不会崩、其它房间不受影响。备份的价值在「能起来」，不在「分毫不差」；要严格一致就只能停服备份。

### 7.2 恢复

```bash
sudo systemctl stop blockface-plus-api

# 1) 先验证备份能读，再动线上文件
sudo -u blockface sqlite3 /var/backups/blockface-plus/bfp-2026-01-01.sqlite3 "PRAGMA integrity_check;"   # 期望输出 ok

# 2) 旧的 WAL/SHM 必须删掉：它是上一代数据库的增量，配错库文件等于把两代数据混在一起
sudo rm -f /var/lib/blockface-plus/bfp.sqlite3-wal /var/lib/blockface-plus/bfp.sqlite3-shm

# 3) 覆盖数据库与底图
sudo install -o blockface -g blockface -m 0640 \
  /var/backups/blockface-plus/bfp-2026-01-01.sqlite3 /var/lib/blockface-plus/bfp.sqlite3
sudo tar -C /var/lib/blockface-plus -xzf /var/backups/blockface-plus/base-2026-01-01.tar.gz

sudo systemctl start blockface-plus-api
```

### 7.3 运维 CLI：`bfp-ops`

它直接读写 `BF_DATA_DIR` 下的数据（**不经过 HTTP，因此不需要管理员密码**），
处理的是「在网页上点不动」的那几件事：看有哪些房间、看一间房到底存了什么、删掉某间房、把过期房与没传底图的草稿房扫掉。
它是 `backend` 里的 console script（`pnpm rooms` 就是它的快捷方式），全局 `-h` 与每个子命令都有帮助：

```bash
# 本机联调（在仓库根目录）
uv run --directory backend bfp-ops -h

# 服务器上：用服务账号跑，并且让 BF_DATA_DIR 指到真实数据目录
cd /srv/blockface-plus
sudo -u blockface env BF_DATA_DIR=/var/lib/blockface-plus HOME=/home/blockface \
  /usr/local/bin/uv run --frozen --no-dev bfp-ops -h
```

| 子命令 | 作用 | 什么时候用 |
| :-- | :-- | :-- |
| `list [--json]` | 列出所有房间：房间号 / 状态 / 层数 / 创建时间 / 过期时间 | 想确认「到底有多少房、谁快过期」 |
| `inspect <房间号> [--json]` | 看一间房的详情：画布、头像行数、两把密码的长度、**底图指针指向的文件是否真的在盘上**、以及当前限流状态（失败次数与锁定到什么时候） | 用户说「我的房间打不开」，先看数据本身 |
| `delete <房间号> --yes` | 删除房间（连同它的底图字节） | 房间号泄露了、或要立刻腾空间 |
| `sweep [--dry-run]` | 立即清扫：已过期房间 + 超过 `BF_DRAFT_TTL_SECONDS` 仍没传底图的草稿房 | `BF_SWEEP_INTERVAL_SECONDS=0` 时手工兜底；`--dry-run` 只统计不删 |

几条使用要点：

- `--data-dir DIR` 覆盖 `BF_DATA_DIR`，放在子命令前后都能用（`bfp-ops --data-dir /tmp/bfp-data list`
  与 `bfp-ops list --data-dir /tmp/bfp-data` 等价）。临时查一份解压出来的备份时特别顺手 —— 不用去动线上配置。
- **`delete` 必须显式带 `--yes`**：不带就拒绝执行。这条命令没有任何撤销手段，
  所以把「手滑」的成本前置成「多打四个字符」，比事后解释便宜得多。
- `list` / `inspect` 的 `--json` 是给脚本用的（塞进监控或写进日报）；`sweep --dry-run` 用来先看看会删掉什么。
- 退出码：`0` 成功；`delete` 少了 `--yes`（2）或房间不存在（1）返回非 0，
  所以可以放心写进脚本用 `&&` 串起来。
- 它固定只动 `{BF_DATA_DIR}/bfp.sqlite3` 与 `{BF_DATA_DIR}/base/` 这两处，不会碰到别的路径。

### 7.4 升级

```bash
cd /srv/blockface-plus
sudo -u blockface git pull --ff-only
sudo -u blockface env HOME=/home/blockface /usr/local/bin/uv sync --frozen --no-dev --directory backend
sudo systemctl restart blockface-plus-api
journalctl -u blockface-plus-api -n 50 --no-pager
```

**升级前先做一次 7.1 的备份**：数据库结构由后端在启动时按 `backend/src/bfp/schema.sql` 初始化，
结构一旦变了，旧版本代码通常读不回新库（结构变更不可逆）。备份是唯一可靠的退路。

---

## 8. 排错

### 8.1 状态码对照

先记住一件事：**错误响应体统一是 `{"error": "<中文人话>"}`**（契约 §1）。
拿到响应体就能知道原因，拿到的是 nginx 的纯文本 HTML/文本，说明请求根本没到后端。

| 状态码 | 含义 | 该查什么 / 怎么调 |
| :-- | :-- | :-- |
| `400` | 入参不合法（房间号格式、过期天数超范围、缺字段） | 看错误文案里点了哪个字段；批量提交时先确认前端没把密码塞进 query |
| `401` | 密码不对 | ① 密码分大小写、不含 `0/1/l/o`，别让人为抄错背锅；② 用 `curl -H 'X-BF-Room-Pwd: ...'` 直连 `127.0.0.1:8088` 排除 nginx/CDN 丢头；③ 确认浏览器发的是 `X-BF-Room-Pwd` 而不是别的名字 |
| `403` | 角色不够（编辑者动了布局、动了增删，或非管理员想删房/换底图） | 这是**设计如此**，不是 bug：编辑密码只能换皮肤。管理动作要用创建响应里那次给出的管理员密码 |
| `404` | 房间不存在（房间号写错，或房间已被彻底删除） | `bfp-ops list` 看看这个房间号到底在不在；不在就是已经被删/从未创建 |
| `409` | 状态未就绪 / 版本冲突 | 房间还是草稿态却去取底图 → 发布流程没走完；差量提交拿到 `409` 说明某几行被别人改过，客户端应把这几行留在「待提交」里重试 |
| `410` | 房间已过期 | 过期是**惰性**生效的：谁来读谁触发删除。想让数据尽快消失就调小 `BF_SWEEP_INTERVAL_SECONDS`，或手工 `bfp-ops sweep` |
| `413` | 体积超限 | **先看响应体**：JSON 的错误来自后端 `BF_MAX_*_BYTES`；纯文本来自 nginx `client_max_body_size`。两个值要一起改 |
| `429` | 密码试错太频繁 | 按**房间**计数（不是按 IP）。默认 60 秒窗口 20 次失败。先 `bfp-ops inspect <房间号>` 看锁到什么时候；再决定是调 `BF_AUTH_WINDOW_SECONDS` / `BF_AUTH_MAX_FAILS`（调大更抗「抄错密码」，调小更抗「暴力猜」），还是就地解锁（见下表后的说明）。注意副作用 —— 知道房间号的人可以故意刷失败把房主挡在门外一个窗口，这是拿可用性换安全性的取舍 |
| `500` | 后端内部错误 | `journalctl -u blockface-plus-api -n 200`；先怀疑数据目录不可写（`ls -ld /var/lib/blockface-plus`） |
| `502 / 504` | nginx 连不上后端 | `systemctl status blockface-plus-api`、`sudo ss -ltnp \| grep 8088`；启动了又立刻退出，通常看 `journalctl` 里是不是 `No such file or directory`（解释器/路径问题） |

**房主被自己的房间挡在门外（429）怎么就地解锁**：限流状态是 SQLite 里的一行，每个鉴权请求都现读，
所以删掉它立刻生效、不需要重启服务：

```bash
sudo -u blockface sqlite3 /var/lib/blockface-plus/bfp.sqlite3 \
  "DELETE FROM room_throttle WHERE room_id = '房间号'"
```

先 `bfp-ops inspect <房间号>` 确认它确实处于锁定态（能看到「窗口内失败 N 次，锁定至 …」），别把
「密码抄错了」误判成「被限流了」—— 后者是 429 且带剩余秒数，前者是 401。

### 8.2 常见症状速查

- **前端控制台报 CORS**：来源必须与 `BF_CORS_ORIGINS` 逐字符相等（scheme、host、port、**没有**结尾斜杠）。
  改了 `api.env` 记得 `systemctl restart`。
- **浏览器报 CSP 拦截**：产物是在设 `VITE_API_BASE_URL` 之前构建的 —— 重新 `pnpm build`。
- **一直 401 但密码没错**：中间层把 `X-BF-Room-Pwd` 吃掉了。用 5.3 的 curl 直连域名试一次、
  再直连 `127.0.0.1:8088` 试一次，就能定位是 nginx 之后还是之前的问题。
- **大底图传到一半失败**：三处都要看 —— nginx `client_max_body_size`、
  `proxy_request_buffering off` 有没有生效、后端 `BF_MAX_BASE_IMAGE_BYTES`。
- **磁盘长得比预期快**：房间是过期的但清扫被关了（`BF_SWEEP_INTERVAL_SECONDS=0`），
  或者有人传了超大底图。先 `bfp-ops list` 看有哪些房、谁过期了，再 `bfp-ops inspect <房间号>`
  看那间房的底图占了多少字节（`list` 只有房间级别的清单，不含体积），最后 `bfp-ops sweep` 清一轮。
- **日志里出现 `database is locked`**：几乎一定是有人把 `--workers` 调大于 1 了。改回 1（理由见 4.1）。
- **服务重启后房间都还在**：本来就该如此 —— 数据在 `/var/lib/blockface-plus`，重启进程不动它。

---

## 9. 上线自检清单

- [ ] `curl -s http://127.0.0.1:8088/api/health` 返回 `{"ok":true,...}`
- [ ] `curl -s http://127.0.0.1:8088/api/config` 里的数字与 `api.env` 一致（证明环境变量真读到了）
- [ ] `https://api.example.com/api/health` 通，且 `systemctl enable` 过（重启机器后能自己起来）
- [ ] `BF_CORS_ORIGINS` 写的是 Pages 的真实域名（不是 `*`）
- [ ] nginx `client_max_body_size` ≥ `BF_MAX_JSON_BODY_BYTES` 与 `BF_MAX_BASE_IMAGE_BYTES`
- [ ] 浏览器里能走完一次「发布房间 → 换密码进房 → 换个皮肤 → 提交」全流程
- [ ] 备份 cron 装好，并且**真的手工执行过一次恢复演练**（没演练过的备份等于没有备份）
- [ ] `journalctl -u blockface-plus-api` 里没有反复出现的异常栈
