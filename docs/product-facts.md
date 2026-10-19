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

### 1.3 MUA 联合认证皮肤
MUA（mualliance.ltd）联合认证皮肤走 `skin.mualliance.ltd/api/union/skin/byname/<name>`，取图管线是 `loadImage` 的 **`proxyOnly` 模式**，只剩代理那一级：
- 该站**不返回** `Access-Control-Allow-Origin`（`OPTIONS` 预检也只回 `Allow: GET,HEAD`）；
- 因此另外两级都已砍掉（2026-10 实测后决定）：
  - **第 1 级 CORS 直取**对这个站必然失败，只白等一次超时；
  - **第 3 级非 CORS 兜底**能出图，但画布被污染 → `toDataURL` 必抛 `SecurityError` → 这张头像永远提交不进房间。用户看到的是"图明明加载出来了却存不下来"，比"加载失败，请重试"难懂得多。**没有价值的能力不是能力，是陷阱。**
- 代理用的是本项目自建的 EdgeOne Makers 端点（`https://api.jsumc.fun/imgproxy?url=`，实现在另一个仓库 `D:\Code\jsucraft\api` 的 `src/imgproxy.ts`），与「网络地址」入口共用同一个模板 `DEFAULT_PROXY_TEMPLATE`（`src/core/sources/proxyTemplate.ts`）；它统一输出 `Access-Control-Allow-Origin: *`，所以这一跳成功就意味着像素可读、画布不被污染。此前用的是第三方公共代理 `images.weserv.nl`；界面上一向没有、现在也没有改模板的入口，`VITE_IMG_PROXY_TEMPLATE` 只能在构建期换（且 `vite.config.ts` 用同一个变量算 img-src，两边必须一致）；代理不通时直接报错，不退化成能看不能存的图；
- 上游的错误码有语义差别：`404` 表示 Union 里没有这个角色名，`500` 表示该角色所属的成员皮肤站自己挂了（错误页里带具体原因），界面上都只说"没取到"，不臆断成"名字不存在"；
- 「网络地址」入口仍然走完整的三级降级 —— `proxyOnly` 是 MUA 入口的选择，不是 `loadImage` 的默认行为。

### 1.4 画布污染与"皮肤无法编码"

浏览器的安全模型把"画进画布"和"读回像素"分开对待：一张没有 `Access-Control-Allow-Origin` 的图可以被 `drawImage` 绘制（用户看得见），但画布从此被标记为污染（tainted），`toDataURL` / `getImageData` 一律抛 `SecurityError`。

`loadImage` 的三级降级正卡在这条线上：

| 级别 | 做法 | 结果 |
| --- | --- | --- |
| 1 | `crossOrigin='anonymous'` 直取 | `tainted: false`，可导出 |
| 2 | 套代理模板后带 CORS 取 | `tainted: false`，可导出 |
| 3 | 不带 CORS 兜底（保证"至少看得见"） | **`tainted: true`，导出与提交都会失败** |

这张表描述的是 `loadImage` 的默认行为（「网络地址」「正版 ID」等入口）。**MUA 联合认证入口不走这套**：它传 `proxyOnly: true`，只保留第 2 级 —— 因为对那个站第 1 级必然失败、第 3 级只能换回一张存不下来的图（详见 §1.3）。

因此"有 1 个头像的皮肤无法编码"的用户可见现象，成因永远是**这张素材掉到了第 3 级**。典型触发场景是第 2 级代理抖动：

- 代理这一跳在并发或冷启动时会偶发 `Failed to fetch`（旧默认 `images.weserv.nl` 实测 8 个并发里 2 个失败、40 并发时 31/40 超过 8 秒；换成自建端点后 20 并发冷启动 20/20 成功、尾延迟 6.9s）；
- 失败后浏览器会按 URL 记负缓存，同一地址立刻重试往往连请求都不发 —— 所以重试必须换查询参数；
- 一次失败就掉级，于是同一张图"刚才还能显示、现在却提交不了"。

对应实现：

