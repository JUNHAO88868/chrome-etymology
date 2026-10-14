/**
 * DeepSeek Etymology — content script
 * ------------------------------------------------------------------
 * 职责：只在网页里做三件事 —— 感知划词、画一个「✨ 查词源」按钮、渲染词源卡片。
 * 它**不含也不读** API Key，真正的请求由 background.js 发出。
 *
 * ⚠️ 请勿在本文件里写 API Key（例如 const DEEPSEEK_API_KEY = "sk-..."）。
 *    Key 请在插件的「设置页」里填写，只会保存在你本机的 chrome.storage.local，
 *    绝不会随本文件一起被公开或上传。
 */

const BTN_ID = 'dse-word-btn';
const PANEL_ID = 'dse-word-panel';

/** 最多允许选 3 个词（这样 phrasal verb 之类也能查），且必须全是拉丁字母 */
const WORD_PATTERN = /^[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,2}$/;

let buttonEl = null;
let panelEl = null;
let currentWord = '';

/* ================================================================== */
/* 1. 划词监听                                                         */
/* ================================================================== */

document.addEventListener('mouseup', onMouseUp, true);
document.addEventListener('keydown', onKeyDown, true);
window.addEventListener('scroll', hideButton, true);

function onMouseUp(event) {
  const target = event.target;
  if (target instanceof Element && (target.closest('#' + BTN_ID) || target.closest('#' + PANEL_ID))) {
    return; // 点在插件自己的 UI 上，忽略
  }

  // 等浏览器把选区算完
  setTimeout(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideButton();
      return;
    }

    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (!text || text.length > 64 || !WORD_PATTERN.test(text)) {
      hideButton();
      return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      hideButton();
      return;
    }

    showButton(rect, text);
  }, 10);
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    hideButton();
    hidePanel();
  }
}

/* ================================================================== */
/* 2. 划词按钮                                                         */
/* ================================================================== */

function showButton(rect, word) {
  hideButton();

  buttonEl = document.createElement('div');
  buttonEl.id = BTN_ID;
  buttonEl.textContent = '✨ 查词源';
  buttonEl.title = `用 DeepSeek 拆解「${word}」的词根与词源`;

  const left = clamp(rect.left, 8, window.innerWidth - 130);
  let top = rect.top - 38;
  if (top < 8) top = rect.bottom + 10; // 顶部空间不够就放到下面

  buttonEl.style.left = `${left}px`;
  buttonEl.style.top = `${top}px`;

  buttonEl.addEventListener('mousedown', (e) => {
    // 阻止默认行为，避免点击时清掉选区
    e.preventDefault();
    e.stopPropagation();
  });
  buttonEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideButton();
    openPanel(rect, word);
  });

  document.body.appendChild(buttonEl);
}

function hideButton() {
  if (buttonEl) {
    buttonEl.remove();
    buttonEl = null;
  }
}

/* ================================================================== */
/* 3. 词源卡片                                                         */
/* ================================================================== */

function openPanel(rect, word) {
  currentWord = word;
  renderPanel(rect, word, loadingHtml(word));

  let response = null;
  try {
    chrome.runtime.sendMessage({ type: 'ETYMOLOGY_REQUEST', word }, (res) => {
      response = res;
      if (chrome.runtime.lastError) {
        showPanelError('插件后台暂时联系不上。请刷新页面，或到 chrome://extensions 重新加载本插件。');
        return;
      }
      if (!res) {
        showPanelError('没有收到后台响应，请重试。');
        return;
      }
      if (res.ok) {
        setPanelBody(renderMarkdown(res.text));
      } else if (res.code === 'NO_KEY') {
        setPanelBody(noKeyHtml());
        wireNoKeyButton();
      } else {
        showPanelError(res.error || '未知错误');
      }
    });
  } catch (err) {
    // 插件被重新加载后，旧的 content script 会失去上下文
    showPanelError('插件已更新或重新加载，请刷新本页面后再试。');
  }
}

function renderPanel(rect, word, bodyHtml) {
  hidePanel();

  panelEl = document.createElement('div');
  panelEl.id = PANEL_ID;
  panelEl.innerHTML = `
    <div class="dse-header">
      <span class="dse-title">🔥 ${escapeHtml(word)} · 词源拆解</span>
      <button class="dse-close" type="button" title="关闭（Esc）">×</button>
    </div>
    <div class="dse-body">${bodyHtml}</div>
    <div class="dse-footer">由 DeepSeek 生成 · 词源内容仅供学习参考</div>
  `;

  const width = 420;
  const left = clamp(rect.left, 12, Math.max(12, window.innerWidth - width - 12));
  const top = clamp(rect.bottom + 12, 12, Math.max(12, window.innerHeight - 160));

  panelEl.style.left = `${left}px`;
  panelEl.style.top = `${top}px`;

  panelEl.querySelector('.dse-close').addEventListener('click', hidePanel);
  document.body.appendChild(panelEl);
}

function hidePanel() {
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
  }
}

function setPanelBody(html) {
  const body = panelEl?.querySelector('.dse-body');
  if (body) body.innerHTML = html;
}

function showPanelError(message) {
  setPanelBody(`<div class="dse-error">❌ ${escapeHtml(message)}</div>`);
}

function loadingHtml(word) {
  return `
    <div class="dse-loading">
      <div class="dse-loading-text">正在为「${escapeHtml(word)}」追查词源…</div>
      <div class="dse-dots"><i></i><i></i><i></i></div>
    </div>`;
}

function noKeyHtml() {
  return `
    <div class="dse-notice">
      <div class="dse-notice-title">还差一步：填一个 API Key</div>
      <p>本插件不自带 Key，需要你自己的 DeepSeek API Key（官方平台申请，按量计费，通常一个单词不到 1 分钱）。</p>
      <p>Key 只保存在你本机浏览器里，不会上传到任何第三方服务器。</p>
      <button class="dse-primary" type="button" id="dse-open-options">去填写 API Key</button>
    </div>`;
}

function wireNoKeyButton() {
  const btn = panelEl?.querySelector('#dse-open-options');
  if (btn) {
    btn.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      } catch {
        /* 忽略 */
      }
      hidePanel();
    });
  }
}

/* ================================================================== */
/* 4. 极简 Markdown 渲染（先转义 HTML，再套样式，避免 XSS）             */
/* ================================================================== */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function renderMarkdown(markdown) {
  if (!markdown) return '<div class="dse-error">没有可显示的内容。</div>';

  // 统一把各种引号换成「」（先处理，再转义）
  const normalized = String(markdown)
    .replace(/"([^"\n]*)"/g, '「$1」')
    .replace(/[“”]([^“”\n]*)[“”]/g, '「$1」');

  let html = escapeHtml(normalized)
    .replace(/^###\s+(.*)$/gim, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gim, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gim, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/^\s*[-*]\s+(.*)$/gim, '<li>$1</li>')
    .replace(/^\s*---+\s*$/gim, '<hr>')
    .replace(/\n{2,}/g, '<br>')
    .replace(/\n/g, '<br>');

  html = html
    .replace(/<\/li><br>/g, '</li>')
    .replace(/(?:<li>[\s\S]*?<\/li>)+/g, (match) => `<ul>${match}</ul>`)
    .replace(/^(<br>)+/, '')
    .replace(/(<br>)+$/, '');

  return html;
}

/* ================================================================== */
/* 工具函数                                                            */
/* ================================================================== */

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
