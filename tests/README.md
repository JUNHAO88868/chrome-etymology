# 测试套件

**76 项自动化测试**，覆盖这个插件的全部逻辑。任何人都可以在自己电脑上跑。

```bash
node tests/run.mjs
```

预期输出：

```
DeepSeek Etymology · 测试套件

浏览器：/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

  ✓ background.js：35 通过
  ✓ content.js  ：24/24 通过
  ✓ options.js  ：17/17 通过

合计：76 通过 / 0 失败
```

退出码 `0` = 全部通过，`1` = 有失败项（可直接接进 CI）。

## 依赖

- **Node.js 18+**（用到内置 `fetch` 与 ESM）
- **任意一个 Chromium 内核浏览器**：Chrome / Chromium / Edge / Brave
  - 自动在常见安装路径里查找；也可以手动指定：
    ```bash
    CHROME_PATH="/path/to/chrome" node tests/run.mjs
    ```
  - 找不到浏览器时，DOM 测试会自动跳过并提示，`background.js` 的 35 项照常运行。

## 三个套件分别在测什么

### 1. `background.test.mjs` — 35 项（纯 Node，不需要浏览器）

用桩（stub）替换 `chrome.*` 与 `fetch`，**直接加载真实的 `background.js` 源码**执行。

| 覆盖点 | 说明 |
| --- | --- |
| 无 Key 拦截 | 没填 Key 时必须返回 `NO_KEY`，且**不能发出任何网络请求** |
| 请求正确性 | endpoint、`Authorization: Bearer`、model、system prompt、`stream:false` |
| 错误码映射 | 401→`AUTH`、402→`BALANCE`、429→`RATE_LIMIT`、400/5xx 各自的处理 |
| 异常形态 | HTTP 200 但 body 里带 `error`、空回复、网络异常、超时（`AbortError`） |
| 寒暄剔除 | 模型输出以「好的，」开头时会被代码层削掉 |
| 消息路由 | `OPEN_OPTIONS`、`GET_STATUS`、未知消息返回 `false` |
| 省钱 | 「测试连接」只发 `max_tokens: 1` |

### 2. `content.dom.html` — 24 项（真实 Chrome DOM）

在真实浏览器里加载返回的页面，模拟划词、点击按钮、等待卡片渲染。

| 覆盖点 | 说明 |
| --- | --- |
| 全流程 | 划词 → 出现「✨ 查词源」→ 点击 → 卡片渲染出标题/正文/页脚 |
| Markdown | 标题、粗体、斜体、列表、引号统一成「」 |
| **安全** | 注入 `<img src=x onerror=...>` 必须被转义、页面里不能真的出现该元素、脚本不能执行 |
| 状态分支 | 未填 Key 的引导卡片、接口报错的展示、错误样式类 |
| 选择校验 | 数字不出按钮、4 个词不出按钮、`give up` 短语出按钮 |
| 健壮性 | `Esc` 关闭卡片、插件上下文失效（重装后未刷新页面）时给出友好提示而非崩溃 |

### 3. `options.dom.html` — 17 项（真实 Chrome DOM）

| 覆盖点 | 说明 |
| --- | --- |
| 配置读写 | 载入已存 Key / 模型，宽屏时切换成居中卡片布局 |
| Key 显示 | 「显示 / 隐藏」切换 |
| 输入校验 | 非 `sk-` 开头的 Key 要被拦下，且**不能写入存储** |
| 保存 | 首尾空格会被 trim；回车即保存；切换模型即时保存 |
| 测试连接 | 成功/失败两种结果的状态文案与样式 |

## 设计取舍

- **不 mock 被测代码本身。** `background.js` 是用 `vm` 加载**真实源码**跑的，只有它外面的 `chrome`/`fetch` 是桩。测试改的是外部世界，不是被测逻辑。
- **DOM 测试用真实浏览器。** 因为这里最容易出错的恰恰是「真实环境才有的东西」——CSS 注入、`window.getSelection()` 的行为、HTML 转义。用 jsdom 这类模拟环境测不出 XSS 转义是否真的生效。
- **无头 Chrome 不会自己退出。** 打完 DOM 后进程常驻，所以 `run.mjs` 轮询 stdout 里的完成标记，拿到结果就 `SIGKILL`，而不是干等进程结束。
- **`--headless=old` 失败会自动退回 `--headless=new`。** 新版 Chrome 移除了旧无头模式，这样脚本在两边都能跑。

## 自己加一条测试

- 改 `background.js` 的逻辑 → 加到 `background.test.mjs`，用 `loadWorker({ store, fetchImpl })` 造场景
- 改界面或选择逻辑 → 加到 `content.dom.html` 的 `results` 数组里，用 `ok('编号 描述', 条件)` 断言
- 计数变了，记得同步更新 `run.mjs` 里的期望值（`24` / `17`）和根 README 里的数字
