#!/usr/bin/env node
/**
 * 一条命令跑完浏览器端到端测试：
 *   1. 用 uv 起真实的 FastAPI 后端（临时数据目录，跑完即删）
 *   2. 起一个临时 vite dev server（把 /api 代理到上面那个后端）
 *   3. 用 tools/cdp.mjs 驱动本机 Chrome 分三个阶段执行：
 *        A. 离线发布   tools/e2e.js        （?bfstage=publish，真实建房 + 上传底图）
 *        B. 编辑者进房 tools/e2e-collab.js （?room=<id>&bfstage=editor，布局冻结换肤 + 并发冲突）
 *        C. 管理员进房 tools/e2e-collab.js （?room=<id>&bfstage=admin，差量提交 + 换底图 + 删房）
 *   4. 合并打印结果并按失败数退出
 *
 * 与旧版的区别：**不再有页内 mock 后端**。A 阶段建出来的房间凭据（房间号 + 两把密码）
 * 由这里透传给 B/C 阶段，B/C 打的都是同一个真实后端 —— 也就是说 `pnpm e2e` 同时验证了
 * 前端、后端与它们之间的协议。
 *
 * 凭据**不走 URL 查询参数**（旧版做法）：契约第 1 节与 design-spec 都写着密码「绝不进 URL / query /
 * 日志」，这个仓库自己的测试工具更不该示范一件产品明令禁止的事 —— 浏览器历史、CDP 日志、
 * 排错时打印出来的 URL 都会顺手把它带走。改成写一个临时脚本文件，交给 cdp.mjs 的 --pre-file
 * 注入 sessionStorage，阶段脚本再去读；文件在系统临时目录里，不进仓库也不进 argv，跑完即删。
 *
 * 用法：node tools/run-e2e.mjs
 * 依赖：uv（可用 BF_UV 指定可执行文件）、本机装了 Chrome（可用 BF_CHROME 指定）
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = process.env.BF_E2E_PORT || '5179';
const API_PORT = process.env.BF_E2E_API_PORT || '8099';
const base = 'http://localhost:' + PORT + '/';
const apiBase = 'http://127.0.0.1:' + API_PORT;
const UV = process.env.BF_UV || (process.platform === 'win32' ? 'uv.exe' : 'uv');
// 每次跑用一套全新的数据目录：上一次的房间、限流状态、底图字节都不会漏进来
const DATA_DIR = join(tmpdir(), 'bfp-e2e-' + Date.now());
// 阶段凭据的落脚处（见文件头：不走 URL，写临时脚本再由 --pre-file 注入）
const CREDS_DIR = mkdtempSync(join(tmpdir(), 'bfp-e2e-creds-'));

function writeCreds(name, payload) {
  const file = join(CREDS_DIR, name + '.js');
  writeFileSync(file, 'window.sessionStorage.setItem("bfp-e2e-creds", ' + JSON.stringify(JSON.stringify(payload)) + ');', 'utf8');
  return file;
}

// 起服务之前先确认端口真的空着（理由见 assertPortFree）
await assertPortFree(Number(PORT), '/', 'vite dev server');

// 直接跑 vite 的入口脚本，不要用 shell 包一层 npx：Windows 上 shell:true 会变成
// cmd.exe -> node(npx) -> node(vite) 三级，kill 只能杀掉最外层，vite 会一直留在后台，
// 既占着端口又用文件监听锁住 src/，下次改代码就会写不进去。
const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', PORT, '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, BF_DEV_API_TARGET: apiBase },
});

await assertPortFree(Number(API_PORT), '/api/health', 'FastAPI 后端');

// 后端的日志收在内存里：起得来就丢掉，起不来就把它打出来，否则排错只能靠猜
let apiLog = '';
const api = spawn(UV, ['run', '--directory', join(root, 'backend'), 'uvicorn', 'bfp.main:app', '--host', '127.0.0.1', '--port', API_PORT], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BF_DATA_DIR: DATA_DIR, BF_SWEEP_INTERVAL_SECONDS: '300' },
});
api.stdout.on('data', (chunk) => { apiLog = (apiLog + chunk).slice(-8000); });
api.stderr.on('data', (chunk) => { apiLog = (apiLog + chunk).slice(-8000); });
api.on('error', (error) => { apiLog += '\n[spawn] ' + error.message; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 端口必须真的空着。不查的话，上一次跑剩下的 uvicorn 会顶掉我们自己 spawn 出来的那个
 * （它绑不上端口就直接退出，而 stdio 是 ignore，日志里一个字都看不到），
 * 接着 waitFor 照样成功 —— 因为它问的是**别人**的 /api/health。
 * 于是「全绿」验的是那个老进程的代码，假绿灯比红灯危险得多。
 * 真踩过一次：8099 上蹲着上一轮留下的 uvicorn，连跑两遍都没发现。
 */
async function assertPortFree(port, path, label) {
  try {
    await fetch('http://127.0.0.1:' + port + path, { signal: AbortSignal.timeout(1500) });
  } catch {
    return; // 连不上 = 端口空着，正是我们要的
  }
  console.error('端口 ' + port + ' 上已经有东西在响应 ' + path + '（' + label + '），先清掉再跑：');
  console.error('  否则这一轮 e2e 验的是那个进程的代码，不是你工作区里的代码。');
  console.error('  Windows:  netstat -ano | findstr :' + port + '   ->   taskkill /PID <pid> /T /F');
  process.exit(2);
}

async function waitFor(url, label, tries = 90) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  console.error(label + ' 没能在 ' + Math.round((tries * 500) / 1000) + ' 秒内起来：' + url);
  return false;
}

