#!/usr/bin/env node
/**
 * 一条命令跑完浏览器端到端测试：
 *   1. 起一个临时 vite dev server
 *   2. 用 tools/cdp.mjs 驱动本机 Chrome 分三个阶段执行：
 *        A. 离线发布   tools/e2e.js        （?bfstage=publish，页内 mock 后端）
 *        B. 编辑者进房 tools/e2e-collab.js （?room=<id>&bfstage=editor，布局冻结换肤）
 *        C. 管理员进房 tools/e2e-collab.js （?room=<id>&bfstage=admin，全量同步+删房）
 *   3. 合并打印结果并按失败数退出
 *
 * 用法：node tools/run-e2e.mjs
 * 依赖：本机装了 Chrome（可用环境变量 BF_CHROME 指定可执行文件路径）
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = process.env.BF_E2E_PORT || '5179';
const base = 'http://localhost:' + PORT + '/';

// 直接跑 vite 的入口脚本，不要用 shell 包一层 npx：Windows 上 shell:true 会变成
// cmd.exe -> node(npx) -> node(vite) 三级，kill 只能杀掉最外层，vite 会一直留在后台，
// 既占着端口又用文件监听锁住 src/，下次改代码就会写不进去。
const vite = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', PORT, '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
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
function stop() {
  if (stopped) return;
  stopped = true;
  try { vite.kill(); } catch { /* ignore */ }
  // 保险：万一 vite 还拉了子进程（比如 esbuild），把整棵树一起收掉
  if (process.platform === 'win32' && vite.pid) {
    try {
      spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
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
  if (!(await waitForServer())) {
    console.error('vite 没能在 30 秒内起来');
    stop();
    process.exit(2);
  }

  // A. 离线全功能 + 协同发布（发布结果带出房间号与密码，供 B/C 使用）
  const stageA = await runStage('发布', base + '?bfstage=publish', join(here, 'e2e.js'));
  if (!stageA) {
    console.error('发布阶段没跑通，后续阶段跳过');
    stop();
    process.exit(1);
  }

  // B/C. 房间内两个角色（mock 两侧用同一组硬编码密码，URL 只带房间号与阶段）
  let all = [stageA];
  // 阶段"抛异常/没有产出结果"必须算失败：不然一个炸掉的阶段会被 filter(Boolean) 悄悄吞掉，
  // 剩下两个阶段全绿就报"通过"，等于白测。
  let stageError = false;
  const publish = stageA.publish;
  if (!publish || !publish.roomId) {
    console.error('发布阶段没拿到房间凭据，编辑者/管理员阶段跳过');
    stageError = true;
  } else {
    const roomUrl = base + '?room=' + encodeURIComponent(publish.roomId) + '&bfstage=';
    const stageB = await runStage('编辑者', roomUrl + 'editor', join(here, 'e2e-collab.js'));
    const stageC = await runStage('管理员', roomUrl + 'admin', join(here, 'e2e-collab.js'));
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
  if (process.platform === 'win32') await sleep(400);
}

process.exit(code);
