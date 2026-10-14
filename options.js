/**
 * DeepSeek Etymology — 设置页脚本
 * 同时作为 popup（点插件图标）和选项页（右键 → 选项）使用。
 */

const els = {
  apiKey: document.getElementById('apiKey'),
  toggleKey: document.getElementById('toggleKey'),
  model: document.getElementById('model'),
  save: document.getElementById('save'),
  test: document.getElementById('test'),
  status: document.getElementById('status'),
};

/* 在独立标签页里打开时，给 body 加个类，让卡片居中显示 */
if (window.innerWidth > 500) {
  document.body.classList.add('as-tab');
}

/* ---------------- 状态提示 ---------------- */
let statusTimer = null;

function setStatus(message, kind = 'info', autoHideMs = 0) {
  clearTimeout(statusTimer);
  els.status.textContent = message;
  els.status.className = `show ${kind}`;
  if (autoHideMs) {
    statusTimer = setTimeout(() => els.status.classList.remove('show'), autoHideMs);
  }
}

/* ---------------- 读写配置 ---------------- */
async function load() {
  const { apiKey = '', model = 'deepseek-chat' } = await chrome.storage.local.get([
    'apiKey',
    'model',
  ]);
  els.apiKey.value = apiKey;
  els.model.value = model;
}

async function save({ silent = false } = {}) {
  const apiKey = els.apiKey.value.trim();
  const model = els.model.value;

  if (apiKey && !/^sk-/.test(apiKey)) {
    setStatus('⚠️ 这个 Key 看起来不对：DeepSeek 的 Key 一般以 sk- 开头。', 'err');
    return false;
  }

  await chrome.storage.local.set({ apiKey, model });
  if (!silent) {
    setStatus(apiKey ? '✅ 已保存，去网页上划个词试试吧。' : '已清空 API Key。', 'ok', 4000);
  }
  return true;
}

/* ---------------- 事件绑定 ---------------- */
els.save.addEventListener('click', () => save());

els.test.addEventListener('click', async () => {
  const ok = await save({ silent: true });
  if (!ok) return;

  setStatus('⏳ 正在连接 DeepSeek…', 'info');
  els.test.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    if (res?.ok) {
      setStatus(`✅ 连接成功（${res.ms} ms，模型 ${res.model}）。可以去网页上划词了。`, 'ok');
    } else {
      setStatus(`❌ ${res?.error || '连接失败'}`, 'err');
    }
  } catch (err) {
    setStatus(`❌ 无法联系插件后台：${err.message}`, 'err');
  } finally {
    els.test.disabled = false;
  }
});

els.toggleKey.addEventListener('click', () => {
  const hidden = els.apiKey.type === 'password';
  els.apiKey.type = hidden ? 'text' : 'password';
  els.toggleKey.textContent = hidden ? '隐藏' : '显示';
});

els.apiKey.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') save();
});

els.model.addEventListener('change', () => save({ silent: true }));

load();
