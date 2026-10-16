<!-- BlockFace+ · Copyright 2026 Dainsleif · Apache License 2.0 -->
# BlockFace+ · 技术设计与实现要点

本文档汇总了 BlockFace+ 关于数据源通信、皮肤贴图渲染、画布几何变换、协同房间数据架构的核心技术事实与实现设计。

---

## 1. 皮肤数据源与网络架构

### 1.1 Mojang 官方 API 的 CORS 限制
皮肤 ID 查询是零后端的纯客户端实现，受浏览器同源策略（SOP）约束：
- Mojang 官方用户档案接口（如 `api.mojang.com/users/profiles/minecraft/<name>` 和 `sessionserver.mojang.com`）未配置 `Access-Control-Allow-Origin` 响应头，纯前端无法直接通过 `fetch` 获取响应。
- 官方皮肤材质 CDN（`textures.minecraft.net/texture/<hash>`）支持跨域请求（`Access-Control-Allow-Origin: *`），可直接通过 `Image` 跨域安全绘入 Canvas。

### 1.2 客户端代理与多源解析策略
为在无自建后端的前提下支持正版玩家 ID 查询，应用采用具备公共 CORS 头的第三方开放接口，并设置自动回退：
1. **主路径**：`playerdb.co/api/player/minecraft/<name>`，返回包含 UUID 及皮肤贴图直链的 JSON 结构。
2. **备选路径**：`mc-heads.net/skin/<name>` 等直接返回皮肤 PNG 二进制流的服务。
3. **本地与直链**：支持用户直接拖拽上传本地 `.png` 文件，或直接提供任意支持跨域的图片直链。

---

## 2. 皮肤贴图规格与 UV 渲染算法

### 2.1 贴图规格与高清适配
Minecraft 皮肤采用标准化 UV 贴图排版：
- **基准规格**：`64×64` 像素（现代皮肤标准，含完整头、身、四肢及双层材质）。
- **旧版规格**：`64×32` 像素（Minecraft ≤ 1.7 旧版贴图，仅包含单层身体部位，但头部区域仍包含外层帽子）。
- **高清皮肤**：`128×128`、`256×256`、`512×512` 等（通常为 64 的整数倍）。
- **等比换算**：渲染引擎通过计算 `scale = image.width / 64` 计算缩放基准，所有像素坐标严格乘以 `scale` 进行映射，原生兼容所有规格。

### 2.2 头部 UV 映射与层级合成
正脸渲染的核心像素区间（以 64×64 为例）：
- **底层正脸 (Head Front)**：UV 区域 `(x: 8, y: 8, w: 8, h: 8)`。
- **帽子层 (Hat/Overlay)**：UV 区域 `(x: 40, y: 8, w: 8, h: 8)`（即底层 X 坐标 + 32）。

**渲染流程**：
1. 提取贴图中的正脸区域，使用 Canvas 离屏缓冲以**最近邻采样（Nearest-Neighbor）**放大至目标尺寸，避免像素模糊；
2. 若开启帽子层，将帽子层区域使用标准的 `source-over` 模式叠加在底层上方；
3. *注：关于官方 Steve 贴图帽子层中的灰色像素，系 Mojang 官方原始素材本身自带的不透明发际线像素，本应用忠实还原正版渲染，同时提供一键关闭开关。*

### 2.3 通用头像图片支持与混合插值决策
除 Minecraft 格式皮肤贴图外，应用支持用户上传任意常用格式（PNG / JPG / WebP 等）的普通头像图片作为图层贴图：
- **自适应居中适配**：图片等比缩放至图层包围盒内（contain 模式）居中绘制，自动适应横向或纵向比例。
- **双通道缩放与旋转插值算法**：
  - *Minecraft 像素皮肤*：正向正交渲染时严格采用**最近邻采样（Nearest-Neighbor）**（`imageSmoothingEnabled = false`），确保复古像素边缘锐利；
  - *通用头像图片与非正交旋转*：当素材为通用头像图片（`isCustomImage === true`）或发生非 90° 整倍数旋转（`rotation % 90 !== 0`）时，启用**高质量平滑插值（`imageSmoothingEnabled = true`）**，彻底消除旋转导致的阶梯锯齿与画面走样。
