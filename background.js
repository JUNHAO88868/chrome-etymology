/**
 * DeepSeek Etymology — background service worker
 * ------------------------------------------------------------------
 * 安全设计的核心：**只有这个文件会带着你的 API Key 去访问 DeepSeek。**
 *
 * 为什么不直接在 content.js 里 fetch？
 *   1. content script 运行在别人的网页里，它的网络请求会经过该页面的
 *      Service Worker / 网络栈，理论上可以被恶意页面截获 Authorization 头。
 *   2. 把 Key 留在后台，网页里既看不到 Key，也发不出请求。
 *   所以：网页 → content.js →（消息）→ background.js → DeepSeek API。
 */

const API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-chat';
const REQUEST_TIMEOUT_MS = 90 * 1000;

/** 约束输出格式，保证每次拆解结构一致、无寒暄、可读性强 */
const SYSTEM_PROMPT = `你是一位英语词源学（etymology）讲解专家，擅长用「画面感」把单词的历史讲活。

规则：
1. 严禁任何寒暄、客套、开场白（如「好的」「没问题」「当然」），直接进入正文。
2. 所有行文中的引号一律使用「」。
3. 严格使用下面的 Markdown 结构输出，不要增删标题。

## 单词与核心含义
（一行给出单词、音标、现代核心义）

## 词根词缀拆解
（拆成前缀 / 词根 / 后缀，逐条列出，标明来源语言（拉丁语、希腊语、古英语等）与原义）

## 老祖宗的第一现场
（还原造词那一刻的具体场景，像纪录片一样有画面感，讲清楚「为什么用这个意象来表示这个意思」）

## 历史演变名场面
（从古到今的关键转折，给出演变路线：拉丁语 xxx → 古法语 xxx → 中古英语 xxx → 现代英语 xxx）

## 现代场景联想
（2-3 个当代真实使用场景、常见搭配或例句，帮助记忆）

## 一句话核心画面
（用一句话把词源画面和现代含义焊在一起）

篇幅 400-600 字，信息密度高，不啰嗦。`;

/* ------------------------------------------------------------------ */
/* 配置读写                                                            */
/* ------------------------------------------------------------------ */

/**
 * API Key 从哪来？——**用户在插件「设置页」里填，存在本机**。
 *
 * 请勿把 Key 写死在代码里（例如 const API_KEY = "sk-..."）。
 * 那样任何拿到源码的人都能盗用你的 Key，并消耗你的余额。
 * 正确做法：用户打开插件设置页 → 粘贴自己的 Key → 保存到这里。
 *
 * @returns {Promise<{apiKey: string, model: string}>}
 */
async function getConfig() {
  const { apiKey = '', model = DEFAULT_MODEL } = await chrome.storage.local.get([
    'apiKey',
    'model',
  ]);
  return { apiKey: String(apiKey).trim(), model: String(model || DEFAULT_MODEL) };
}

/* ------------------------------------------------------------------ */
/* 调用 DeepSeek                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {string} word 用户选中的英文词
 * @returns {Promise<{ok: true, text: string, model?: string} | {ok: false, code: string, error: string}>}
 */
async function runEtymology(word) {
  const { apiKey, model } = await getConfig();
  if (!apiKey) {
    return { ok: false, code: 'NO_KEY', error: '还没有填写 DeepSeek API Key' };
  }
  if (!word || typeof word !== 'string') {
    return { ok: false, code: 'BAD_INPUT', error: '没有选中有效的英文单词' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `请讲解英文单词：${word}` },
        ],
        stream: false,
        temperature: 1.0,
      }),
      signal: controller.signal,
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      /* 非 JSON 响应，下面按状态码统一处理 */
    }

    if (!response.ok || data?.error) {
      return { ok: false, ...describeHttpError(response.status, data) };
    }

    let reply = data?.choices?.[0]?.message?.content || '';
    // 双保险：万一模型还是说了寒暄，代码层再削一次
    reply = reply.replace(/^(好的[，,！!]?|没问题[，,！!]?|收到[，,！!]?|当然[，,！!]?)\s*/i, '').trim();
    if (!reply) {
      return { ok: false, code: 'EMPTY', error: 'DeepSeek 返回了空内容，请重试' };
    }

    return { ok: true, text: reply, model };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', error: '请求超时（90 秒），请稍后重试' };
    }
    return {
      ok: false,
      code: 'NETWORK',
      error: `网络请求失败：${err.message}。请检查网络或代理设置。`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function describeHttpError(status, data) {
  const detail = data?.error?.message || '';
  switch (status) {
    case 401:
      return { code: 'AUTH', error: 'API Key 无效或已过期，请在插件设置里重新填写。' };
    case 402:
      return { code: 'BALANCE', error: 'DeepSeek 账户余额不足，请先充值。' };
    case 429:
      return { code: 'RATE_LIMIT', error: '请求太频繁（429），稍等几秒再试。' };
    case 400:
      return { code: 'BAD_REQUEST', error: `请求被拒绝：${detail || '参数有误'}` };
    default:
      return {
        code: 'HTTP_' + status,
        error: `DeepSeek 返回错误 ${status}${detail ? '：' + detail : ''}`,
      };
  }
}

/** 设置页的「测试连接」：发一个极小的请求，只验证 Key 是否可用 */
async function testConnection() {
  const { apiKey, model } = await getConfig();
  if (!apiKey) {
    return { ok: false, code: 'NO_KEY', error: '请先填写 API Key' };
  }
  const started = Date.now();
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.error) {
      return { ok: false, ...describeHttpError(response.status, data) };
    }
    return { ok: true, ms: Date.now() - started, model: data?.model || model };
  } catch (err) {
    return { ok: false, code: 'NETWORK', error: `网络请求失败：${err.message}` };
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case 'ETYMOLOGY_REQUEST':
      runEtymology(String(message.word || '').trim()).then(sendResponse);
      return true;

    case 'TEST_CONNECTION':
      testConnection().then(sendResponse);
      return true;

    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;

    case 'GET_STATUS':
      getConfig().then(({ apiKey, model }) =>
        sendResponse({ ok: true, hasKey: Boolean(apiKey), model })
      );
      return true;

    default:
      return false;
  }
});

/* 首次安装时打开设置页，直接引导用户填 Key */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
