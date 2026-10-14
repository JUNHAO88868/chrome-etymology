#!/usr/bin/env node
/**
 * DeepSeek Etymology — 一键跑全部测试
 * ------------------------------------------------------------------
 *   node tests/run.mjs
 *
 * 它会做三件事：
 *   1. 在 Node 里跑 background.js 的逻辑测试（35 项，不需要浏览器）
 *   2. 用本机 Chrome 无头模式跑 content.js 的 DOM 测试（24 项）
 *   3. 同上跑 options.js 的 DOM 测试（17 项）
 *
 * 只依赖本机已安装的 Chrome / Chromium / Edge / Brave 之一。
 * 找不到浏览器时，DOM 测试会被跳过并给出提示，Node 测试照常运行。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 60_000;
/** 只在“渲染完成后”才会出现的标记（源码里不会出现这个连续字符串） */
const READY_MARKER = 'id="out">RESULTS';

const C = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

/* ------------------------------------------------------------------ */
/* 找浏览器                                                            */
/* ------------------------------------------------------------------ */

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

function findBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  for (const candidate of CANDIDATES[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate;
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [candidate], {
      encoding: 'utf8',
    });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim().split('\n')[0];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 跑 DOM 测试（无头 Chrome + --dump-dom）                              */
/* ------------------------------------------------------------------ */

function runDomOnce(browser, pageFile, headlessFlag) {
  return new Promise((resolve) => {
    const profile = mkdtempSync(join(tmpdir(), 'dse-test-'));
    const child = spawn(
      browser,
      [
        headlessFlag,
        '--disable-gpu',
        '--no-sandbox',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--allow-file-access-from-files',
        '--hide-scrollbars',
        '--virtual-time-budget=8000',
        `--user-data-dir=${profile}`,
        '--window-size=1200,900',
        '--dump-dom',
        pathToFileURL(join(TESTS_DIR, pageFile)).href,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );

    let out = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.kill('SIGKILL');
      // Chrome 被 kill 后可能还在往 profile 目录里写，删不掉就算了（在临时目录里），
      // 绝不能因为清理失败而让整个测试跑挂掉。
      const cleanup = setTimeout(() => {
        try {
          rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
          /* 交给系统清理临时目录 */
        }
      }, 800);
      cleanup.unref?.();
      resolve(result);
    };

    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => finish({ ok: false, output: '' }));
    // 无头 Chrome 打完 DOM 后往往不主动退出，所以轮询到结果就收工
    const poll = setInterval(() => {
      if (out.includes(READY_MARKER)) finish({ ok: true, output: out });
    }, 200);
    const timer = setTimeout(() => finish({ ok: false, output: out }), TIMEOUT_MS);
    child.on('close', () => finish({ ok: out.includes(READY_MARKER), output: out }));
  });
}

async function runDomTest(browser, pageFile, label, expected) {
  // 新版 Chrome 移除了 --headless=old，所以失败就退回 --headless=new
  let result = await runDomOnce(browser, pageFile, '--headless=old');
  if (!result.ok) result = await runDomOnce(browser, pageFile, '--headless=new');

  if (!result.ok) {
    console.log(`  ${C.red}✗${C.reset} ${label}：无头浏览器没有返回结果（超时或被拦截）`);
    return { pass: 0, fail: expected, lines: [] };
  }

  const match = result.output.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  const text = (match ? match[1] : '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

  const lines = text.split('\n').filter((l) => l.includes(' | '));
  const pass = lines.filter((l) => l.startsWith('PASS')).length;
  const failed = lines.filter((l) => l.startsWith('FAIL'));
  const ok = failed.length === 0 && pass === expected;

  console.log(
    `  ${ok ? C.green + '✓' : C.red + '✗'}${C.reset} ${label}：` +
      `${pass}/${expected} 通过` +
      (failed.length ? ` ${C.red}（${failed.length} 项失败）${C.reset}` : '')
  );
  for (const l of failed) console.log(`      ${C.red}${l.replace(/^FAIL \| /, '')}${C.reset}`);
  if (!ok && failed.length === 0 && pass !== expected) {
    console.log(`      ${C.yellow}预期 ${expected} 项，实际只跑了 ${pass} 项${C.reset}`);
  }
  return { pass, fail: failed.length + Math.max(0, expected - pass - failed.length), lines };
}

/* ------------------------------------------------------------------ */
/* 跑 Node 测试                                                        */
/* ------------------------------------------------------------------ */

function runNodeTest() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(TESTS_DIR, 'background.test.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('close', (code) => {
      const summary = out.match(/=====\s*background\.js:\s*(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);
      const pass = summary ? Number(summary[1]) : 0;
      const fail = summary ? Number(summary[2]) : 1;
      console.log(
        `  ${fail === 0 ? C.green + '✓' : C.red + '✗'}${C.reset} background.js：` +
          `${pass} 通过${fail ? ` ${C.red}/ ${fail} 失败${C.reset}` : ''}`
      );
      if (fail || code !== 0) {
        console.log(out.split('\n').filter((l) => l.includes('❌')).map((l) => '      ' + l).join('\n'));
      }
      resolve({ pass, fail: fail || (code === 0 ? 0 : 1) });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

console.log(`\n${C.bold}DeepSeek Etymology · 测试套件${C.reset}\n`);

const browser = findBrowser();
if (!browser) {
  console.log(`${C.yellow}⚠ 没找到 Chrome/Chromium/Edge/Brave，DOM 测试将跳过。${C.reset}`);
  console.log(`${C.dim}  可用环境变量 CHROME_PATH 指定浏览器路径。${C.reset}\n`);
} else {
  console.log(`${C.dim}浏览器：${browser}${C.reset}\n`);
}

const results = [];
results.push(await runNodeTest());
if (browser) {
  results.push(await runDomTest(browser, 'content.dom.html', 'content.js  ', 24));
  results.push(await runDomTest(browser, 'options.dom.html', 'options.js  ', 17));
}

const totalPass = results.reduce((n, r) => n + r.pass, 0);
const totalFail = results.reduce((n, r) => n + r.fail, 0);

console.log(
  `\n${C.bold}合计：${totalFail === 0 ? C.green : C.red}${totalPass} 通过 / ${totalFail} 失败${C.reset}\n`
);
process.exit(totalFail === 0 ? 0 : 1);
