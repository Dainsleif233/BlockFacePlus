/*!
 * BlockFace+ · 协同两阶段 e2e（编辑者 / 管理员）
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 由 tools/run-e2e.mjs 用 cdp.mjs 分别驱动。阶段由查询参数 ?bfstage= 决定，
 * 凭据由 run-e2e.mjs 写一段临时脚本、经 cdp.mjs 的 --pre-file 注入 sessionStorage：
 *   - ?bfstage=editor + { roomId, password: 编辑密码, adminPassword }
 *       编辑者：布局冻结，只能换肤，差量提交 + 冲突回合
 *   - ?bfstage=admin + { roomId, password: 管理员密码, adminPassword }
 *       管理员：挪位置 / 新增 / 换底图，删除房间
 *
 * 与旧版最大的不同：**不再有页内 mock 后端**，打的就是生产用的 FastAPI。
 * 因此观察点有两个：
 *   - `e2e.apiCalls(...)`：fetch 录制器旁听到的"客户端到底发了什么"（协议层断言）；
 *   - `e2e.apiGetRoom(...)`：直接读回房间快照的"服务端到底存成了什么"（事实层断言）。
 * 冲突回合也不再靠 mock 开关，而是用管理员密码从另一个客户端真的改一行，
 * 让编辑者手里的版本戳过期 —— 这样验的是后端真实的并发检查。
 *
 * 密码**不走 URL**：契约第 1 节写着密码绝不进 URL / query / 日志，所以主路径是上面说的 sessionStorage
 * 注入（见 run-e2e.mjs 的 writeCreds）。这里仍兼容手工调试时直接写 ?bfpwd=&bfadmin= 的写法；
 * 走 URL 的那条路读完立刻把它从地址栏抹掉。
 */

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 凭据：主路径是 run-e2e.mjs 注入的 sessionStorage，URL 参数只作为手工调试的兜底。
 *  不在这里删掉 sessionStorage —— 它待的是一次性 Chrome 配置目录，而删早了万一页面还重载一次就没了。 */
function readInjectedCreds() {
  try {
    return JSON.parse(window.sessionStorage.getItem('bfp-e2e-creds') || '{}');
  } catch {
    return {};
  }
}

const params = new URLSearchParams(window.location.search);
const injected = readInjectedCreds();
const stage = params.get('bfstage');
const roomId = injected.roomId || params.get('room') || '';
const password = injected.password || params.get('bfpwd') || '';
const adminPassword = injected.adminPassword || params.get('bfadmin') || (stage === 'admin' ? password : '');
const isEditor = stage === 'editor';
if (!roomId) throw new Error('缺少房间号（run-e2e.mjs 会注入，手工调试可加 ?room=）');
if (stage !== 'editor' && stage !== 'admin') throw new Error('未知阶段：' + stage);
if (!password) throw new Error('缺少房间密码（run-e2e.mjs 会注入，手工调试可加 ?bfpwd=）');
if (!adminPassword) throw new Error('缺少管理员密码（冲突回合要用它从另一个客户端改一行）');

const e2e = await import('/tools/e2e-support.js');
e2e.installFetchRecorder();
// 凭据已经读进内存，别留在地址栏里
e2e.scrubCredentialParams();

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

const collabStore = await import('/src/stores/collab.ts');
const editorStore = await import('/src/stores/editor.ts');
// 与 tools/e2e.js 相同的约定：main.ts 在 DEV 下把 store 挂到了 window
const editor = window.__blockface.editor;

/** 行内的版本戳与布局字段拼成一条可比较的指纹 */
function stampsOf(snapshot) {
  return (snapshot.avatars || []).map((a) => a.id + ':' + a.skinUpdatedAt + ':' + a.layoutUpdatedAt).sort().join('|');
}

await sleep(600);
check('无密码时停在门禁', collabStore.collab.phase === 'gate', collabStore.collab.phase);

await collabStore.submitGate(password);
await sleep(2500);
check('密码对了进入房间且角色正确',
  collabStore.collab.phase === 'ready' && collabStore.collab.role === (isEditor ? 'editor' : 'admin'),
  JSON.stringify({ phase: collabStore.collab.phase, role: collabStore.collab.role }));
check('布局锁状态与角色一致', collabStore.locked.value === isEditor, String(collabStore.locked.value));

// 事实层基线：服务端此刻到底有什么
const entry = await e2e.apiGetRoom(roomId, password);
check('能用房间密码读回快照',
  entry.status === 200 && !!entry.data && !!entry.data.room,
  'HTTP ' + entry.status + ' / ' + JSON.stringify(entry.data && entry.data.error));