function runCdp(url, exprFile, preFile) {
  return new Promise((resolve) => {
    const args = [join(here, 'cdp.mjs'), '--url', url, '--expr-file', exprFile, '--width', '1440', '--height', '900', '--wait', '3000', '--json'];
    // --pre-file 在求值主脚本之前先跑一遍，它就是凭据进页面的那条路
    if (preFile) args.push('--pre-file', preFile);
    const child = spawn(
      process.execPath,
      args,
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', () => resolve({ out, err }));
  });
}

let stopped = false;
function killTree(child) {
  if (!child || !child.pid) return;
  // Windows 上必须**先** taskkill /T 再 child.kill()，顺序反了就只杀掉了最外层：
  // uv 一死，taskkill 就没有父进程可以顺着往下走了，uvicorn 与 python 变成孤儿，
  // 继续占着 8099 与 SQLite 的 -wal/-shm（实测漏过两次：端口被占 + 临时目录删不掉）。
  // 用 spawnSync 是为了确保它跑完再往下走 —— 后面的 rmSync 就指望这件事。
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    return;
  }
  try { child.kill(); } catch { /* ignore */ }
}

async function stop() {
  if (stopped) return;
  stopped = true;
  killTree(vite);
  killTree(api);
  // taskkill 是异步的：刚发完就删临时目录，Windows 上会因为 uvicorn 还攥着 SQLite 的 -wal/-shm
  // 而删失败 —— 而 rmSync 的 force 只忽略「不存在」、不忽略「被占用」，失败又被下面的 catch 吃掉，
  // 于是目录就静悄悄留在 %TEMP% 里（实测漏过一次）。等一拍再删，早退的几条路也一并走这里。
  if (process.platform === 'win32') await sleep(600);
  for (const dir of [DATA_DIR, CREDS_DIR]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 跑一个阶段；失败返回 null 并把原因打印出来 */
async function runStage(label, url, exprFile, preFile) {
  const { out, err } = await runCdp(url, exprFile, preFile);
  if (err.trim()) console.error('[' + label + '] stderr: ' + err.trim());
  let payload = null;
  try { payload = JSON.parse(out); } catch { /* 下面兜底 */ }
  const result = payload && payload.result;
  if (!result || !Array.isArray(result.results)) {
    console.error('[' + label + '] 没有产出结果：' + out.slice(0, 600));
    return null;
  }
  for (const item of result.results) {
    const tag = item.skipped ? '  SKIP  ' : item.pass ? '  PASS  ' : '  FAIL  ';
    console.log('[' + label + '] ' + tag + item.name + (item.detail ? '   [' + item.detail + ']' : ''));
  }
  return result;
}

let code = 1;
try {
  if (!(await waitFor(apiBase + '/api/health', 'FastAPI 后端'))) {
    console.error('--- 后端日志 ---\n' + (apiLog || '(空)'));
    await stop();
    process.exit(2);
  }
  if (!(await waitFor(base, 'vite dev server'))) {
    await stop();
    process.exit(2);
  }

  // A. 离线全功能 + 协同发布（发布结果带出房间号与两把真实密码，供 B/C 使用）
  const stageA = await runStage('发布', base + '?bfstage=publish', join(here, 'e2e.js'));
  if (!stageA) {
    console.error('发布阶段没跑通，后续阶段跳过');
    await stop();
    process.exit(1);
  }

  // B/C. 房间内两个角色：凭据来自 A 阶段的真实发布结果
  let all = [stageA];
  // 阶段"抛异常/没有产出结果"必须算失败：不然一个炸掉的阶段会被 filter(Boolean) 悄悄吞掉，
  // 剩下两个阶段全绿就报"通过"，等于白测。
  let stageError = false;
  const publish = stageA.publish;
  if (!publish || !publish.roomId || !publish.editPassword || !publish.adminPassword) {
    console.error('发布阶段没拿到房间凭据，编辑者/管理员阶段跳过');
    stageError = true;
  } else {
    const roomUrl = base + '?room=' + encodeURIComponent(publish.roomId) + '&bfstage=';
    // 房间号留在 URL 里（它不是秘密，手工复现时也方便），两把密码走注入
    const stageB = await runStage('编辑者', roomUrl + 'editor', join(here, 'e2e-collab.js'),
      writeCreds('editor', { roomId: publish.roomId, password: publish.editPassword, adminPassword: publish.adminPassword }));
    // 管理员阶段用管理员密码进房（字段名相同，值不同）
    const stageC = await runStage('管理员', roomUrl + 'admin', join(here, 'e2e-collab.js'),
      writeCreds('admin', { roomId: publish.roomId, password: publish.adminPassword, adminPassword: publish.adminPassword }));
    if (!stageB || !stageC) {
      console.error('房间内阶段没跑出结果（算失败，不算跳过）');
      stageError = true;
    }
    all = [stageA, stageB, stageC].filter(Boolean);
  }

  const results = all.flatMap((r) => r.results);
  const total = results.length;
  const failed = results.filter((r) => !r.pass).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log('\n通过 ' + (total - failed - skipped) + ' / 失败 ' + failed + ' / 跳过 ' + skipped
    + '（共 ' + total + ' 项）');
  code = failed === 0 && !stageError ? 0 : 1;
} finally {
  // stop() 自己会等 taskkill 落地再删临时目录（数据目录 + 凭据文件），也顺手防止调用方
  // 一测完就踩到残留进程
  await stop();
}

process.exit(code);
