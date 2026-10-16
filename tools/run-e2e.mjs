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
 * 用法：node tools/run-e2e.mjs
 * 依赖：uv（可用 BF_UV 指定可执行文件）、本机装了 Chrome（可用 BF_CHROME 指定）
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
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

// 直接跑 vite 的入口脚本，不要用 shell 包一层 npx：Windows 上 shell:true 会变成
// cmd.exe -> node(npx) -> node(vite) 三级，kill 只能杀掉最外层，vite 会一直留在后台，
// 既占着端口又用文件监听锁住 src/，下次改代码就会写不进去。
const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', PORT, '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, BF_DEV_API_TARGET: apiBase },
});

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

function runCdp(url, exprFile) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(here, 'cdp.mjs'), '--url', url, '--expr-file', exprFile, '--width', '1440', '--height', '900', '--wait', '3000', '--json'],
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
  if (!child || child.killed || child.exitCode !== null) return;
  try { child.kill(); } catch { /* ignore */ }
  // 保险：万一还拉了子进程（vite 的 esbuild、uv 下面的 uvicorn），把整棵树一起收掉
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

function stop() {
  if (stopped) return;
  stopped = true;
  killTree(vite);
  killTree(api);
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 跑一个阶段；失败返回 null 并把原因打印出来 */
async function runStage(label, url, exprFile) {
  const { out, err } = await runCdp(url, exprFile);
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
    stop();
    process.exit(2);
  }
  if (!(await waitFor(base, 'vite dev server'))) {
    stop();
    process.exit(2);
  }

  // A. 离线全功能 + 协同发布（发布结果带出房间号与两把真实密码，供 B/C 使用）
  const stageA = await runStage('发布', base + '?bfstage=publish', join(here, 'e2e.js'));
  if (!stageA) {
    console.error('发布阶段没跑通，后续阶段跳过');
    stop();
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
    const creds = '&bfpwd=' + encodeURIComponent(publish.editPassword) + '&bfadmin=' + encodeURIComponent(publish.adminPassword);
    const roomUrl = base + '?room=' + encodeURIComponent(publish.roomId) + '&bfstage=';
    const stageB = await runStage('编辑者', roomUrl + 'editor' + creds, join(here, 'e2e-collab.js'));
    // 管理员阶段用管理员密码进房（同一个参数名，值不同）
    const adminCreds = '&bfpwd=' + encodeURIComponent(publish.adminPassword) + '&bfadmin=' + encodeURIComponent(publish.adminPassword);
    const stageC = await runStage('管理员', roomUrl + 'admin' + adminCreds, join(here, 'e2e-collab.js'));
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
  stop();
  // 给 taskkill 留一点时间落地，别让调用方一测完就又踩到残留进程
  if (process.platform === 'win32') await sleep(600);
}

process.exit(code);
