<!-- BlockFace+ · Copyright 2026 Dainsleif · Apache License 2.0 -->
# BlockFace+

> 纯前端 Minecraft 头像贴图与头图合成工具 —— 在浏览器中为图片自由拼贴 Minecraft 像素头像与通用头像图片；支持一键发布协同房间，多人在线共同编辑。

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3.5-brightgreen.svg)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-8.x-646CFF.svg)](https://vitejs.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-blue.svg)](https://www.typescriptlang.org/)

---

![BlockFace+ 界面预览](docs/screenshot.png)

## ✨ 核心特性

- 🔒 **纯本地计算（离线模式）**：底图与皮肤解析、图层合成全部在浏览器端本地完成，保护用户隐私。
- 🤝 **在线协同房间**：
  - 一键把当前画布（底图 + 全部头像）发布成协同房间，生成专属链接与两把密码；
  - 拿到链接的人凭**编辑密码**只能更换头像皮肤——布局（位置/尺寸/旋转/层级/增删）由发起者锁定，前后端双重防线；
  - **管理员密码**可自由改动布局（挪动/缩放/旋转/增删/改名）、更换底图与删除房间；提交是**差量**的：只发改动过的行与字段，按域比对版本（改布局只比布局戳、换内容只比内容戳），冲突只影响那一条，不会把整次提交打回；
  - 数据落 SQLite（WAL）：房间 / 头像行 / 底图指针各成一张表，布局字段与皮肤字段的版本戳分域，谁也覆盖不了谁刚写的东西；
  - 房间可选 3 / 7 / 14 天过期，到期连同全部内容自动清理（读到即惰性过期 + 后台定时清扫，不靠谁记得去点一下）；
  - 底图字节直接上传到自建后端、落在本地文件系统，没有预签名直传也没有第三方对象存储，体积上限只取决于你愿意在反向代理（nginx 或 Caddy）上放开多大请求体。
- 🧩 **多源素材与通用图片支持**：
  - 内置经典 Steve / Alex 皮肤，开箱即选；
  - 支持正版 Minecraft 玩家 ID 单个或批量检索；
  - 本地皮肤 PNG 文件拖放或多选上传（标准 64×64、64×32 与高清皮肤）；
  - 外部图片 URL 直链快速载入；
  - **支持通用头像图片**（PNG / JPG / WebP 等），自适应等比居中渲染并自动优化帽子层语义。
- 📐 **像素完美与抗锯齿混合渲染**：
  - 自动适配 64×64、64×32 及 128/256/512 等高清（HD）皮肤贴图，正向采用**最近邻像素采样（Nearest-Neighbor）**保持复古硬边；
  - 通用头像图片与非正交旋转图层自动启用**双线性平滑插值**，消除旋转马赛克与走样锯齿；
  - 支持正版第二层（帽子层 / Overlay）一键开关与水平镜像翻转（预览与缩略图实时联动）。
- 🖱️ **直观的手势与画布控制**：
  - 画布视口平移与基于光标锚点的连续平滑缩放（视口平移缩放不污染撤销历史）；
  - 图层等比缩放、定轴旋转、拖拽定位、透明度滑杆、微调输入框与键盘像素级微调；
  - 点击画布任意区域自动聚焦，支持方向键微调与 `[` / `]` 调整图层堆叠顺序。
- 📋 **智能剪贴板与拖放体验**：
  - 任意区域拖放图片即可设为底图；
  - 支持直接粘贴系统剪贴板图片（`Ctrl+V`），画布已有底图时智能识别为贴纸头像载入；
  - 支持一键导出原尺寸高清 PNG，或直接将合成图片拷贝至系统剪贴板。
- 🧹 **内存安全与素材生命周期管理**：
  - 素材库支持单张删除与一键清理闲置素材；
  - **撤销栈保护机制**：历史记录中被引用的素材受到完整保护，防止用户清理素材后撤销导致图层变隐形；
  - 离屏 Canvas 采用 48 张容量的 LRU 缓存与定点淘汰（`evictSkin`），大图自动内存回收（GC）。

---

## 🚀 快速上手

### 环境要求
- Node.js 18.0 或更高版本
- 包管理器：`pnpm`
- 联调在线协同时另需 [uv](https://docs.astral.sh/uv/)（Python 3.12+ 由 uv 自动准备，不用手工装 Python）

### 安装与启动

```bash
# 克隆仓库
git clone https://github.com/Dainsleif233/BlockFace.git
cd BlockFace

# 安装依赖
pnpm install

# 启动本地开发服务
pnpm dev
```

启动后用浏览器访问 `http://localhost:5173/` 即可使用。**离线（单机）功能开箱即用**。

### 在线协同（FastAPI + 自有 VPS）

协同后端是一个独立的 FastAPI 服务（SQLite 元数据 + 本地文件存底图），跑在普通 VPS 上；
前端仍是纯静态产物，发到边缘 Pages，构建时用 `VITE_API_BASE_URL` 指向后端。

```bash
# 装 uv（macOS / Linux；Windows 用 winget install --id=astral-sh.uv -e）
curl -LsSf https://docs.astral.sh/uv/install.sh | sh

# 同步后端依赖（backend/pyproject.toml + uv.lock）
uv sync --directory backend

# 起后端：监听 127.0.0.1:8088（pnpm dev:api 是同一条命令）
uv run --directory backend uvicorn bfp.main:app --reload --port 8088
```

另开一个终端起前端即可联调 —— Vite 已经把 `/api` 代理到 `127.0.0.1:8088`，
所以本地开发时 `VITE_API_BASE_URL` 留空（同源）：

```bash
pnpm dev
```

生产部署（VPS 上的 systemd + 反向代理（nginx 或 Caddy）、SQLite 备份、边缘 Pages 发布）见
[**VPS 部署指南**](docs/deploy-vps.md)；接口、上限与错误码见
[**协同后端 API 契约**](docs/collab-api.md)。

### 构建生产

```bash
# 检查类型并构建生产产物（VITE_API_BASE_URL 留空 = 同源）
pnpm build

# 指向线上后端构建（跨域部署时的正常做法；改了地址必须重新 build）
VITE_API_BASE_URL=https://api.example.com pnpm build

# 本地预览生产构建产物
pnpm preview
```

> `VITE_API_BASE_URL` 是**构建期**变量（不是运行时读的），会被烧进产物并同时决定 CSP 里放行的后端来源；
> 末尾斜杠会被自动去掉。Windows PowerShell 用 `$env:VITE_API_BASE_URL = "..."; pnpm build`。

### 测试验证

```bash
# 运行单元测试 (Vitest) —— 涵盖数学变换、皮肤数据格式、协同差量提交与素材历史保护
pnpm test

# 运行后端单元测试（pytest；首次需先 uv sync --directory backend）
uv run --directory backend pytest -q

# 运行三阶段真实浏览器端到端测试（发布 → 编辑者 → 管理员；基于本机 Chrome DevTools Protocol，
# 会自己拉起真实的 FastAPI 后端与临时 Vite 服务，因此需要 uv 与本机 Chrome）
pnpm e2e
```

### 常用脚本

| 脚本 | 作用 |
| :--- | :--- |
| `pnpm dev` | 起 Vite 开发服务器（5173；`/api` 代理到本机后端 127.0.0.1:8088） |
| `pnpm dev:api` | 起 FastAPI 后端（热重载，监听 8088） |
| `pnpm build` | 类型检查 + 构建生产产物到 `dist/` |
| `pnpm preview` | 本地预览生产产物（同样把 `/api` 代理到本机后端） |
| `pnpm test` | 单元测试（Vitest，跑一次） |
| `pnpm test:watch` | 单元测试（监听模式） |
| `pnpm typecheck` | 只跑 `vue-tsc -b` 类型检查 |
| `pnpm e2e` | 三阶段真实浏览器端到端测试（需本机 Chrome） |
| `pnpm rooms` | 房间运维 CLI（`bfp-ops` 的快捷方式，直接读写数据目录，不走 HTTP，详见部署文档） |

---

## ⌨️ 快捷键与操作指南

| 操作 | 交互方式 | 说明 |
| :--- | :--- | :--- |
| **画布平移** | 空白处拖拽鼠标 / 中键拖拽 | 拖动画布视口，不影响图层坐标与历史记录 |
| **画布缩放** | 空白处滚动滚轮 / 触控板捏合 | 以当前光标位置为锚点连续缩放 |
| **头像缩放** | 光标停在头像上 + 滚动滚轮 | 等比放大或缩小头像 |
| **头像旋转** | 光标停在头像上 + `Shift` + 滚动滚轮 | 每次旋转 5° |
| **精确移动** | 方向键 `↑` `↓` `←` `→` | 每次移动 1 像素，按住 `Shift` 加速为 10 像素 |
| **调整图层层级** | 选中图层时按 `[` 或 `]` | `[` 向下一层，`]` 向上一层（属性栏中亦支持 `Alt+↑/↓`） |
| **取消选中** | `Escape` | 取消当前选中的图层 |
| **删除图层** | `Delete` / `Backspace` | 删除当前选中的头像图层 |
| **撤销 / 重做** | `Ctrl+Z` / `Ctrl+Shift+Z` (Mac: `⌘+Z` / `⌘+Shift+Z`) | 完整的操作历史记录（素材受历史栈保护） |
| **适应屏幕** | `Ctrl+0` (Mac: `⌘+0`) | 画布视口缩放并居中自适应窗口 |
| **导入底图/贴纸**| 拖拽图片至窗口任意区域 / `Ctrl+V` 粘贴 | 无底图时设为底图；已有底图时自动转为头像贴纸 |

> 注：布局类快捷键与手势在协同**编辑者**模式下整体冻结，仅保留「点选头像 → 换肤」。

---

## 🎨 设计语言：8px Blockgrid

BlockFace+ 界面采用严格的 **8px 积木网格（Blockgrid）** 体系：
- **纯 CSS 像素手搓图标**：零 emoji、零位图字体，使用纯 CSS 方块拼装，保持纯粹的像素复古美感。
- **全平涂硬边**：零圆角、零渐变、零模糊阴影，依托 1px 细线、4px 语义色条与清晰的层次划分。
- **高对比度标准**：全界面文字与核心控件均经过 WCAG AA / AAA 级别对比度审计。

详细设计规范请参阅 [设计规范文档](docs/brand-spec.md)。

---

## 📚 更多文档

- [品牌与界面设计规范 (Brand & Design Spec)](docs/brand-spec.md)：色彩令牌、排版阶梯、组件语法与交互细则。
- [技术设计与实现要点 (Product & Technical Facts)](docs/product-facts.md)：Mojang API 限制、皮肤 UV 贴图算法、画布坐标系与视口变换数学、协同房间数据架构、LRU 显存缓存与历史保护。
- [界面需求规格说明 (Design Spec)](docs/design-spec.md)：产品定位、信息架构、协同房间与交互规格。
- [协同后端 API 契约 (Collab API)](docs/collab-api.md)：端点、请求/响应结构、错误码与全部可调上限。**这是冻结契约**，前端、后端、e2e 与部署文档都以它为准。
- [VPS 部署指南 (Deploy on VPS)](docs/deploy-vps.md)：从零装 uv、systemd 常驻、反向代理与 HTTPS（[nginx 样例](deploy/nginx-blockface-plus.conf) + 自动 HTTPS 的 [Caddy 样例](deploy/caddy-blockface-plus.conf)，二选一）、SQLite 备份与 `bfp-ops`、以及边缘 Pages 的构建与发布。

---

## 📄 开源许可与声明

- 采用 [Apache License 2.0](LICENSE) 开源协议。
- 第三方资产与依赖致谢请见 [NOTICE](NOTICE)。
- **免责声明**：BlockFace+ 是一个兼容 Minecraft 皮肤格式的独立第三方工具，与 Mojang Studios / Microsoft 没有任何官方隶属关系。Minecraft 是 Mojang Studios 的注册商标。