- `src/core/sources/imageLoader.ts` 的 `loadProxied()` 对第 2 级做一次带 `_bfretry` 标记的重试（`withRetryMarker` 改掉缓存键），仍失败才落到第 3 级；
- `SkinTexture.sourceUrl` 记住取图地址（`blob:` 除外，它载入后即被 revoke），`retryTaintedSkins()` 用它把被污染的素材用当前代理重取，**原地换同一个 skinId 背后的位图**，图层与历史记录不受影响；
- **重取必须多次尝试**：每张最多 3 次、单次 4s、总预算 12s（`SKIN_RETRY_ATTEMPTS` / `SKIN_RETRY_TIMEOUT_MS` / `SKIN_RETRY_BUDGET_MS`）。只试一次的话，代理抖一下这张图就救不回来，会被判为无法编码而**跳过不提交** —— 用户点一次「完成」只保存一半，剩下的必须再点一次，这正是"要点两次完成"的由来；
- 提交（`submitChanges`）与发布（`publishRoom`）在发现编码失败时会先自动重取，再决定是继续还是报错；
- 没救回来的皮肤，其说明由 `reportResults()` 和"已保存 N 处改动"**并进同一条提示**（`skipped` 参数），不能单独 `notify` —— 后者会被紧随其后的汇总消息覆盖，用户只看到保存了一半、不知道为什么；
- 报错文案由 `describeEncodeFailure()` 生成：点名是哪个头像、哪张素材，并按是否被污染给出"重取"或"改用上传皮肤"两种可执行动作；
- 素材列表里被污染的条目标 `!`，并在标题栏给一个「重取 N」按钮，不必等提交时才发现。

**修改这块时要守住的不变式**：第 3 级兜底可以保留（它保证"图至少看得见"），但任何依赖像素读出的动作（导出 PNG、提交房间、发布）都必须显式检查 `tainted` 并在失败时告诉用户该怎么做 —— 静默吞掉 `SecurityError` 会把一个可修复的配置问题变成一句没法行动的"无法编码"。

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
BlockFace 采用双层画布设计，两层刻意挂在**不同的坐标系与物理分辨率**上：
- **文档层 (Document Canvas)**：所有图层的 `x, y, size` 均基于文档坐标系（默认文档 1280×800）。它挂在 `.artboard` 内部、随视图一起被 CSS transform 缩放；物理分辨率 = `clampRenderScale(文档尺寸 × 视图倍率 × DPR)`（单边上限 4096px、总像素上限 4096² ≈ 64MB 显存）。手势缩放期间由 CSS 变换即时跟手，停顿 150ms 稳定后再按新倍率重采样。
- **覆盖层 (Overlay Canvas)**：挂在 `.stage__body` 上、**独立于画板**的视口层。物理分辨率恒等于「工作区视口 × DPR」，与文档尺寸和缩放倍率都无关，因此连续缩放/平移期间不会重新分配显存。绘制内容为选中外框、四角缩放手柄与顶部旋转旋钮，文档坐标先经「视口中心 + `view` 平移量」投影成屏幕坐标，再按像素取整绘制（1px 墨线走 +0.5 半像素对齐）。它的重绘由「`view` 平移量 / 工作区尺寸」单独驱动（`scheduleOverlay`），不牵动文档层重绘 —— 这是平移与缩放不掉帧的前提。

### 3.2 基于光标锚点的视口缩放算法
为提供流畅的画布缩放体验，在视口中以光标为中心进行缩放时，必须同时补偿视口中心偏移量：
```ts
// 视图缩放系数 k = nextZoom / currentZoom
// offset：光标相对画板左上角的屏幕偏移；size：画板当前在屏幕上的尺寸（document.width × viewScale）
view.x = view.x + offset.x * (1 - k) + (size.width * (k - 1)) / 2;
view.y = view.y + offset.y * (1 - k) + (size.height * (k - 1)) / 2;
```
`offset × (1 - k)` 抵消画板左上角随缩放产生的漂移，`size × (k - 1) / 2` 补上「画板在容器里居中摆放、尺寸一变就挪半个尺寸差」的位移；漏掉后者内容会整体往一边溜。
- 视口平移与缩放仅作用于渲染视口，**不计入**撤销/重做操作历史（Undo/Redo History）。
- 图层的位置移动、尺寸缩放与旋转角度变更则作为文档操作进入历史记录栈。

---

## 4. 协同房间数据架构

协同房间把「一张图上的全部头像」托管到自建 VPS 上的 FastAPI 后端（SQLite 存元数据 + 本地文件存底图字节），实现多人在线共同编辑。浏览器端皮肤数据格式沿用单机版的内嵌正脸双层方案（见 4.2）；「预设面板 / JSON 文件导入导出」功能已由协同房间取代，`PresetSkin` 结构与记录归一化继续作为房间头像的数据底座。部署方式见 [deploy-vps.md](deploy-vps.md)，接口与上限见 [collab-api.md](collab-api.md)。

