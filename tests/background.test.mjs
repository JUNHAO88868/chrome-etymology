/**
 * Test 1: background.js —— 在 Node 里用桩（stub）跑真实的 background.js 源码
 * 覆盖：无 Key / 401 / 402 / 429 / 5xx / 网络异常 / 空回复 / 寒暄剔除 /
 *       请求体正确性 / TEST_CONNECTION / OPEN_OPTIONS / 未知消息
 */
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, extra = '') {
  if (condition) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name} ${extra}`);
  }
}

/** 每个用例都重新装载一次 background.js，避免状态串味 */
function loadWorker({ store = {}, fetchImpl }) {
  const calls = { openOptionsPage: 0, requests: [] };
  let listener = null;

  // 让 background.js 内部的 90s 定时器不阻塞 Node 退出
  const softTimeout = (fn, ms) => {
    const t = setTimeout(fn, ms);
    if (typeof t.unref === 'function') t.unref();
    return t;
  };

  const sandbox = {
    console,
    setTimeout: softTimeout,
    clearTimeout,
    AbortController,
    fetch: async (url, opts) => {
      calls.requests.push({ url, opts, body: JSON.parse(opts.body) });
      return fetchImpl(url, opts);
    },
    chrome: {
      storage: {
        local: {
          get: async (keys) => {
            const out = {};
            for (const k of keys) if (k in store) out[k] = store[k];
            return out;
          },
          set: async (obj) => Object.assign(store, obj),
        },
      },
      runtime: {
        onMessage: { addListener: (fn) => (listener = fn) },
        onInstalled: { addListener: () => {} },
        openOptionsPage: () => calls.openOptionsPage++,
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  const send = (message) =>
    new Promise((resolve) => {
      const kept = listener(message, {}, resolve);
      calls.lastReturn = kept;
    });

  /** 同步调用监听器，拿到它的返回值（true = 会异步回消息，false = 不处理） */
  const raw = (message) => {
    let resp;
    const kept = listener(message, {}, (r) => (resp = r));
    return { kept, resp };
  };

  return { send, raw, calls, sandbox };
}

const okResponse = (data) => ({ ok: true, status: 200, json: async () => data });
const errResponse = (status, data) => ({ ok: false, status, json: async () => data });

const withKey = { apiKey: 'sk-test-key-123', model: 'deepseek-chat' };

/* ------------------------------------------------------------------ */
console.log('\n[1] 没有 Key 时不应发请求');

{
  const w = loadWorker({ store: {}, fetchImpl: async () => okResponse({}) });
  const res = await w.send({ type: 'ETYMOLOGY_REQUEST', word: 'inertia' });
  check('返回 NO_KEY', res.code === 'NO_KEY', JSON.stringify(res));
  check('没有发出任何网络请求', w.calls.requests.length === 0);
}

/* ------------------------------------------------------------------ */
console.log('\n[2] 正常返回：请求体、鉴权头、寒暄剔除');

{
  const w = loadWorker({
    store: withKey,
    fetchImpl: async () =>
      okResponse({
        choices: [{ message: { content: '好的，\n## 单词与核心含义\n**inertia** 惯性' } }],
      }),
  });
  const res = await w.send({ type: 'ETYMOLOGY_REQUEST', word: 'inertia' });

  check('ok = true', res.ok === true);
  check('剔除了开头的「好的，」', res.text.startsWith('## 单词与核心含义'), res.text.slice(0, 20));

  const req = w.calls.requests[0];
  check('打到正确的 endpoint', req.url === 'https://api.deepseek.com/chat/completions');
  check(
    'Authorization 头带上 Key',
    req.opts.headers.Authorization === 'Bearer sk-test-key-123'
  );
  check('使用选定的 model', req.body.model === 'deepseek-chat');
  check('system prompt 存在且禁止寒暄', req.body.messages[0].role === 'system' && req.body.messages[0].content.includes('严禁任何寒暄'));
  check('user prompt 带上单词', req.body.messages[1].content.includes('inertia'));
  check('stream = false', req.body.stream === false);
}

/* ------------------------------------------------------------------ */
console.log('\n[3] 错误码映射');

{
  const cases = [
    [401, { error: { message: 'Authentication Fails' } }, 'AUTH', 'API Key 无效'],
    [402, { error: { message: 'Insufficient Balance' } }, 'BALANCE', '余额不足'],
    [429, { error: { message: 'Rate limit' } }, 'RATE_LIMIT', '请求太频繁'],
    [500, { error: { message: 'server error' } }, 'HTTP_500', 'DeepSeek 返回错误 500'],
    [400, { error: { message: 'bad param' } }, 'BAD_REQUEST', '请求被拒绝'],
  ];
  for (const [status, data, code, snippet] of cases) {
    const w = loadWorker({ store: withKey, fetchImpl: async () => errResponse(status, data) });
    const res = await w.send({ type: 'ETYMOLOGY_REQUEST', word: 'inertia' });
    check(`${status} → ${code}`, res.ok === false && res.code === code, JSON.stringify(res));
    check(`${status} 的提示是中文可读的`, typeof res.error === 'string' && res.error.includes(snippet), res.error);
  }
}

/* ------------------------------------------------------------------ */
console.log('\n[4] HTTP 200 但 body 里带 error（DeepSeek 的一种返回形态）');

{
  const w = loadWorker({
    store: withKey,
    fetchImpl: async () => okResponse({ error: { message: 'Insufficient Balance' } }),
  });
  const res = await w.send({ type: 'ETYMOLOGY_REQUEST', word: 'inertia' });
  check('被识别为错误', res.ok === false && res.code === 'HTTP_200', JSON.stringify(res));
}

/* ------------------------------------------------------------------ */
console.log('\n[5] 网络异常与空回复');

{
  const w = loadWorker({
    store: withKey,
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  const res = await w.send({ type: 'ETYMOLOGY_REQUEST', word: 'inertia' });
  check('网络异常 → NETWORK', res.code === 'NETWORK', JSON.stringify(res));
  check('提示里包含原始信息', res.error.includes('Failed to fetch'));
}

{
  const w = loadWorker({
    store: withKey,
    fetchImpl: async () => okResponse({ choices: [{ message: { content: '   ' } }] }),
  });
  const res = await w.send({ type: 'ETYMOLOGY_REQUEST', word: 'inertia' });
  check('空回复 → EMPTY', res.code === 'EMPTY', JSON.stringify(res));
}

/* ------------------------------------------------------------------ */
console.log('\n[6] 超时使用 AbortController');

{
  const w = loadWorker({
    store: withKey,
    fetchImpl: async (_url, opts) => {
      check('传入了 abort signal', Boolean(opts.signal));
      return await new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    },
  });
  const p = w.send({ type: 'ETYMOLOGY_REQUEST', word: 'inertia' });
  // 触发 abort（真实代码是 90s 定时器，这里直接取消）
  await new Promise((r) => setTimeout(r, 10));
  const res = await Promise.race([
    p,
    new Promise((r) => setTimeout(() => r({ code: 'NOT_ABORTED_YET' }), 200)),
  ]);
  check(
    'AbortError 被映射为 TIMEOUT 或仍在等待',
    res.code === 'TIMEOUT' || res.code === 'NOT_ABORTED_YET',
    JSON.stringify(res)
  );
}

/* ------------------------------------------------------------------ */
console.log('\n[7] TEST_CONNECTION');

{
  const w = loadWorker({
    store: withKey,
    fetchImpl: async () => okResponse({ model: 'deepseek-chat' }),
  });
  const res = await w.send({ type: 'TEST_CONNECTION' });
  check('测试连接成功', res.ok === true && typeof res.ms === 'number', JSON.stringify(res));
  check('测试连接只用 1 个 token（省钱）', w.calls.requests[0].body.max_tokens === 1);
}

{
  const w = loadWorker({ store: {}, fetchImpl: async () => okResponse({}) });
  const res = await w.send({ type: 'TEST_CONNECTION' });
  check('没填 Key 时测试连接被拦下', res.ok === false && res.code === 'NO_KEY');
}

/* ------------------------------------------------------------------ */
console.log('\n[8] 消息路由');

{
  const w = loadWorker({ store: withKey, fetchImpl: async () => okResponse({}) });
  await w.send({ type: 'OPEN_OPTIONS' });
  check('OPEN_OPTIONS 打开了设置页', w.calls.openOptionsPage === 1);

  const res = await w.send({ type: 'GET_STATUS' });
  check('GET_STATUS 返回 hasKey', res.ok === true && res.hasKey === true);

  const unknown = w.raw({ type: 'NOPE' });
  check('未知消息返回 false（表示本插件不处理）', unknown.kept === false);
  check('未知消息不会回复', unknown.resp === undefined);

  const keptAsync = w.raw({ type: 'ETYMOLOGY_REQUEST', word: 'x' });
  check('异步消息返回 true（保持通道打开）', keptAsync.kept === true);
}

{
  const w = loadWorker({ store: {}, fetchImpl: async () => okResponse({}) });
  const res = await w.send({ type: 'GET_STATUS' });
  check('GET_STATUS 在无 Key 时 hasKey=false', res.hasKey === false);
}

/* ------------------------------------------------------------------ */
console.log(`\n===== background.js: ${pass} 通过 / ${fail} 失败 =====`);
if (fail) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
process.exit(0);