if (entry.status !== 200 || !entry.data || !entry.data.avatars) {
  check('进入房间后图层可用', false,
    'phase=' + collabStore.collab.phase + ' / roomMsg=' + collabStore.collab.message + ' / HTTP ' + entry.status);
  const failedEarly = results.filter((r) => !r.pass);
  return { total: results.length, failed: failedEarly.length, skipped: 0, results };
}

const entryAvatars = entry.data.avatars;
const initialCount = entryAvatars.length;
check('底图与全部头像就位',
  editor.document.width === entry.data.room.doc.width && editor.document.height === entry.data.room.doc.height
    && editor.layers.length === initialCount,
  editor.document.width + '×' + editor.document.height + ' / ' + editor.layers.length + ' 个（服务端 ' + initialCount + ' 个）');
check('服务端房间已就绪且有底图',
  entry.data.room.status === 'ready' && !!entry.data.room.baseImage && entry.data.room.baseImage.width === editor.document.width,
  JSON.stringify({ status: entry.data.room.status, base: entry.data.room.baseImage }));

const firstRecord = entryAvatars[0];
const secondRecord = entryAvatars[1];
const first = editor.layers.find((l) => l.id === firstRecord.id);
check('服务器 id 保留在图层上', !!first, editor.layers.map((l) => l.id).join(','));
if (!first) {
  check('进入房间后图层可用', false,
    'phase=' + collabStore.collab.phase + ' / roomMsg=' + collabStore.collab.message
    + ' / layers=' + JSON.stringify(editor.layers.map((l) => l.id))
    + ' / server=' + JSON.stringify(entryAvatars.map((a) => a.id)));
  const failedEarly = results.filter((r) => !r.pass);
  return { total: results.length, failed: failedEarly.length, skipped: 0, results };
}
editorStore.selectLayer(first.id);
await sleep(150);