### 4.1 存储底座与表布局
- 元数据落 SQLite（`{BF_DATA_DIR}/bfp.sqlite3`）：WAL 日志模式，单连接 + 应用层写锁，所有写路径都走 `Database.transaction()`（`BEGIN IMMEDIATE` + 异常回滚），写与写之间天然串行 —— 业务层不必再叠一把锁，也不会出现两个写者交叉覆盖。
- 底图字节**不进数据库**，落本地文件 `{BF_DATA_DIR}/base/{roomId}.{ext}`：同一间房、同一个后缀只对应一个文件，换底图就是覆盖它并清掉同房间不再被引用的其它后缀，不留孤儿文件。
- multipart 上传的暂存落 `{BF_DATA_DIR}/tmp`：解析器会把 1MB 以上的 part 滚进 `tempfile` 的默认目录，而生产 unit 的 `PrivateTmp=true` 让 `/tmp` 是内存盘（一条 50MiB 底图就白吃 50MiB 内存），所以启动时把 `tempfile.tempdir` 指到数据目录。
- **四张表各有一个主人，物理上互不重叠**（表结构见 `backend/src/bfp/schema.sql`）：

| 表 | 存什么 | 谁写 |
| :-- | :-- | :-- |
| `rooms` | 房间身份：房间号、创建与过期时间、两把密码的 scrypt 哈希与长度 | 只在建房时写一次，此后没有任何代码路径再写它 |
| `room_base` | 底图指针（后缀 / 类型 / 名字）+ 画布尺寸 + 状态 `draft` / `ready` | 只有上传底图这条路 |
| `avatars` | 一个头像一行，联合主键 `(room_id, id)`；布局字段、外观字段（`overlay` / `flipH`）与皮肤字段（`skin_json` 存整份 `PresetSkin` 的 JSON 原文，`NULL` = 这一行没有皮肤）各有各的版本戳 `layout_updated_at` / `appearance_updated_at` / `skin_updated_at` | 只有差量提交这条路，且只写被提到的行与字段 |
| `room_throttle` | 密码试错限流：窗口起点、失败次数、锁定到期时刻 | 只在鉴权失败时 |

- 三个索引各对应一条访问路径：`idx_rooms_expires_at(expires_at)` 与 `idx_room_base_status(status)` 给清扫用（按过期时间捞房间、按状态捞草稿房），`idx_avatars_order(room_id, order_index)` 给进房用（按 `order` 升序取整间房的头像行）。注意落库列名是 `order_index` —— `order` 是 SQL 关键字，对外（JSON 与前端类型）仍然是 `order`，写运维 SQL 时别找错列。
- **为什么拆表**：更早的版本把底图指针、画布尺寸、房间状态与版本号塞在同一份房间元信息里整份回写，后写的那次必然带着自己开头读到的旧快照，把先写的成果覆盖掉 —— 实测能造出「底图指向一个已经被删掉的文件、房间永久打不开」。现在三件事落在互不重叠的表/列上，覆盖从根上不可能发生：`(room_id, id)` 主键就是当年「一个头像一个键」的等价物；布局补丁只 `UPDATE` 布局列，皮肤提交只 `UPDATE` 皮肤列。
- 上限不再由平台决定：旧版受云函数请求体 6MiB 与挂钟 120 秒的硬限，现在只剩磁盘，以及你愿意在反向代理（nginx / Caddy）上放开多大的请求体（默认值见 4.7）。