- **帽子层自动禁用**：通用头像图片非双层 UV 贴图，在属性检查器中自动禁用帽子层开关并标识为「无」。

### 2.4 离屏缓存与资源生命周期治理
- **HeadCache 离屏渲染缓存**：
  - 采用定长（48 张）的 LRU 缓存策略，键值结合 `skinId`、帽子层开关、尺寸与缩放系数；
  - 支持 `evictSkin(skinId)` 定点淘汰指定素材的所有离屏缓存，在素材删除时即时回收 Canvas 实例显存。
- **底图垃圾回收 (GC)**：`sweepUnusedBaseImages` 遍历当前状态及 `past`、`future` 撤销/重做栈中引用的底图 ID，自动销毁未被引用的历史大图。
- **素材撤销栈保护**：在单张删除 (`removeSkin`) 与闲置清理 (`clearUnusedSkins`) 中通过 `getReferencedSkinIds()` 递归检索所有历史快照图层，确保历史引用的素材不被意外销毁，杜绝撤销后图层变隐形的 Bug。

---

## 3. 画布坐标系与视口变换

### 3.1 坐标分层
BlockFace 采用双层画布设计：
- **文档层 (Document Canvas)**：物理分辨率等于底图真实像素（无底图时为默认尺寸如 1280×800）。所有图层的 `x, y, size` 均基于文档坐标系。
- **覆盖层 (Overlay Canvas)**：绘制选中外框、8个控制柄（缩放/边柄）与旋转旋钮。

### 3.2 基于光标锚点的视口缩放算法
为提供流畅的画布缩放体验，在视口中以光标为中心进行缩放时，必须同时补偿视口中心偏移量：
```ts
// 视图缩放系数 k (nextZoom / currentZoom)
// 补偿光标相对偏移与 Flex 居中布局带来的原点位移
viewport.x = cursor.x - (cursor.x - viewport.x) * k + (document.width * (k - 1)) / 2;
viewport.y = cursor.y - (cursor.y - viewport.y) * k + (document.height * (k - 1)) / 2;
```
- 视口平移与缩放仅作用于渲染视口，**不计入**撤销/重做操作历史（Undo/Redo History）。
- 图层的位置移动、尺寸缩放与旋转角度变更则作为文档操作进入历史记录栈。

---

## 4. 协同房间数据架构

协同房间把「一张图上的全部头像」托管到 EdgeOne Makers 云函数 + Blob 存储，实现多人在线共同编辑。浏览器端皮肤数据格式沿用单机版的内嵌正脸双层方案（见 4.2）；「预设面板 / JSON 文件导入导出」功能已由协同房间取代，`PresetSkin` 结构与记录归一化继续作为房间头像的数据底座。

### 4.1 存储底座与键布局
- 全部持久化走 `@edgeone/pages-blob` 的 `getStore({ name: 'blockface-plus', consistency: 'strong' })` 单例，不使用 KV；强一致保证「写完的下一次读必能读到」。
- **一头像一键隔离**：每条头像是独立 Blob，改内容就是覆盖一个 key，天然免读-改-写竞争。
- **三种操作三张表，互不相干**：换底图只写 `base.json` 与图片字节；换某条头像的内容只写那一行的皮肤字段；保存布局只写那一行的布局字段。谁都不必先读别人的表，更不可能把别人的写入覆盖掉——老版本「整房一份 meta 里同时塞底图指针、画布尺寸、状态与版本号」的结构已不存在（不留兼容层，老房间按未发布处理）。
- 键布局：
  - `rooms/<roomId>/meta.json`：房间身份（房间号、创建/过期时间、两把密码的哈希），建房后只读；
  - `rooms/<roomId>/base.json`：底图指针（key/类型/名字）、画布尺寸、状态 draft/ready、待确认的 pending 键；
  - `rooms/<roomId>/avatars/<layerId>.json`：单条头像记录（布局字段 + 皮肤 + 两个版本戳）；
  - `rooms/<roomId>/images/base.<后缀>`：底图字节（预签名直传目标；同后缀固定键，重传即覆盖）；
  - `index/<roomId>.json`：房间索引（过期清扫用，只存 roomId 与过期时间）；
  - `throttle/<roomId>.json`：密码试错计数（见 4.5）。
