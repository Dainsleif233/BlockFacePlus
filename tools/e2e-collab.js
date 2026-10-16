/*!
 * BlockFace+ · 协同两阶段 e2e（编辑者 / 管理员）
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 由 tools/run-e2e.mjs 用 cdp.mjs 分别驱动，阶段由 URL 参数决定：
 *   - ?room=<id>&bfstage=editor   编辑者：布局冻结，只能换肤，PATCH 增量 + 冲突回合
 *   - ?room=<id>&bfstage=admin    管理员：全量同步（挪动/新增）+ 删除房间
 *
 * 后端由 /src/dev/collabMock.ts 在页内模拟；房间号与密码由发布阶段的
 * window.__BFPLUS_PUBLISH__ 结果带过来（mock 两侧用同一组硬编码密码）。
 */

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与发布阶段（tools/e2e.js 8b 节）保持一致
const EDIT_PWD = 'edit-e2e';
const ADMIN_PWD = 'admin-e2e-12';

const params = new URLSearchParams(window.location.search);
const stage = params.get('bfstage');
const roomId = params.get('room') || 'e2eroom00';
const isEditor = stage === 'editor';
const password = isEditor ? EDIT_PWD : ADMIN_PWD;
if (!params.get('room')) throw new Error('缺少 ?room= 参数');
if (stage !== 'editor' && stage !== 'admin') throw new Error('未知阶段：' + stage);

// e2e 测试口：removeRoom 不真的导航，停在 gone 界面方便断言
window.__BFPLUS_E2E_STAY__ = true;