if (isEditor) {
  const xBefore = first.x;
  const skinStampBefore = firstRecord.skinUpdatedAt;
  const layoutStampBefore = firstRecord.layoutUpdatedAt;
  const secondStampBefore = secondRecord ? (secondRecord.skinUpdatedAt + ':' + secondRecord.layoutUpdatedAt) : '';

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
  check('编辑者新增头像被拒绝', editor.layers.length === initialCount && editor.notice && editor.notice.tone === 'warn',
    editor.layers.length + ' / ' + (editor.notice && editor.notice.message));

  e2e.resetApiCalls();
  await collabStore.submitChanges();
  await sleep(2000);
  check('增量提交成功清空待提交', collabStore.dirtyCount.value === 0, String(collabStore.dirtyCount.value));

  const patchCalls = e2e.apiCalls({ method: 'PATCH', pathEndsWith: '/avatars' });
  const updates = patchCalls.flatMap((c) => (c.body && c.body.updates) || []);
  const adds = patchCalls.flatMap((c) => (c.body && c.body.adds) || []);
  check('PATCH 只带皮肤与并发凭证',
    updates.length === 1 && updates[0].id === first.id && !!updates[0].skin && typeof updates[0].skin.dataUrl === 'string',
    updates.length ? Object.keys(updates[0]).join(',') : '没有 PATCH');
  check('PATCH 没带位置字段（协议不变性）',
    updates.length > 0 && !('x' in updates[0]) && !('y' in updates[0]) && !('size' in updates[0]) && !('layout' in updates[0]),
    updates.length ? 'ok' : '没有 PATCH');
  check('PATCH 用的是编辑密码', patchCalls.length > 0 && patchCalls[0].password === password,
    patchCalls.length ? ('pwd=' + (patchCalls[0].password ? '<' + patchCalls[0].password.length + ' 位>' : '无')) : '没有 PATCH');
  check('编辑者这轮没有误发新增', adds.length === 0, String(adds.length));

  const after = await e2e.apiGetRoom(roomId, password);
  const stored = e2e.avatarOf(after.data, first.id);
  const storedSecond = e2e.avatarOf(after.data, secondRecord ? secondRecord.id : '');
  check('服务端位置原封未动', !!stored && stored.x === xBefore && !!stored.skin && stored.skin.dataUrl.length > 0,
    stored ? (stored.x + ' / skin=' + (stored.skin ? stored.skin.dataUrl.length : 0)) : '读不到这一行');
  check('服务端皮肤版本戳前进', !!stored && stored.skinUpdatedAt > skinStampBefore,
    stored ? String(stored.skinUpdatedAt) : '');
  check('服务端布局版本戳没被动过（这次只换了皮肤）',
    !!stored && stored.layoutUpdatedAt === layoutStampBefore,
    stored ? String(stored.layoutUpdatedAt) : '');
  check('没动过的那一行版本戳原样',
    !secondRecord || (!!storedSecond && (storedSecond.skinUpdatedAt + ':' + storedSecond.layoutUpdatedAt) === secondStampBefore),
    storedSecond ? (storedSecond.skinUpdatedAt + ':' + storedSecond.layoutUpdatedAt) : '只有一行');
  check('全量覆盖那条老路一次都没被调用', e2e.apiCalls({ method: 'PUT' }).length === 0,
    'PUT 次数=' + e2e.apiCalls({ method: 'PUT' }).length);

  // —— 冲突回合：用管理员密码从"另一个客户端"改同一行，编辑者手里的版本戳随即过期 ——
  const injected = await e2e.apiPatchAvatars(roomId, adminPassword, {
    updates: [{
      id: first.id,
      skin: { dataUrl: makeFaceDataUrl('rgb(12,12,12)', 'rgb(238,238,238)'), width: 16, height: 8, frontOnly: true },
      expectSkinUpdatedAt: stored ? stored.skinUpdatedAt : skinStampBefore,
    }],
  });
  const injectedResult = injected.data && injected.data.results ? injected.data.results[0] : null;
  const injectedStamp = injectedResult && injectedResult.ok ? injectedResult.skinUpdatedAt : null;
  check('另一个客户端先改掉了同一行（制造真实并发）',
    injected.status === 200 && !!injectedResult && injectedResult.ok === true && typeof injectedStamp === 'number',
    'HTTP ' + injected.status + ' / ' + JSON.stringify(injected.data));

  await editorStore.useSkinFile(new File([await makePng(64, 32, '#ff8a00')], 'again.png', { type: 'image/png' }));
  await sleep(600);
  check('第二处改动进入待提交', collabStore.dirtyCount.value === 1, String(collabStore.dirtyCount.value));

  e2e.resetApiCalls();
  await collabStore.submitChanges();
  await sleep(2000);
  check('冲突后保留待提交并给出提示',
    collabStore.dirtyCount.value === 1 && editor.notice && editor.notice.tone === 'warn',
    collabStore.dirtyCount.value + ' / ' + (editor.notice && editor.notice.message));
  const retryUpdates = e2e.apiCalls({ method: 'PATCH', pathEndsWith: '/avatars' })
    .flatMap((c) => (c.body && c.body.updates) || []);
  check('冲突请求带了（已经过期的）皮肤并发凭证',
    retryUpdates.length === 1 && typeof retryUpdates[0].expectSkinUpdatedAt === 'number',
    retryUpdates.length ? String(retryUpdates[0].expectSkinUpdatedAt) : '没有 PATCH');
  const afterConflict = await e2e.apiGetRoom(roomId, password);
  const untouched = e2e.avatarOf(afterConflict.data, first.id);
  check('冲突时服务端没有被写脏（保持外部客户端写的那份，过期提交没有落库）',
    !!untouched && untouched.layoutUpdatedAt === layoutStampBefore
      && (injectedStamp === null || untouched.skinUpdatedAt === injectedStamp),
    untouched
      ? ('服务端 ' + untouched.skinUpdatedAt + ' / 期望 ' + injectedStamp + '，布局 ' + untouched.layoutUpdatedAt + ' / 期望 ' + layoutStampBefore)
      : '');
} else {
  const layoutStampBefore = firstRecord.layoutUpdatedAt;
  const secondStampBefore = secondRecord ? secondRecord.layoutUpdatedAt : 0;

  // —— 管理员：挪位置 + 新增，走的都是差量 ——
  editorStore.updateLayer(first.id, { x: 50, y: 60 });
  editorStore.addAvatar();
  await sleep(300);
  check('管理员可以挪位置和新增头像',
    editor.layers.length === initialCount + 1 && editor.layers.find((l) => l.id === first.id).x === 50,
    editor.layers.length + ' / x=' + editor.layers.find((l) => l.id === first.id).x);

  e2e.resetApiCalls();
  await collabStore.submitChanges();
  await sleep(2500);
  check('差量提交成功', editor.notice && editor.notice.tone === 'success', editor.notice && editor.notice.message);

  const patchCalls = e2e.apiCalls({ method: 'PATCH', pathEndsWith: '/avatars' });
  const updates = patchCalls.flatMap((c) => (c.body && c.body.updates) || []);
  const adds = patchCalls.flatMap((c) => (c.body && c.body.adds) || []);
  const deletes = patchCalls.flatMap((c) => (c.body && c.body.deletes) || []);
  const layoutOf = (updates[0] && updates[0].layout) || {};
  check('只提交改动过的那一行',
    updates.length === 1 && updates[0].id === first.id,
    'updates=' + updates.length + ' ids=' + updates.map((u) => u.id).join(','));
  check('布局差量只带变了的字段 x/y',
    JSON.stringify(Object.keys(layoutOf)) === '["x","y"]',
    Object.keys(layoutOf).join(','));
  check('布局差量带的是布局版本戳',
    updates.length === 1 && updates[0].expectLayoutUpdatedAt === layoutStampBefore && updates[0].expectSkinUpdatedAt === undefined,
    updates.length ? JSON.stringify({ layout: updates[0].expectLayoutUpdatedAt, skin: updates[0].expectSkinUpdatedAt }) : '没有 PATCH');
  check('新增的头像走 adds，没有重发整间房',
    adds.length === 1 && adds[0].id === editor.layers[editor.layers.length - 1].id
      && !!adds[0].skin && typeof adds[0].skin.dataUrl === 'string',
    'adds=' + adds.length + ' id=' + (adds[0] ? adds[0].id : '-'));
  check('没有误报删除', deletes.length === 0, String(deletes.length));
  check('全量覆盖那条老路一次都没被调用', e2e.apiCalls({ method: 'PUT' }).length === 0,
    'PUT 次数=' + e2e.apiCalls({ method: 'PUT' }).length);

  const afterAdmin = await e2e.apiGetRoom(roomId, password);
  const stored = e2e.avatarOf(afterAdmin.data, first.id);
  const storedSecond = e2e.avatarOf(afterAdmin.data, secondRecord ? secondRecord.id : '');
  check('位置变更在服务端生效',
    afterAdmin.data.avatars.length === initialCount + 1 && !!stored && stored.x === 50,
    afterAdmin.data.avatars.length + ' / ' + afterAdmin.data.avatars.map((a) => a.x).join(','));
  check('没动过的那一行版本戳没变',
    !secondRecord || (!!storedSecond && storedSecond.layoutUpdatedAt === secondStampBefore),
    storedSecond ? String(storedSecond.layoutUpdatedAt) : '只有一行');

  // —— 管理员换底图：一次 multipart 上传，只动底图，一根头像头发都不碰 ——
  const stampsBeforeSwap = stampsOf(afterAdmin.data);
  const swapBlob = await makePng(320, 200, '#009966');
  await editorStore.setBaseImage(new File([swapBlob], '新底图.png', { type: 'image/png' }));
  await sleep(900);
  e2e.resetApiCalls();
  await collabStore.submitChanges();
  await sleep(2500);
  check('换底图成功',
    editor.notice && editor.notice.tone === 'success',
    editor.notice && editor.notice.message);

  const baseCalls = e2e.apiCalls({ method: 'POST', pathEndsWith: '/base' });
  const baseCall = baseCalls[0];
  check('换底图走 multipart 上传到自己的后端',
    !!baseCall && !!baseCall.fields && String(baseCall.fields.file).indexOf('<file:') === 0 && baseCall.bytes > 1000,
    baseCall ? (JSON.stringify(baseCall.fields) + ' / ' + baseCall.bytes + ' bytes') : '没有上传请求');
  check('multipart 的类型头交给浏览器带 boundary（客户端不手写 Content-Type）',
    !!baseCall && baseCall.contentType === '',
    baseCall ? ('Content-Type=' + JSON.stringify(baseCall.contentType)) : '没有上传请求');
  check('换底图也用管理员密码', !!baseCall && baseCall.password === password, baseCall ? 'ok' : '没有上传请求');

  const afterSwap = await e2e.apiGetRoom(roomId, password);
  check('服务端底图已更新且仍为 ready',
    afterSwap.status === 200 && afterSwap.data.room.status === 'ready'
      && !!afterSwap.data.room.baseImage && afterSwap.data.room.baseImage.name.indexOf('新底图') >= 0,
    afterSwap.status === 200 ? JSON.stringify(afterSwap.data.room.baseImage) : ('HTTP ' + afterSwap.status));
  check('换底图没有改动任何一行头像',
    stampsOf(afterSwap.data) === stampsBeforeSwap, stampsOf(afterSwap.data));
  check('只换底图时不发多余的差量',
    e2e.apiCalls({ method: 'PATCH', pathEndsWith: '/avatars' }).length === 0,
    'PATCH 次数=' + e2e.apiCalls({ method: 'PATCH', pathEndsWith: '/avatars' }).length);
  check('换底图也没走全量覆盖那条路', e2e.apiCalls({ method: 'PUT' }).length === 0,
    'PUT 次数=' + e2e.apiCalls({ method: 'PUT' }).length);

  // —— 删除房间 ——
  await collabStore.removeRoom();
  await sleep(1500);
  check('删除房间后停在 gone 界面', collabStore.collab.phase === 'gone', collabStore.collab.phase);
  const gone = await e2e.apiGetRoom(roomId, password);
  check('服务端房间已经真的没了（读回 404）', gone.status === 404, 'HTTP ' + gone.status);
}

const failed = results.filter((r) => !r.pass);
return { total: results.length, failed: failed.length, skipped: 0, results };