- 容量边界：云函数请求体 6MB、挂钟 120 秒；底图单张 ≤ 10MB；文档边长 ≤ 8192；一间房最多 512 条头像（`MAX_LAYERS`）。

### 4.2 头像记录与内嵌皮肤格式
- 单条头像记录（`RoomAvatarRecord`）：`id / name / x / y / size / rotation / opacity / overlay / flipH / visible / order / skin / skinUpdatedAt / layoutUpdatedAt`。`order` 决定图层顺序（0 在最底层）；两个版本戳都是服务端生成的并发凭证，**各管各的域**：换皮肤只比对 `skinUpdatedAt`，挪位置只比对 `layoutUpdatedAt`。
- 皮肤沿用 `PresetSkin`：`dataUrl / width / height / isCustomImage? / frontOnly?`。写入端 `createPresetSkin` 与读取端归一化配对，data URI 只认 png / jpeg / webp 白名单（防 `javascript:` 注入）。
- **正脸双层标记（`frontOnly`）**：16×8 / 32×16 靠尺寸即可自证，但高清皮肤提取出的 64×32 / 128×64 与旧版整肤**同尺寸**，必须随材质携带该标记，否则会被误判成旧版皮肤、从错误区域裁切。
- MC 皮肤入库前只保留正脸双层（底层正脸 8×8 + 帽子外层 8×8 并排，16×8 或高清等比），通用头像图片等比限制在 512px 内，控制单条记录体积。

### 4.3 提交协议（谁能改什么）
- **差量提交（`PATCH /api/rooms/:id/avatars`，写头像的唯一入口）**：请求体是 `{ updates, adds, deletes }` 三件套，服务端只写被提到的行、只写被带上的字段：
  - `updates: [{ id, layout?, skin?, expectLayoutUpdatedAt?, expectSkinUpdatedAt? }]`：`layout` 是布局字段的局部补丁（没带的键一律不动），`skin` 是整份皮肤记录；两个凭证只在**自己对应的域被写入时**才比对，不符的那一条单独返回 `{ ok: false, error: 'conflict' }`；
  - `adds: [整行记录]`：id 已被占用回 `exists`，绝不覆盖别人的行；
  - `deletes: [id]`：幂等，不比对版本戳。
  - 逐条返回 `{ results: [{ id, ok, error?, skinUpdatedAt?, layoutUpdatedAt? }] }`：某一条失败不影响同批其它条目；成功条目回带新版本戳，客户端只把成功的那些行推进基线，失败的原样留在「待提交」里。
  - 角色：编辑者只能带 `skin`（带了 `layout` 也照样不写入，不报错），`adds`/`deletes` 一律 403；管理员三者皆可。
  - 边界只有体积：单次请求体 ≤ 4MB 字符（`MAX_PATCH_CHARS`，前端 `chunkBySize` 按体积切块、**条数不设限**），一次能提到的行数不超过「一间房最多 512 行」这个真实上限。
- **全量覆盖（`PUT /api/rooms/:id`）已拆除**：回 405 并指路 `PATCH .../avatars`；`ifRevision` 乐观锁、房间级 `revision`、`MAX_PATCH_UPDATES` 一并消失。
- **删除（`DELETE /api/rooms/:id`）**：仅管理员，物理清扫房间前缀下全部 Blob（含底图、头像行、throttle）与索引条目。

