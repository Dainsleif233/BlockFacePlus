/*!
 * BlockFace+ · e2e 公共支撑：真实后端下的请求录制与直查
 * Copyright 2026 Dainsleif · Apache License 2.0
 *
 * 协同 e2e 以前靠页内 mock 后端（src/dev/collabMock.ts）观察"客户端到底发了什么"。
 * 换成真实 FastAPI 后端之后，观察点拆成两半：
 *   1. 协议层：包一层 window.fetch 把请求（方法 / 路径 / 密码头 / 体）录下来 ——
 *      不改一个字节的响应，只是旁听；
 *   2. 事实层：直接打后端 API 读回房间快照 —— "服务端到底存成了什么样"以它为准，
 *      比读 mock 内部状态强。
 *
 * 阶段脚本用动态 import 引它：`await import('/tools/e2e-support.js')`。
 * （Vite dev server 以仓库根为 root，所以 /tools/ 下的文件能直接被页面加载。）
 */

const CALLS = '__BF_E2E_CALLS__';
const PWD_HEADER = 'X-BF-Room-Pwd';

function store() {
  if (!window[CALLS]) window[CALLS] = [];
  return window[CALLS];
}

/** 旁听所有 fetch；重复调用是幂等的 */
export function installFetchRecorder() {
  if (window.__BF_E2E_RECORDER__) return;
  window.__BF_E2E_RECORDER__ = true;
  const original = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const record = { method: 'GET', url: '', path: '', password: '', contentType: '', body: null, fields: null, bytes: 0 };
    try {
      record.url = typeof input === 'string' ? input : (input && input.url) || String(input);
      record.path = new URL(record.url, window.location.href).pathname;
      const method = (init && init.method) || (input && input.method) || 'GET';
      record.method = String(method).toUpperCase();
      const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
      record.password = headers.get(PWD_HEADER) || '';
      record.contentType = headers.get('Content-Type') || '';
      const body = init && init.body;
      if (typeof body === 'string') {
        record.bytes = body.length;
        try { record.body = JSON.parse(body); } catch { record.body = body; }
      } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        record.fields = {};
        for (const [key, value] of body.entries()) {
          if (typeof value === 'string') {
            record.fields[key] = value;
          } else {
            record.fields[key] = '<file:' + (value.name || '') + '>';
            record.bytes = value.size || 0;
          }
        }
      } else if (body && typeof body.size === 'number') {
        record.bytes = body.size;
      }
      store().push(record);
    } catch (error) {
      // 旁听失败绝不能影响真正的请求
      console.warn('[e2e] 请求录制失败', error);
    }
    return original(input, init);
  };
}

/** 取（可过滤的）录制到的请求 */
export function apiCalls(filter) {
  const all = store();
  if (!filter) return all.slice();
  return all.filter((call) =>
    (filter.method === undefined || call.method === filter.method)
    && (filter.path === undefined || call.path === filter.path)
    && (filter.pathEndsWith === undefined || call.path.endsWith(filter.pathEndsWith))
    && (filter.pathContains === undefined || call.path.includes(filter.pathContains)));
}

/** 清空录制，让下一轮断言只看这一轮发的请求 */
export function resetApiCalls() {
  window[CALLS] = [];
}

/** 直接打后端（绕过应用），用于读事实与制造并发冲突 */
export async function apiRequest(method, path, password, body) {
  const headers = {};
  if (password) headers[PWD_HEADER] = password;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch { /* 可能没有体 */ }
  return { status: response.status, ok: response.ok, data };
}

/** 读房间快照：`{ room, avatars, role }` */
export function apiGetRoom(roomId, password) {
  return apiRequest('GET', '/api/rooms/' + encodeURIComponent(roomId), password);
}

/** 直接改一行头像（用来在另一个客户端制造"刚被别人改过"的并发场景） */
export function apiPatchAvatars(roomId, password, payload) {
  return apiRequest('PATCH', '/api/rooms/' + encodeURIComponent(roomId) + '/avatars', password, payload);
}

export function apiDeleteRoom(roomId, password) {
  return apiRequest('DELETE', '/api/rooms/' + encodeURIComponent(roomId), password);
}

/** 快照里某个 id 的行 */
export function avatarOf(snapshot, id) {
  if (!snapshot || !Array.isArray(snapshot.avatars)) return null;
  return snapshot.avatars.find((item) => item.id === id) || null;
}

/** 用 roomId/密码把 URL 里的一次性凭据抹掉，别留在地址栏 */
export function scrubCredentialParams() {
  try {
    const url = new URL(window.location.href);
    for (const key of ['bfpwd', 'bfadmin']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url.toString());
  } catch {
    /* 无关紧要 */
  }
}