### 4.2 头像记录与内嵌皮肤格式
- 单条头像记录（`RoomAvatarRecord`）：`id / name / x / y / size / rotation / opacity / overlay / flipH / visible / order / skin / skinUpdatedAt / layoutUpdatedAt / appearanceUpdatedAt`。`order` 决定图层顺序（0 在最底层）；三个版本戳都是服务端生成的并发凭证，**各管各的域**：换皮肤只比对 `skinUpdatedAt`，挪位置只比对 `layoutUpdatedAt`，开关帽子层与水平翻转只比对 `appearanceUpdatedAt`。
- **为什么外观要单占一列戳**：`overlay` / `flipH` 早先跟着布局走。布局只归管理员，外观与皮肤一样编辑者也能改 —— 共用一个戳的话，编辑者换一次皮肤就会把管理员手上的布局凭证顶掉，或者反过来让编辑者连帽子层都动不了。拆开的成本只有一列 `INTEGER NOT NULL DEFAULT 0`：迁移时旧行补 0，`0` 表示这一列从未推进过，`GET` 一律返回 `appearanceUpdatedAt`。
- 皮肤沿用 `PresetSkin`：`dataUrl / width / height / isCustomImage? / frontOnly?`。写入端 `createPresetSkin` 与读取端归一化配对，data URI 只认 png / jpeg / webp 白名单（防 `javascript:` 注入）。
- **正脸双层标记（`frontOnly`）**：16×8 / 32×16 靠尺寸即可自证，但高清皮肤提取出的 64×32 / 128×64 与旧版整肤**同尺寸**，必须随材质携带该标记，否则会被误判成旧版皮肤、从错误区域裁切。
- MC 皮肤入库前只保留正脸双层（底层正脸 8×8 + 帽子外层 8×8 并排，16×8 或高清等比），通用头像图片等比限制在 512px 内，控制单条记录体积。

### 4.3 提交协议（谁能改什么）
- **差量提交（`PATCH /api/rooms/{roomId}/avatars`，写头像的唯一入口）**：请求体是 `{ updates, adds, deletes }` 三件套，服务端只写被提到的行、只写被带上的字段：
  - `updates: [{ id, layout?, appearance?, skin?, expectLayoutUpdatedAt?, expectAppearanceUpdatedAt?, expectSkinUpdatedAt? }]`：`layout` 是布局字段的局部补丁，`appearance` 是 `overlay` / `flipH` 的局部补丁，`skin` 是整份皮肤记录（没带的键一律不动）；三个凭证只在**自己对应的域被写入时**才比对，不符的那一条单独返回 `{ ok: false, error: 'conflict' }`；一条 `update` 三域都没带就是空操作，不写盘也不推戳；
  - `adds: [整行记录]`：id 已被占用回 `exists`，绝不覆盖别人的行；
  - `deletes: [id]`：幂等，不比对版本戳。
  - 逐条返回 `{ results: [{ id, ok, error?, skinUpdatedAt?, layoutUpdatedAt?, appearanceUpdatedAt? }] }`：某一条失败不影响同批其它条目；成功条目回带新版本戳，客户端只把成功的那些行推进基线，失败的原样留在「待提交」里。
  - 角色：编辑者能带 `skin` 与 `appearance`（带了 `layout` 也照样不写入，不报错，其中的 `overlay` / `flipH` 一并不生效），`adds`/`deletes` 一律 403；管理员三者皆可。
  - 边界只有体积：单次请求体上限是 `BF_MAX_JSON_BODY_BYTES`（默认 64MiB；旧云函数版本受平台硬限只有 6MiB），前端 `chunkBySize` 按体积切块、**条数不设限**；单次能提到的行数上限就是「一间房最多 `BF_MAX_LAYERS`（默认 512）行」这个真实上限 —— 服务端是按**房间累计**判的（当前行数 − 本批真实删除 + 本次 adds），不是按请求判。
- **全量覆盖（`PUT /api/rooms/{roomId}`）已拆除**：契约里没有这个端点；`ifRevision` 乐观锁、房间级 `revision`、`MAX_PATCH_UPDATES` 一并消失。
- **删除（`DELETE /api/rooms/{roomId}`）**：仅管理员，物理删除该房间的全部数据 —— `rooms` 里那一行（外键 `ON DELETE CASCADE` 带走 `room_base` / `avatars` / `room_throttle`）与 `base/` 下的底图文件。