### 4.4 底图直传与回执
- 建房响应携带预签名 PUT URL（有效期 600 秒），客户端把底图字节**直传 Blob 存储绕过云函数**（规避 6MB 请求体上限）；随后回执 `confirm` 校验体积（HEAD 拿不到对象就直接 409，绝不把房间推成「发布成功但底图 404」）≤ 10MB，把房间从 draft 切成 ready——**只写 `base.json`，不碰任何一行头像**。
- 管理员换底图同链路：`sign` 申请固定键 `images/base.<后缀>` → 直传 → `confirm`（带 key）。confirm 手里只有 key 的后缀，用「后缀 → MIME」反查表还原类型；确认后清掉同前缀下不再被引用的底图，不让旧图白占额度。
- 读取（`GET /api/rooms/:id/base`）：按密码鉴权，返回 `Content-Type`、`Cache-Control: private, max-age=60` 与 `X-BF-Base-Name`——响应头不允许非 ASCII，底图文件名以 percent-encoding 下发，前端 `decodeURIComponent` 解回原名（解不动回退「底图」）。

### 4.5 密码与鉴权
- 编辑密码 8 位、管理员密码 12 位；字符表剔除 `0/1/l/o` 等易混字符，并做拒绝采样保证均匀分布。
- 落库只存 `scrypt$salt$hash`，校验用 `timingSafeEqual` 防时序侧信道；密码仅在创建响应里出现一次，之后任何接口都不回传。
- 请求密码统一走 `X-BF-Room-Pwd` 请求头；密码试错按**房间**计数（60 秒窗口 10 次失败，计数落 `throttle/<roomId>.json`，冷启动不清零），超限回 429 并带上剩余秒数。已知代价：知道房间号的人可以故意把房主挡在门外 60 秒，换来的是多实例部署下不会各算各的。
- 前端会话：密码只存 sessionStorage（`blockface-plus.room.<房间号>`），刷新不丢、关标签页即清空；发布成功后暂存的是管理员密码，房主进房即持管理权限。

### 4.6 生命周期与过期
- 过期时间只认 3 / 7 / 14 天，创建时定死 `expiresAt`。
- **惰性过期**：任何读路径发现 `expiresAt` 已过 → 就地删除房间全部 Blob 与索引 → 返回 410 语义，前端停留「房间已过期」界面。
- **创建时摊销清扫**：每次建房捎带清扫一次过期索引，单批最多看 24 条（单页拉取 + 截断），历史房间再多也不会把创建接口拖进超时，剩余批次留给下一次创建。

---

## 5. 测试与工程质量保证

- **单元测试 (Vitest)**：10 个测试套件、135 个单测用例，全面覆盖：
  - 几何变换与手势数学 (`transform.spec.ts`, `gesture.spec.ts`)
  - 皮肤 UV 贴图与规格解析 (`texture.spec.ts`)
  - 皮肤数据格式与头像记录归一化、内嵌材质安全防注入 (`preset.spec.ts`)
  - 离屏缓存 LRU 淘汰与定点清除 (`headCache.spec.ts`)
  - 合成导出与像素对齐 (`compose.spec.ts`)
  - 多数据源回退与超时控制 (`providers.spec.ts`)
  - 素材管理与撤销/重做历史引用保护 (`editor.spec.ts`)
  - 协同差量切块与请求层体积边界 (`collab/api.spec.ts`)
  - 差量计算：只发变了的行与字段、两个版本戳分域、失败的条目保留待提交 (`collab/diff.spec.ts`)
- **端到端测试 (CDP-driven)**：Node.js 原生 DevTools Protocol 驱动真实 Chrome，三阶段（发布 → 编辑者 → 管理员）共 145 项检查（任一阶段抛异常即判失败，不会被"跳过"吞掉）：
  - **发布阶段**：无底图拦截、过期天数随请求走、底图字节预签名直传、confirm 用编辑密码切 ready、创建请求快照字段白名单；
  - **编辑者阶段**：布局锁四路拦截、PATCH 只带 `{id, skin, expectSkinUpdatedAt}`（协议不变性）、服务端位置原封未动、**皮肤戳前进而布局戳一动不动**、冲突只影响那一条并保留待提交、全量 PUT 一次都没被调用；
  - **管理员阶段**：只有改动过的那一行进 PATCH、布局差量只带变了的字段（x/y）、新增走 `adds` 而非重发整间房、换底图不碰任何一行头像、删除房间后停留 gone 界面。
  - 页内 mock 后端（`src/dev/collabMock.ts`）由 e2e 动态 import，生产构建被 tree-shake，不产生死体积。
