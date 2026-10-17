-- BlockFace+ · SQLite 表结构
-- Copyright 2026 Dainsleif · Apache License 2.0
--
-- 拆表的理由和旧版一致：一间房里三件事（身份 / 底图 / 头像行）必须落在互不重叠的键上，
-- 否则"换底图"和"换头像"的整份回写会互相覆盖。到了 SQLite 里，这件事由行级 UPDATE 保证：
--   rooms        房间身份：只在建房时写一次，此后再没有任何代码路径会写它
--   room_base    底图指针 + 画布尺寸 + 房间状态（draft/ready）：只有上传底图这条路会写
--   avatars      一个头像一行：布局字段与皮肤字段各有各的版本戳，改一个不动另一个
--   room_throttle 密码试错限流：按房间算，状态落盘（放内存里等于没写）
--
-- 所有写路径都走 Database.transaction()（单连接 + 写锁 + BEGIN IMMEDIATE），
-- 所以这里不需要额外加锁，也不存在两个写者交叉覆盖的可能。

CREATE TABLE IF NOT EXISTS rooms (
  room_id               TEXT    PRIMARY KEY,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  edit_password_hash    TEXT    NOT NULL,
  admin_password_hash   TEXT    NOT NULL,
  -- 记下密码长度：校验时长度对不上的一把根本不用去算 scrypt（见 security.check_password）
  edit_password_length  INTEGER NOT NULL,
  admin_password_length INTEGER NOT NULL
);

-- 过期清扫按 expires_at 找房间，走索引别全表扫
CREATE INDEX IF NOT EXISTS idx_rooms_expires_at ON rooms (expires_at);

CREATE TABLE IF NOT EXISTS room_base (
  room_id    TEXT    PRIMARY KEY REFERENCES rooms (room_id) ON DELETE CASCADE,
  -- 底图字节的后缀（png/jpg/webp/gif）；draft 期就是创建时声明的那个，上传时按真实类型改写
  ext        TEXT    NOT NULL,
  type       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  -- 画布尺寸就是底图尺寸，只有这一份真相，不再存第二份
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  status     TEXT    NOT NULL CHECK (status IN ('draft', 'ready')),
  updated_at INTEGER NOT NULL,
  -- 预览底图（非管理员下载的那一份）：前缀 + MIME + 尺寸。
  -- 四个字段要么同时有值、要么同时为 NULL（NULL = 没有预览，退回原图）。
  -- 注意 width/height 仍然只描述**原图**：预览是按同一比例缩小的像素源，
  -- 绝不能拿它的尺寸去当坐标空间，否则头像位置会整体错位。
  preview_ext    TEXT,
  preview_type   TEXT,
  preview_width  INTEGER,
  preview_height INTEGER
);

-- 草稿房超时清扫要按状态捞
CREATE INDEX IF NOT EXISTS idx_room_base_status ON room_base (status);

CREATE TABLE IF NOT EXISTS avatars (
  room_id           TEXT    NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
  id                TEXT    NOT NULL,
  -- 布局字段：布局补丁只覆盖这几列
  name              TEXT    NOT NULL,
  x                 REAL    NOT NULL,
  y                 REAL    NOT NULL,
  size              INTEGER NOT NULL,
  rotation          INTEGER NOT NULL,
  opacity           REAL    NOT NULL,
  overlay           INTEGER NOT NULL,
  flip_h            INTEGER NOT NULL,
  visible           INTEGER NOT NULL,
  -- "order" 是 SQL 关键字，落库叫 order_index，对外仍叫 order
  order_index       INTEGER NOT NULL,
  -- 皮肤字段：整份 PresetSkin 的 JSON 原文；NULL 表示这一行没有皮肤
  skin_json         TEXT,
  skin_updated_at   INTEGER NOT NULL,
  layout_updated_at INTEGER NOT NULL,
  -- 同一间房里一个头像 id 只有一行：这就是旧版"头像/<${id}>.json 一个键"的等价物
  PRIMARY KEY (room_id, id)
);

-- 进房时按 order 升序取全部行
CREATE INDEX IF NOT EXISTS idx_avatars_order ON avatars (room_id, order_index);

CREATE TABLE IF NOT EXISTS room_throttle (
  room_id      TEXT    PRIMARY KEY REFERENCES rooms (room_id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  fail_count   INTEGER NOT NULL,
  -- 非空表示这个房间正被锁着，锁到这一刻为止
  locked_until INTEGER
);