### 4.4 底图上传与读取
- **上传 / 更换（`POST /api/rooms/{roomId}/base`）**：`multipart/form-data`，字段 `file`（字节）、`name`（原始文件名，可含中文）、`width` / `height`（画布尺寸就是底图尺寸）；鉴权走 `X-BF-Room-Pwd`。草稿期编辑者或管理员都能传，房间 `ready` 之后**只有管理员**能换。只接受 PNG / JPEG / WebP / GIF，体积上限 `BF_MAX_BASE_IMAGE_BYTES`（默认 50MiB）。上传成功即把房间从 `draft` 切成 `ready` —— **只写 `room_base` 那一行，不碰任何一行头像**。
- **没有预签名直传了**：预签名是「绕过云函数请求体上限」的手段 —— 让浏览器绕过函数、把字节直接 PUT 到对象存储。后端自己就在收字节、收完自己落盘，中间没有第二个跳板，「先申请 URL、再回执确认」这套两步协议也就失去了存在理由。省掉的不只是两次往返：旧协议里「签了名却没确认」会在存储里留一份永远没人引用的死文件，而现在上传只有「成功」和「失败」两种结果。
- **写入是原子的**：先把上传字节写到 `base/` 下的隐藏临时文件（边收边写、边计数，超限立刻 413 并清掉半截文件），收完 `fsync` 再用 `os.replace` 原子换到 `{roomId}.{ext}`，最后删掉该房间其它后缀的旧图。直接往目标文件上写的话，中途崩掉库里指针就指向一张半截图，而且在下一次上传之前它"看起来一直是好的"。
- **覆盖语义**：同一间房、同一个后缀只对应一个文件；换底图 = 覆盖同后缀文件 + 清掉不再被引用的其它后缀，不留孤儿文件（实现见 `backend/src/bfp/storage.py` 与 `backend/src/bfp/base.py`）。
- **认类型只认字节魔数**：不信任客户端声明的 `Content-Type`，用文件头 32 字节判 PNG / JPEG / WebP / GIF。
- **读取（`GET /api/rooms/{roomId}/base`）**：按密码鉴权，响应头带 `Content-Type`、`X-BF-Base-Name`（底图名以 percent-encoding 下发，前端 `decodeURIComponent` 解回原名，解不动回退「底图」）、`X-BF-Base-Variant`（`full` / `preview`）、`X-Content-Type-Options: nosniff` 与 `Cache-Control: private, max-age=60`；草稿态（底图还没传）返回 409。
- **客户端本地缓存（IndexedDB）**：进房时先读上次存下的字节，带着它的 `ETag` 发 `If-None-Match` 问一句 —— 服务端答 `304` 就直接用本地那份渲染，**图一个字节都不用传**；答 200 说明底图换过了，用新的并覆盖本地。
  缓存条目里存的就是 ETag（而 ETag 里含变体），所以"编辑者看到的预览"与"管理员要的原图"天然是两条记录，换底图也会因为 mtime/大小变化自动失效；**没有 ETag 的条目一律不用**（没法验证就等于把"换了底图"永久藏起来），超过 14 天（房间最长寿命）的也清掉。
  全部操作都是尽力而为：隐私模式、配额满、库被删都只是"这次没缓存"，绝不影响进房。删房时顺手把本地那份也删掉。
- **按角色分发像素**：管理员拿原图，其他角色拿预览图（长边 `BF_BASE_PREVIEW_MAX_EDGE`，默认 2048，WebP 优先）。预览在**上传成功后**由服务端生成（Pillow 解码 + LANCZOS 缩放，跑在线程池里），存在 `base/preview/` 子目录 —— 放进子目录而不是 `base/{roomId}.preview.{ext}`，是为了不被原图那套 `{roomId}.*` 的 glob（孤儿清理、备份、回滚）当成"另一种后缀的原图"。预览生成失败**不会**让上传失败：`preview` 落 `NULL`，所有人退回原图。
- **预览不改变坐标空间（唯一的硬约束）**：`doc.width/height` 与 `baseImage.width/height` 永远是**原图**尺寸，预览只是按同一比例缩小的像素源，前端把它按 `cover` 铺满同一个画布盒子，与用原图渲染逐像素对齐。服务端存的是原图像素坐标 —— 一旦让 `doc` 跟着预览变，所有人的头像位置会整体错位。前端 `loadRoomDocument` 因此显式用 `room.doc` 写底图元数据，而不是图片的 `naturalWidth/Height`。
- **动图不生成预览**：多帧 GIF / 动画 WebP 抽一帧给非管理员看属于**内容**不一致（不只是清晰度差异），所以直接跳过预览、退回原图。
- **换底图作废旧预览**：`preview_*` 四列在写主字段的同一个事务里清空，新预览在提交之后生成（解码缩放是慢活，不该占着写锁）；写回览元数据时用 `updated_at` 做守卫，避免并发换图时把旧图的尺寸写上去。
- **老房间回填**：升级前建的房间 `preview_*` 是 NULL，功能不会坏（非管理员直接拿原图），想省带宽就跑 `bfp-ops previews`。
- **代价（要有意识地接受）**：编辑者在自己浏览器里导出时，画布底图用的是预览像素 —— 这是"省带宽"直接换来的取舍，不是 bug。所以前端把这件事摆在两处说：画布正上方一条常驻横条（「预览底图 · 清晰度低于原图，导出同样是这个清晰度」），以及状态栏底图尺寸之后一枚黄金底墨字「预览」徽标。只靠状态栏那行 12px 小字没人会看见，而等到出图才发现糊了，代价比常驻一条横条大得多。需要原图画质时找管理员取。