/** 造一张 w×h 的纯色 PNG blob（合法皮肤尺寸：64×32/64×64） */
async function makePng(w, h, color) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color || '#3b6ea5';
  ctx.fillRect(0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** 造一条 16×8 正脸双层 data URI：左半是脸，右半是帽子 */
function makeFaceDataUrl(face, hat) {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = face;
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillStyle = hat;
  ctx.fillRect(8, 0, 8, 8);
  return canvas.toDataURL('image/png');
}

const { installCollabMock } = await import('/src/dev/collabMock.ts');

const mock = installCollabMock({
  roomId,
  editPassword: EDIT_PWD,
  adminPassword: ADMIN_PWD,
  doc: { width: 320, height: 200 },
  baseImage: { name: '底图.png', type: 'image/png', width: 320, height: 200 },
  baseBlob: await makePng(320, 200),
  avatars: [
    {
      id: 'srv-1', name: '头像一', x: 40, y: 50, size: 100, rotation: 0, opacity: 1,
      overlay: true, flipH: false, visible: true, order: 0,
      skin: { dataUrl: makeFaceDataUrl('rgb(200,60,60)', 'rgb(60,60,200)'), width: 16, height: 8, frontOnly: true },
      updatedAt: 1000,
    },
    {
      id: 'srv-2', name: '头像二', x: 180, y: 70, size: 80, rotation: 0, opacity: 1,
      overlay: true, flipH: false, visible: true, order: 1,
      skin: { dataUrl: makeFaceDataUrl('rgb(60,180,60)', 'rgb(180,180,60)'), width: 16, height: 8, frontOnly: true },
      updatedAt: 1001,
    },
  ],
});

const collabStore = await import('/src/stores/collab.ts');
const editorStore = await import('/src/stores/editor.ts');
// 与 tools/e2e.js 相同的约定：main.ts 在 DEV 下把 store 挂到了 window
const editor = window.__blockface.editor;

await sleep(600);
check('无密码时停在门禁', collabStore.collab.phase === 'gate', collabStore.collab.phase);

await collabStore.submitGate(password);
await sleep(1500);
check('密码对了进入房间且角色正确',
  collabStore.collab.phase === 'ready' && collabStore.collab.role === (isEditor ? 'editor' : 'admin'),
  JSON.stringify({ phase: collabStore.collab.phase, role: collabStore.collab.role }));
check('底图与两个头像就位',
  editor.document.width === 320 && editor.document.height === 200 && editor.layers.length === 2,
  editor.document.width + '×' + editor.document.height + ' / ' + editor.layers.length + ' 个');
check('布局锁状态与角色一致', collabStore.locked.value === isEditor, String(collabStore.locked.value));

const first = editor.layers.find((l) => l.id === 'srv-1');
check('服务器 id 保留在图层上', !!first, editor.layers.map((l) => l.id).join(','));
if (!first) {
  // 关键路径断了：把现场打出来再收尾，别让后续断言无从谈起
  check('进入房间后图层可用', false,
    'phase=' + collabStore.collab.phase + ' / roomMsg=' + collabStore.collab.message +
    ' / layers=' + JSON.stringify(editor.layers.map((l) => l.id)) +
    ' / mockCalls=' + JSON.stringify(mock.calls.map((c) => c.method + ' ' + c.path + ' pwd=' + (c.password ? 'y' : 'n'))));
  const failedEarly = results.filter((r) => !r.pass);
  return { total: results.length, failed: failedEarly.length, skipped: 0, results };
}
editorStore.selectLayer(first.id);
await sleep(150);

if (isEditor) {
  const xBefore = first.x;

  // 换肤走真实文件路径
  const skinBlob = await makePng(64, 32, '#8a4fff');
  await editorStore.useSkinFile(new File([skinBlob], 'newskin.png', { type: 'image/png' }));
  await sleep(700);
  check('换肤后待提交计数 1', collabStore.dirtyCount.value === 1, String(collabStore.dirtyCount.value));

  editorStore.updateLayer(first.id, { x: 999 });
  await sleep(200);
  check('编辑者挪位置被拒绝', first.x === xBefore && editor.notice && editor.notice.tone === 'warn',
    first.x + ' / ' + (editor.notice && editor.notice.message));
  editorStore.addAvatar();
  await sleep(200);
  check('编辑者新增头像被拒绝', editor.layers.length === 2 && editor.notice && editor.notice.tone === 'warn',
    editor.layers.length + ' / ' + (editor.notice && editor.notice.message));

  await collabStore.submitChanges();
  await sleep(1000);
  check('增量提交成功清空待提交', collabStore.dirtyCount.value === 0, String(collabStore.dirtyCount.value));
  const patch = mock.state.lastPatchUpdates;
  check('PATCH 只带皮肤与并发凭证',
    !!patch && patch.length === 1 && patch[0].id === 'srv-1' && typeof patch[0].skin.dataUrl === 'string',
    patch ? Object.keys(patch[0]).join(',') : '没有 PATCH');
  check('PATCH 没带位置字段（协议不变性）',
    !!patch && !('x' in patch[0]) && !('y' in patch[0]) && !('size' in patch[0]),
    patch ? 'ok' : '没有 PATCH');
  const stored = mock.state.avatars.find((a) => a.id === 'srv-1');
  check('服务端位置原封未动', stored.x === xBefore && !!stored.skin && stored.skin.dataUrl.length > 0,
    stored.x + ' / skin=' + (stored.skin ? stored.skin.dataUrl.length : 0));
  check('PATCH 后 revision 前进', mock.state.revision > 3, String(mock.state.revision));
  check('编辑阶段无协议违规', mock.violations.length === 0, mock.violations.join('；'));

  // 冲突回合：mock 掐掉时间戳校验 → 全部 conflict
  mock.setConflictAll(true);
  await editorStore.useSkinFile(new File([await makePng(64, 32, '#ff8a00')], 'again.png', { type: 'image/png' }));
  await sleep(500);
  check('第二处改动进入待提交', collabStore.dirtyCount.value === 1, String(collabStore.dirtyCount.value));
  await collabStore.submitChanges();
  await sleep(1000);
  check('冲突后保留待提交并给出提示',
    collabStore.dirtyCount.value === 1 && editor.notice && editor.notice.tone === 'warn',
    collabStore.dirtyCount.value + ' / ' + (editor.notice && editor.notice.message));
  const retry = mock.state.lastPatchUpdates;
  check('冲突请求带了并发凭证', !!retry && retry.length === 1 && retry[0].expectUpdatedAt !== undefined,
    retry ? String(retry[0].expectUpdatedAt) : '没有 PATCH');
} else {
  // —— 管理员：挪位置 + 新增 + 全量同步 ——
  editorStore.updateLayer(first.id, { x: 50, y: 60 });
  editorStore.addAvatar();
  await sleep(300);
  check('管理员可以挪位置和新增头像',
    editor.layers.length === 3 && editor.layers.find((l) => l.id === 'srv-1').x === 50,
    editor.layers.length + ' / x=' + editor.layers.find((l) => l.id === 'srv-1').x);

  await collabStore.submitChanges();
  await sleep(1200);
  check('全量同步成功', editor.notice && editor.notice.tone === 'success', editor.notice && editor.notice.message);
  const put = mock.state.lastPut;
  check('PUT 带了 ifRevision 凭证', !!put && put.ifRevision === 3, put ? String(put.ifRevision) : '没有 PUT');
  check('PUT 全量包含 3 条头像', !!put && put.layers.length === 3, put ? String(put.layers.length) : '没有 PUT');
  check('位置变更在服务端生效',
    mock.state.avatars.length === 3 && mock.state.avatars.find((a) => a.id === 'srv-1').x === 50,
    mock.state.avatars.length + ' / ' + mock.state.avatars.map((a) => a.x).join(','));
  check('PUT 后 revision 前进', mock.state.revision > 3, String(mock.state.revision));

  // —— 管理员换底图：走预签名直传 + 回执确认，再随全量同步落图层 ——
  const swapBlob = await makePng(320, 200, '#009966');
  await editorStore.setBaseImage(new File([swapBlob], '新底图.png', { type: 'image/png' }));
  await sleep(600);
  await collabStore.submitChanges();
  await sleep(1500);
  check('换底图后全量同步成功',
    editor.notice && editor.notice.tone === 'success',
    editor.notice && editor.notice.message);
  check('新底图字节直传到了存储（绕过函数）',
    mock.state.uploadedBytes > 1000, mock.state.uploadedBytes + ' bytes');
  check('mock 底图信息已更新且仍为 ready',
    // editor 存底图名时约定剥掉扩展名
    mock.state.baseImage && mock.state.baseImage.name === '新底图' && mock.state.status === 'ready',
    mock.state.baseImage ? mock.state.baseImage.name : '没有底图');
  check('换底图后 revision 继续前进', mock.state.revision > 4, String(mock.state.revision));

  // —— 删除房间 ——
  await collabStore.removeRoom();
  await sleep(800);
  check('删除房间后停在 gone 界面', collabStore.collab.phase === 'gone', collabStore.collab.phase);
  check('mock 里房间已标记删除', mock.state.deleted, String(mock.state.deleted));
}

const failed = results.filter((r) => !r.pass);
return { total: results.length, failed: failed.length, skipped: 0, results };