### 4.5 密码与鉴权
- 编辑密码 8 位、管理员密码 12 位；字符表剔除 `0/1/l/o` 等易混字符，并做拒绝采样保证均匀分布。
- 落库只存 `scrypt$salt$hash`，校验用 `timingSafeEqual` 防时序侧信道；密码仅在创建响应里出现一次，之后任何接口都不回传。
- 请求密码统一走 `X-BF-Room-Pwd` 请求头；密码试错按**房间**计数（默认 60 秒窗口 10 次失败，计数落 SQLite 的 `room_throttle` 表 —— 放进程内存里等于没写，重启就清零），超限回 429 并带上剩余秒数。计数进数据库换来的是：多进程/多实例部署下不会各算各的，重启也不会把已经攒下的失败次数抹掉。已知代价：知道房间号的人可以故意把房主挡在门外一个窗口。
- 前端会话：密码只存 sessionStorage（`blockface-plus.room.<房间号>`），刷新不丢、关标签页即清空；发布成功后暂存的是管理员密码，房主进房即持管理权限。

### 4.6 生命周期与过期
- 过期时间在创建时定死 `expiresAt`：`expiresDays` 只有 **3 / 7 / 14** 三档（白名单，不是区间，与旧云函数一致），前端 UI 的三个按钮与它是同一份值（默认 7）。
- **惰性过期**：任何读路径发现 `expiresAt` 已过 → 就地删掉这个房间（连带头像行、底图文件、限流状态）→ 返回 410 语义，前端停留「房间已过期」界面。房间不会因为「清扫还没跑到」而变成能打开的僵尸。
- **后台定时清扫**：后端是常驻进程，`BF_SWEEP_INTERVAL_SECONDS`（默认 1800 秒）跑一轮，捞出两类残留 —— 已过期的房间，以及超过 `BF_DRAFT_TTL_SECONDS`（默认 1 天）仍然没传底图的草稿房（另外，进程被 kill 时留下的 `.upload` 上传残片会跟着房间一起清掉）；设 `0` 关掉定时清扫，只留惰性过期。手工兜底是 `bfp-ops sweep`（用法见 [deploy-vps.md](deploy-vps.md) §7.3）。
- **为什么不再是「创建时摊销清扫」**：摊销是云函数时代的产物 —— 那个运行时没有常驻进程，只能把清扫摊到请求上，代价是每次建房都要顺手干一件与建房无关的事，还得给单批条数设上限以免把创建接口拖进超时。现在换成定时任务：更直白、更好观测（`journalctl -u blockface-plus-api` 里就能看到每轮的结果），建房接口也不必再背这个包袱。

### 4.7 上限（默认值，除过期档位外都可用环境变量覆盖）

平台硬限消失之后，这些数字只服务于两件事：**防手滑**（挡住明显不是人传的数值）与**给运维一个旋钮**。
完整表格（含每项对应的环境变量与旧版对照）在契约 [collab-api.md §4](collab-api.md)，这里只摘几条：

| 项目 | 环境变量 | 现在 | 旧云函数版本 |
| :-- | :-- | --: | --: |
| 一间房最多多少行头像 | `BF_MAX_LAYERS` | 512 | 512 |
| 单条内嵌皮肤 data URI 字符数 | `BF_MAX_SKIN_DATA_URL_CHARS` | 5000000 | 1500000 |
| 底图字节上限 | `BF_MAX_BASE_IMAGE_BYTES` | 50MiB | 10MiB |
| 预览底图长边上限 | `BF_BASE_PREVIEW_MAX_EDGE` | 2048 | —（没有预览这个概念） |
| JSON 请求体上限 | `BF_MAX_JSON_BODY_BYTES` | 64MiB | 6MiB（平台硬限） |
| 画布边长上限 | `BF_MAX_DOC_SIZE` | 16384 | 8192 |
| 图层坐标绝对值上限 | `BF_MAX_POSITION` | 100000 | 32768 |
| 头像名长度 | `BF_MAX_AVATAR_NAME` | 200 | 200 |
| 过期天数档位 | （写死在代码里） | 3 / 7 / 14 | 3 / 7 / 14 |

过期档位是唯一不挂环境变量的：它必须和前端那三个按钮一致，能单独配就一定会配歪。

两个和运维直接相关的旋钮单独说一句：`BF_AUTH_MAX_FAILS`（窗口内允许的密码失败次数，默认 10）与
`BF_SWEEP_INTERVAL_SECONDS`（后台清扫间隔，默认 1800 秒，`0` = 关闭）。
实际生效的值随时可以用 `curl -s http://127.0.0.1:8088/api/config` 查 —— 它返回的就是后端自己认的那一份，
改了 `api.env` 却忘了重启时，这个接口会立刻告诉你「你改的那个值没生效」。

---

## 5. 测试与工程质量保证

- **单元测试 (Vitest)**：13 个测试套件、212 个单测用例（数字随代码演进，以 `pnpm test` 的输出为准），全面覆盖：
  - 几何变换与手势数学 (`transform.spec.ts`, `gesture.spec.ts`)
  - 皮肤 UV 贴图与规格解析 (`texture.spec.ts`)
  - 皮肤数据格式与头像记录归一化、内嵌材质安全防注入 (`preset.spec.ts`)
  - 离屏缓存 LRU 淘汰与定点清除 (`headCache.spec.ts`)
  - 合成导出与像素对齐 (`compose.spec.ts`)
  - 多数据源回退与超时控制 (`providers.spec.ts`)
  - 素材管理与撤销/重做历史引用保护 (`editor.spec.ts`)
  - 协同差量切块与请求层体积边界 (`collab/api.spec.ts`)
  - 差量计算：只发变了的行与字段、三个版本戳分域、失败的条目保留待提交 (`collab/diff.spec.ts`)
  - 协同房间的进房能力探测、外观降级与提交接线 (`stores/collab.spec.ts`)
- **后端单元测试 (pytest)**：`uv run --directory backend pytest -q`，用 `httpx.AsyncClient` 直接打 ASGI 应用（每个用例一份临时数据目录），覆盖建房 / 进房 / 差量提交 / 版本冲突 / 越权 / 限流 / 过期 / 底图上传与下载 / 上限放宽 / 404 / 410 / 413 / 429。用例数以 `pytest -q` 的输出为准。
- **端到端测试 (CDP-driven)**：`pnpm e2e` 一条命令拉起**真实的 FastAPI 后端**（临时数据目录，跑完即删）与一个临时 Vite dev server，再用 Node.js 原生 DevTools Protocol 驱动本机 Chrome 跑三个阶段（发布 → 编辑者 → 管理员）。三阶段打的是**同一个真实后端**：发布阶段建出来的房间号与两把密码透传给后两个阶段，所以它同时验证了前端、后端与两者之间的协议 —— 不再有页内 mock 后端（`src/dev/collabMock.ts` 已删除）。检查项数以 `pnpm e2e` 的输出为准。
  - **发布阶段**（离线全功能 + 协同发布）：内置皮肤预加载与 UV 像素级核对、拖拽/缩放/旋转/图层顺序/批量导入/导出、无底图时发布被拦下、过期天数随请求走、底图走 multipart 上传到自己的后端（**预签名直传那条老路一次都没被调用**）、上传用编辑密码、房间被切成 `ready`、创建请求快照字段白名单；
  - **编辑者阶段**：布局锁四路拦截、PATCH 只带 `{id, skin, appearance, expectSkinUpdatedAt, expectAppearanceUpdatedAt}`（协议不变性）、服务端位置原封未动、**皮肤戳与外观戳各自前进而布局戳一动不动**、冲突只影响那一条并保留待提交、全量 PUT 一次都没被调用；
  - **管理员阶段**：只有改动过的那一行进 PATCH、布局差量只带变了的字段（x/y）、新增走 `adds` 而非重发整间房、换底图走 multipart 且不碰任何一行头像、删除房间后停在 gone 界面（服务端读回 404）。
  - 每条检查都打印 PASS / FAIL / SKIP，任一阶段没产出结果即判失败（不会被 filter 悄悄吞掉），最后按失败数退出。
