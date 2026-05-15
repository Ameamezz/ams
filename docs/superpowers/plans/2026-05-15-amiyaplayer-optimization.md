# AmiyaPlayer 集中优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 把 AmiyaPlayer 从一次性原型升级到可维护工具应用——修掉 7 个已识别 bug、收紧 Electron 安全配置、把 711 行 `main.js` 和 1917 行 `index.html` 拆成职责清晰的模块、增加托盘 + Boss Key、命令面板、数据导入导出三项功能、加最小工程化。

**架构：** 零构建（不引入 bundler / TypeScript / 框架），CommonJS。主进程通过 `preload.js` 的 `contextBridge` 暴露 `window.amiyaAPI` 给 renderer。renderer 端 JS 拆为 8 个 `<script>` 顺序加载，依赖通过 `window.AmiyaXxx` 全局命名空间显式衔接。纯函数提取到 `lib/` 给 Vitest 单元测试。

**Tech Stack：** Electron 33、Node 20、Vitest 1.x、ESLint flat config、GitHub Actions、Windows portable exe（electron-builder）。

**参考 Spec：** `docs/superpowers/specs/2026-05-15-amiyaplayer-optimization-design.md`

**4 波交付：**
- **Wave 1（PR1–PR3）** 修可靠性 bug + 引入工程化（lint/test）
- **Wave 2（PR4–PR6）** 架构重构 + 安全配置切换
- **Wave 3（PR7–PR8）** UX 补漏 + Electron 升级
- **Wave 4（PR9–PR12）** 三项新功能 + CI/QA 文档化

---

## Wave 1 · 修 bug + 工程化

### PR1 / Task 1：A1 修复 PowerShell 鼠标穿透字面 bug — **VOID（幻觉 bug，已撤销）**

> **执行时发现：** 此任务的前提错误。JS 模板字面量 `$${expr}` 实际产出 `$` + `${expr}`，所以 `$${enabled ? 'true' : 'false'}` 是合法的 `$true` / `$false`——原代码工作正常。同时 PowerShell `-EncodedCommand` 后追加命名参数会报错 "Cannot process command because a command is already specified"，意味着按本任务做出的"修复"反而是真实回归。Task 1 撤销（见 git commit 3bd6438），跳过此任务直接进入 Task 2。Spec 表格中的 A1 行已标 VOID。


**Files：**
- Modify: `main.js`（替换 `applyNativeClickThrough` 函数体，原约第 253–314 行）

**Why：** `main.js:304` 模板字符串中写的是 `$${enabled ? 'true' : 'false'}`，最终落到 PowerShell 里是字面 `$$true / $$false`，不是合法布尔。结果：F8 按下后只有 `setIgnoreMouseEvents` 起作用，Win32 兜底实际未生效；某些场景（子 OOPIF 子窗口）会重新拦截鼠标事件。

- [ ] **Step 1：把 PowerShell 脚本改为 `param()` 接受参数，不再字符串插值。**

把 `main.js` 中的 `applyNativeClickThrough` 整体替换为：

```js
function applyNativeClickThrough(enabled) {
  if (process.platform !== 'win32') {
    return;
  }

  const hwnd = getNativeWindowHandleValue();
  if (!hwnd) {
    return;
  }

  const script = `
param([int64]$Handle, [bool]$Enabled)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AmiyaClickThrough {
  private const int GWL_EXSTYLE = -20;
  private const long WS_EX_TRANSPARENT = 0x00000020L;
  private const long WS_EX_LAYERED = 0x00080000L;

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)]
  private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)]
  private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  [DllImport("user32.dll", SetLastError=true)]
  private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

  private static void ApplyOne(IntPtr hWnd, bool enabled) {
    long style = GetWindowLongPtr(hWnd, GWL_EXSTYLE).ToInt64();
    if (enabled) {
      style = style | WS_EX_LAYERED | WS_EX_TRANSPARENT;
    } else {
      style = style & ~WS_EX_TRANSPARENT;
    }
    SetWindowLongPtr(hWnd, GWL_EXSTYLE, new IntPtr(style));
  }

  public static void Apply(long handle, bool enabled) {
    IntPtr hWnd = new IntPtr(handle);
    ApplyOne(hWnd, enabled);
    EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr lParam) {
      ApplyOne(child, enabled);
      return true;
    }, IntPtr.Zero);
  }
}
"@

[AmiyaClickThrough]::Apply($Handle, $Enabled)
`;

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
      '-Handle', String(hwnd),
      '-Enabled', enabled ? '$true' : '$false'
    ],
    { windowsHide: true },
    (error, _stdout, stderr) => {
      if (process.env.AMIYAPLAYER_DEBUG && (error || stderr)) {
        // eslint-disable-next-line no-console
        console.error('[native-click-through]', error || stderr);
      }
    }
  );
}
```

> 注意：`-EncodedCommand` 后面接的是脚本本体，`param` 的参数通过命令行 `-Handle` / `-Enabled` 传入。PowerShell 接受 `$true` / `$false` 字符串作为 bool 参数。

- [ ] **Step 2：本地手动验证。**

启动应用：

```
npm start
```

打开任意窗口（比如记事本）放在 AmiyaPlayer 下层。按 F8 → 用鼠标点 AmiyaPlayer 区域 → 期望点击穿透到记事本（焦点切换到记事本）。再按 F8 → 期望点击回到 AmiyaPlayer。

如果穿透没生效，临时设 `AMIYAPLAYER_DEBUG=1` 再启动看 stderr 输出。

- [ ] **Step 3：commit。**

```
git add main.js
git commit -m "fix: native click-through PowerShell bool literal (A1)"
```

---

### PR1 / Task 2：A7 快捷键差异化注册

**Files：**
- Modify: `main.js`（替换 `registerShortcuts` 函数体，原约第 431–460 行；在函数上方加一个模块级 Map）

**Why：** `update-settings` 每次都 `globalShortcut.unregisterAll()` + 全量重注册，频繁触发副作用（包括 F8 这种与设置无关的快捷键）。

- [ ] **Step 1：在 `main.js` 顶部已有 `let nativeClickThroughTimer = null;` 附近新增：**

```js
const registeredShortcuts = new Map();
```

- [ ] **Step 2：把 `registerShortcuts` 整体替换为：**

```js
function registerShortcuts() {
  const desired = new Map();
  desired.set('F8', { action: '__builtin.toggleClickThrough', label: 'F8 紧急穿透切换' });

  settings.toolbar.forEach((button) => {
    const shortcut = String(button.shortcut || '').trim();
    if (button.deleted || !shortcut) {
      return;
    }
    const key = shortcut.toLowerCase();
    if (desired.has(key)) {
      return;
    }
    desired.set(key, { action: button.action, label: button.label, accelerator: shortcut });
  });

  const desiredKeys = new Set(desired.keys());
  const currentKeys = Array.from(registeredShortcuts.keys());

  currentKeys.forEach((key) => {
    if (!desiredKeys.has(key) || desired.get(key).action !== registeredShortcuts.get(key).action) {
      try {
        globalShortcut.unregister(registeredShortcuts.get(key).accelerator);
      } catch (_error) {
        // 反注册失败属于无害，直接清表。
      }
      registeredShortcuts.delete(key);
    }
  });

  desired.forEach((value, key) => {
    if (registeredShortcuts.has(key)) {
      return;
    }
    const accelerator = key === 'f8' ? 'F8' : value.accelerator;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (value.action === '__builtin.toggleClickThrough') {
          setClickThrough(!isClickThrough);
        } else {
          runShortcutAction(value.action);
        }
      });
      if (ok) {
        registeredShortcuts.set(key, { ...value, accelerator });
      }
    } catch (_error) {
      // 非法 accelerator 在设置 UI 已提示，这里静默跳过。
    }
  });
}
```

- [ ] **Step 3：把 `will-quit` 钩子里的 `globalShortcut.unregisterAll()` 后增加一行清表（防止下次 `whenReady` 复用时表脏），找到 `app.on('will-quit', ...)`（原 530 行）改为：**

```js
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  registeredShortcuts.clear();
});
```

- [ ] **Step 4：本地验证。**

启动 → 打开设置 → 改某个工具栏按钮的快捷键（比如把"提高透明度"从 F7 改成 F12）→ 验证：F7 不再生效、F12 生效、F8 仍然生效（应急穿透没被误反注册）。

- [ ] **Step 5：commit。**

```
git add main.js
git commit -m "fix: diff-based global shortcut registration (A7)"
```

---

### PR1 / Task 3：A2 历史记录双写去重

**Files：**
- Modify: `index.html`（替换 renderer `<script>` 中 `handleNavigation`、`recordVisit`、以及 `page-title-updated` 绑定）

**Why：** `did-navigate` 触发 `recordVisit(title=url)`，紧接 `page-title-updated` 又触发一次 `recordVisit(title=真实标题)`。每次导航写两次 JSON 文件，且历史里短暂保留脏 title。

- [ ] **Step 1：在 renderer `<script>` 内的状态声明附近（找 `let statusTimer = null;` 附近）新增：**

```js
const RECORD_DEDUPE_MS = 500;
let pendingRecord = null;
let lastRecordedAt = 0;
```

- [ ] **Step 2：把 `recordVisit` 函数体替换为节流 + 等待真实 title 的版本：**

```js
async function recordVisit(force = false) {
  if (!currentUrl || currentUrl === 'about:blank') {
    return;
  }

  const now = Date.now();
  if (!force && now - lastRecordedAt < RECORD_DEDUPE_MS && pendingRecord === currentUrl) {
    return;
  }

  pendingRecord = currentUrl;
  lastRecordedAt = now;

  state.history = await ipcRenderer.invoke('record-history', {
    title: currentTitle || currentUrl,
    url: currentUrl
  });

  await saveCurrentTab();
  renderSidebar();
  renderToolbar();
}
```

- [ ] **Step 3：把 `handleNavigation` 替换为只更新内存、不立刻写：**

```js
function handleNavigation(url) {
  currentUrl = url || webview.src || 'about:blank';
  input.value = currentUrl === 'about:blank' ? '' : currentUrl;
  currentTitle = currentUrl;
  insertedCssKey = null;
  pendingRecord = null;
  applyLayoutMode();
}
```

注意：把原来的 `recordVisit();` 删掉。

- [ ] **Step 4：让 `page-title-updated` 触发实际写入。找到原绑定（约 1860 行）：**

```js
webview.addEventListener('page-title-updated', (event) => {
  currentTitle = event.title || currentUrl;
  recordVisit();
});
```

改为：

```js
webview.addEventListener('page-title-updated', (event) => {
  currentTitle = event.title || currentUrl;
  recordVisit(true);
});
```

- [ ] **Step 5：本地验证。**

启动 → 访问 `https://www.bilibili.com/video/BV1xx411c7mD`（任一视频）→ 打开开发者工具看 `record-history` IPC 调用次数（renderer 端可以在 `recordVisit` 里临时加 `console.log`，验证完删掉）→ 期望每次完整导航只触发一次写入，且 title 是真实视频标题不是 URL。

- [ ] **Step 6：commit。**

```
git add index.html
git commit -m "fix: dedupe history writes on navigation (A2)"
```

---

### PR1 / Task 4：A3 透明度滑块 debounce + 延迟落盘

**Files：**
- Modify: `main.js`（拆分 `setOpacity`、新增 `commit-opacity` IPC）
- Modify: `index.html`（renderer 端 debounce + change 事件触发 commit）

**Why：** `input` 事件每像素调 IPC，且 `setOpacity` 默认 `persist=true` 每次都 `JSON.stringify` 落盘。

- [ ] **Step 1：在 `main.js` 中，把 `setOpacity` 拆分为两个函数：**

找到原 `setOpacity` 函数（约 325 行），替换为：

```js
function applyOpacityValue(nextOpacity) {
  settings.opacity = clamp(Number(nextOpacity), 0.3, 1, DEFAULT_SETTINGS.opacity);
  applyOpacity();
  sendStatePatch({ settings });
}

function persistOpacity() {
  saveSettings();
}

function setOpacity(nextOpacity, persist = true) {
  applyOpacityValue(nextOpacity);
  if (persist) {
    persistOpacity();
  }
}
```

- [ ] **Step 2：修改 `set-opacity` IPC 处理器，默认不落盘；新增 `commit-opacity` 处理器。**

找到 `ipcMain.handle('set-opacity', ...)`（约 566 行），替换为：

```js
ipcMain.handle('set-opacity', (_event, value) => {
  applyOpacityValue(value);
  return settings.opacity;
});

ipcMain.handle('commit-opacity', () => {
  persistOpacity();
  return settings.opacity;
});
```

- [ ] **Step 3：在 `index.html` 的 renderer `<script>` 中，把 `opacitySlider` 的 `input` 事件改为 debounce + change 落盘。**

找到原 `opacitySlider.addEventListener('input', ...)`（约 1828 行）。替换整个 listener 加挂载：

```js
let opacityDebounceTimer = null;
opacitySlider.addEventListener('input', () => {
  const opacity = Number(opacitySlider.value) / 100;
  updateOpacityUI(opacity);
  clearTimeout(opacityDebounceTimer);
  opacityDebounceTimer = setTimeout(async () => {
    state.settings.opacity = await ipcRenderer.invoke('set-opacity', opacity);
  }, 150);
});
opacitySlider.addEventListener('change', async () => {
  clearTimeout(opacityDebounceTimer);
  const opacity = Number(opacitySlider.value) / 100;
  state.settings.opacity = await ipcRenderer.invoke('set-opacity', opacity);
  await ipcRenderer.invoke('commit-opacity');
});
```

- [ ] **Step 4：本地验证。**

启动 → 打开 `app.getPath('userData')`（设置 → 网页数据 → 打开用户数据目录）→ 拖动透明度滑块来回 → 期望：拖动过程中 `settings.json` 的 mtime 不变化；松手 1 秒后 mtime 才更新。

- [ ] **Step 5：commit。**

```
git add main.js index.html
git commit -m "perf: debounce opacity slider and defer persistence (A3)"
```

---

### PR2 / Task 5：A6 重写 CSP

**Files：**
- Modify: `index.html`（第 5 行 `<meta http-equiv="Content-Security-Policy" ...>`）

**Why：** 当前 CSP 含 `frame-src` 对 `<webview>` 标签无效（webview 是独立 OOPIF/不同 partition），同时 `'unsafe-inline'` 在 `script-src` 里其实必要（脚本内联）但应在 Phase C 拆出 JS 后移除。本步先去掉无意义部分。

- [ ] **Step 1：替换 `index.html` 第 5 行为：**

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self';">
```

> 与 spec §3 最终目标 CSP 的差异：本步暂保留 `script-src 'unsafe-inline'`（因为 renderer JS 仍内联在 `<script>` 标签里）。Phase C / PR6 完成 renderer 拆分后再去掉。

- [ ] **Step 2：启动验证。**

```
npm start
```

打开 DevTools (Ctrl+Shift+I) → Console 标签 → 期望没有 CSP violation 报错。如果有，根据具体违规项调整（通常是某个 inline event handler 或 background-image url）。

- [ ] **Step 3：commit。**

```
git add index.html
git commit -m "chore: tighten CSP, drop ineffective frame-src (A6)"
```

---

### PR2 / Task 6：B5 chromium flags 模块化（仍在 main.js 内）

**Files：**
- Modify: `main.js`（替换原约第 70–83 行的 `DISABLED_CHROMIUM_FEATURES` 块）

**Why：** 现在所有 `appendSwitch` 散在文件顶部无注释，后续维护时容易误删导致 P2P 泄露或穿透坏掉。本步把它整理成带注释的数组，正式搬到 `main/chromium-flags.js` 留到 Phase C / PR4。

- [ ] **Step 1：替换原 `DISABLED_CHROMIUM_FEATURES` + `app.commandLine.appendSwitch` 块为：**

```js
// Chromium 启动开关清单。每条都注明用途，删除前请确认替代手段。
const CHROMIUM_DISABLED_FEATURES = [
  'MediaRouter',                       // 关闭 Chromium 内置投屏发现，避免遮蔽穿透层。
  'DialMediaRouteProvider',            // 同上，DLNA 设备发现。
  'GlobalMediaControlsCastStartStop',  // 隐藏全局媒体控制中的投屏按钮。
  'WebRtcHideLocalIpsWithMdns'         // 配合下方 WebRTC 关闭，避免 mDNS 局部地址泄露。
];

const CHROMIUM_SWITCHES = [
  ['disable-features', CHROMIUM_DISABLED_FEATURES.join(',')],
  ['disable-quic', null],                                          // 关 QUIC，避免某些 CDN 走 UDP 绕过抓包。
  ['disable-webrtc', null],                                        // 主要防 P2P/IP 泄露。
  ['disable-background-networking', null],                          // 关闭 Chromium 后台心跳。
  ['disable-domain-reliability', null],                             // 关闭 domain reliability 上报。
  ['force-webrtc-ip-handling-policy', 'disable_non_proxied_udp'],   // 双保险：即使 WebRTC 启用也走代理。
  ['webrtc-ip-handling-policy', 'disable_non_proxied_udp']
];

CHROMIUM_SWITCHES.forEach(([key, value]) => {
  if (value == null) {
    app.commandLine.appendSwitch(key);
  } else {
    app.commandLine.appendSwitch(key, value);
  }
});
```

- [ ] **Step 2：启动验证应用仍正常启动、F8 穿透仍 OK、B 站视频仍能播。**

- [ ] **Step 3：commit。**

```
git add main.js
git commit -m "chore: group chromium flags with explanatory comments (B5)"
```

---

### PR3 / Task 7：安装工程化工具链

**Files：**
- Modify: `package.json`
- Create: `eslint.config.js`
- Create: `vitest.config.js`
- Create: `.gitignore`（如果还没有）

- [ ] **Step 1：检查 `.gitignore` 是否存在。**

```
cat .gitignore 2>nul || echo "missing"
```

如果缺，新建 `.gitignore`：

```
node_modules/
dist/
*.log
.vscode/
.idea/
```

- [ ] **Step 2：安装 dev deps。**

```
npm install --save-dev vitest@1 eslint@9 globals@15
```

- [ ] **Step 3：在 `package.json` 的 `scripts` 中加入：**

把 `package.json` 的 `scripts` 字段替换为：

```json
"scripts": {
  "start": "electron .",
  "build": "electron-builder --win --x64",
  "lint": "eslint .",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 4：创建 `eslint.config.js`（flat config，仅约束硬错误）。**

```js
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**']
  },
  {
    files: ['main.js', 'webview-preload.js', 'lib/**/*.js', 'main/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-console': 'off'
    }
  },
  {
    files: ['index.html', 'renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        require: 'readonly',
        __dirname: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }]
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest
      }
    }
  }
];
```

> 注：`index.html` 里的 `<script>` 内容 ESLint 默认不读取；这里保留配置以便 Phase C / PR6 拆出独立文件后立即生效。

- [ ] **Step 5：创建 `vitest.config.js`。**

```js
module.exports = {
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    globals: false
  }
};
```

- [ ] **Step 6：验证空跑通。**

```
npm run lint
npm test
```

期望：`lint` 报告 0 错误（可能有 warning，不阻塞）；`test` 报告 "No test files found"（因为还没写测试，下个 task 写）。

- [ ] **Step 7：commit。**

```
git add package.json package-lock.json eslint.config.js vitest.config.js .gitignore
git commit -m "chore: add eslint + vitest tooling"
```

---

### PR3 / Task 8：提取 `lib/normalize-url.js` + 测试

**Files：**
- Create: `lib/normalize-url.js`
- Create: `tests/normalize-url.test.js`
- Modify: `index.html`（renderer 改用 `require('./lib/normalize-url')`）

**Why：** Renderer 端 `normalizeUrl` 是纯函数，提取后既可单测，又便于 Phase C 在没有 `nodeIntegration` 的环境复用。

- [ ] **Step 1：创建 `lib/normalize-url.js`。**

```js
'use strict';

function normalizeUrl(rawUrl) {
  let url = String(rawUrl == null ? '' : rawUrl).trim();
  if (!url) {
    return '';
  }
  if (url === 'about:blank') {
    return url;
  }
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url;
}

module.exports = { normalizeUrl };
```

- [ ] **Step 2：写测试 `tests/normalize-url.test.js`。**

```js
const { describe, it, expect } = require('vitest');
const { normalizeUrl } = require('../lib/normalize-url');

describe('normalizeUrl', () => {
  it('returns empty string for null / undefined / blank input', () => {
    expect(normalizeUrl(null)).toBe('');
    expect(normalizeUrl(undefined)).toBe('');
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
  });

  it('passes through about:blank verbatim', () => {
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });

  it('prefixes https:// when scheme is missing', () => {
    expect(normalizeUrl('www.bilibili.com')).toBe('https://www.bilibili.com');
    expect(normalizeUrl('bilibili.com/video/abc')).toBe('https://bilibili.com/video/abc');
  });

  it('keeps existing http:// and https:// schemes', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
    expect(normalizeUrl('HTTPS://Example.com')).toBe('HTTPS://Example.com');
  });

  it('trims surrounding whitespace before processing', () => {
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com');
  });
});
```

- [ ] **Step 3：跑测试看通过。**

```
npm test
```

期望 5 个 it 全部 PASS。如果失败，先修 lib 实现再过下一步。

- [ ] **Step 4：把 `index.html` 中的 inline `normalizeUrl` 替换为 require。**

找到 renderer `<script>` 内的 `function normalizeUrl(rawUrl) { ... }`（约 1164 行）和 `const path = require('path');` 附近。在 require 块下方加：

```js
const { normalizeUrl } = require('./lib/normalize-url');
```

然后删除原 inline 的 `function normalizeUrl(...)` 整段定义（约 14 行）。

- [ ] **Step 5：启动验证。**

```
npm start
```

地址栏输入 `www.bilibili.com` 回车 → 期望被规范成 `https://www.bilibili.com` 并加载。

- [ ] **Step 6：commit。**

```
git add lib/normalize-url.js tests/normalize-url.test.js index.html
git commit -m "test: extract and cover normalizeUrl"
```

---

### PR3 / Task 9：提取 `lib/normalize-settings.js` + 测试

**Files：**
- Create: `lib/normalize-settings.js`
- Create: `tests/normalize-settings.test.js`
- Modify: `main.js`（删除内联定义、改 require）

- [ ] **Step 1：创建 `lib/normalize-settings.js`。**

把 `main.js` 中的 `DEFAULT_TOOLBAR`、`LEGACY_TOOLBAR_LABELS`、`DEFAULT_SETTINGS`、`clamp`、`clone`、`normalizeToolbar`、`normalizeSettings` 完整移过来：

```js
'use strict';

const DEFAULT_TOOLBAR = [
  { id: 'back', type: 'builtin', action: 'nav.back', label: '后退', icon: '←', visible: true, shortcut: 'Alt+Left', order: 10 },
  { id: 'forward', type: 'builtin', action: 'nav.forward', label: '前进', icon: '→', visible: true, shortcut: 'Alt+Right', order: 20 },
  { id: 'refresh', type: 'builtin', action: 'nav.refresh', label: '刷新', icon: '↻', visible: true, shortcut: 'F5', order: 30 },
  { id: 'home', type: 'builtin', action: 'nav.home', label: '主页', icon: '⌂', visible: true, shortcut: '', order: 40 },
  { id: 'sidebar', type: 'builtin', action: 'ui.toggleSidebar', label: '侧栏', icon: '☰', visible: true, shortcut: '', order: 50 },
  { id: 'favorite', type: 'builtin', action: 'data.favoriteCurrent', label: '收藏当前页', icon: '☆', visible: true, shortcut: '', order: 60 },
  { id: 'pin', type: 'builtin', action: 'window.toggleAlwaysOnTop', label: '置顶', icon: '⌖', visible: true, shortcut: '', order: 70 },
  { id: 'click-through', type: 'builtin', action: 'window.toggleClickThrough', label: '鼠标穿透', icon: '⊘', visible: true, shortcut: 'F8', order: 80 },
  { id: 'playback', type: 'builtin', action: 'ui.togglePlaybackMode', label: '播放模式', icon: '◫', visible: true, shortcut: '', order: 90 },
  { id: 'clean', type: 'builtin', action: 'ui.toggleCleanMode', label: '纯净模式', icon: '□', visible: true, shortcut: '', order: 100 },
  { id: 'mode', type: 'builtin', action: 'bilibili.toggleMode', label: 'B站纯净/选集', icon: '▣', visible: true, shortcut: 'F4', order: 110 },
  { id: 'play-pause', type: 'builtin', action: 'video.togglePlay', label: '播放/暂停', icon: '▶', visible: true, shortcut: 'F9', order: 120 },
  { id: 'rewind', type: 'builtin', action: 'video.rewind', label: '后退5秒', icon: '⏪', visible: false, shortcut: 'F10', order: 130 },
  { id: 'forward-video', type: 'builtin', action: 'video.forward', label: '前进5秒', icon: '⏩', visible: false, shortcut: 'F11', order: 140 },
  { id: 'opacity-down', type: 'builtin', action: 'appearance.opacityDown', label: '降低透明度', icon: '−', visible: false, shortcut: 'F6', order: 150 },
  { id: 'opacity-up', type: 'builtin', action: 'appearance.opacityUp', label: '提高透明度', icon: '+', visible: false, shortcut: 'F7', order: 160 },
  { id: 'settings', type: 'builtin', action: 'ui.openSettings', label: '设置', icon: '⚙', visible: true, shortcut: '', order: 170 }
];

const LEGACY_TOOLBAR_LABELS = new Set([
  'Back', 'Forward', 'Refresh', 'Home', 'Sidebar', 'Favorite', 'Pin',
  'Click-through', 'Playback', 'Clean', 'Mode', 'B站模式', 'Play',
  'Rewind', 'Forward 5s', 'Less opaque', 'More opaque', 'Settings'
]);

const DEFAULT_SETTINGS = {
  schemaVersion: 2,
  opacity: 0.9,
  themeColor: '#00a1d6',
  sidebarWidth: 240,
  showTopBarInPlayback: true,
  restoreLastTabs: true,
  openLastUrl: true,
  homeUrl: 'https://www.bilibili.com',
  lastUrl: '',
  layoutMode: 'focus',
  toolbar: DEFAULT_TOOLBAR
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeToolbar(toolbar) {
  const incoming = Array.isArray(toolbar) ? toolbar : [];
  const byId = new Map(incoming.filter((item) => item && item.id).map((item) => [item.id, item]));

  return DEFAULT_TOOLBAR.map((defaultButton) => {
    const override = byId.get(defaultButton.id) || {};
    return {
      ...defaultButton,
      ...override,
      id: defaultButton.id,
      type: defaultButton.type,
      action: defaultButton.action,
      icon: override.icon || defaultButton.icon,
      label: LEGACY_TOOLBAR_LABELS.has(String(override.label || ''))
        ? defaultButton.label
        : String(override.label || defaultButton.label).slice(0, 24),
      visible: typeof override.visible === 'boolean' ? override.visible : defaultButton.visible,
      deleted: override.deleted === true,
      shortcut: override.shortcut == null ? defaultButton.shortcut : String(override.shortcut).slice(0, 32),
      order: Number.isFinite(Number(override.order)) ? Number(override.order) : defaultButton.order
    };
  }).sort((a, b) => a.order - b.order);
}

function normalizeSettings(rawSettings) {
  const loaded = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  return {
    ...clone(DEFAULT_SETTINGS),
    ...loaded,
    opacity: clamp(Number(loaded.opacity), 0.3, 1, DEFAULT_SETTINGS.opacity),
    sidebarWidth: clamp(Number(loaded.sidebarWidth), 220, 360, DEFAULT_SETTINGS.sidebarWidth),
    themeColor: /^#[0-9a-fA-F]{6}$/.test(String(loaded.themeColor || '')) ? loaded.themeColor : DEFAULT_SETTINGS.themeColor,
    layoutMode: loaded.layoutMode === 'select' ? 'select' : 'focus',
    toolbar: normalizeToolbar(loaded.toolbar)
  };
}

module.exports = {
  DEFAULT_TOOLBAR,
  LEGACY_TOOLBAR_LABELS,
  DEFAULT_SETTINGS,
  clone,
  clamp,
  normalizeToolbar,
  normalizeSettings
};
```

- [ ] **Step 2：在 `main.js` 顶部 require 替代内联定义。**

把 `const fs = require('fs'); const path = require('path');` 后面追加：

```js
const {
  DEFAULT_TOOLBAR,
  DEFAULT_SETTINGS,
  clone,
  clamp,
  normalizeToolbar,
  normalizeSettings
} = require('./lib/normalize-settings');
```

然后**删除** `main.js` 里原来的 `DEFAULT_TOOLBAR / LEGACY_TOOLBAR_LABELS / DEFAULT_SETTINGS / clone / clamp / normalizeToolbar / normalizeSettings` 7 处定义。

- [ ] **Step 3：写测试 `tests/normalize-settings.test.js`。**

```js
const { describe, it, expect } = require('vitest');
const {
  normalizeSettings,
  normalizeToolbar,
  DEFAULT_SETTINGS,
  DEFAULT_TOOLBAR
} = require('../lib/normalize-settings');

describe('normalizeSettings', () => {
  it('returns defaults when input is null / non-object', () => {
    expect(normalizeSettings(null).opacity).toBe(DEFAULT_SETTINGS.opacity);
    expect(normalizeSettings('garbage').themeColor).toBe(DEFAULT_SETTINGS.themeColor);
    expect(normalizeSettings(undefined).toolbar.length).toBe(DEFAULT_TOOLBAR.length);
  });

  it('clamps opacity into [0.3, 1]', () => {
    expect(normalizeSettings({ opacity: 0.1 }).opacity).toBe(0.3);
    expect(normalizeSettings({ opacity: 5 }).opacity).toBe(1);
    expect(normalizeSettings({ opacity: 'nan' }).opacity).toBe(DEFAULT_SETTINGS.opacity);
  });

  it('clamps sidebarWidth into [220, 360]', () => {
    expect(normalizeSettings({ sidebarWidth: 100 }).sidebarWidth).toBe(220);
    expect(normalizeSettings({ sidebarWidth: 500 }).sidebarWidth).toBe(360);
  });

  it('falls back to default theme color when format is invalid', () => {
    expect(normalizeSettings({ themeColor: 'red' }).themeColor).toBe(DEFAULT_SETTINGS.themeColor);
    expect(normalizeSettings({ themeColor: '#ABCDEF' }).themeColor).toBe('#ABCDEF');
  });

  it('only accepts "select" or "focus" for layoutMode', () => {
    expect(normalizeSettings({ layoutMode: 'select' }).layoutMode).toBe('select');
    expect(normalizeSettings({ layoutMode: 'banana' }).layoutMode).toBe('focus');
  });
});

describe('normalizeToolbar', () => {
  it('keeps all default buttons even when input is empty', () => {
    expect(normalizeToolbar([]).length).toBe(DEFAULT_TOOLBAR.length);
  });

  it('overrides label up to 24 chars, drops legacy English labels', () => {
    const result = normalizeToolbar([{ id: 'back', label: 'Back' }]);
    const back = result.find((b) => b.id === 'back');
    expect(back.label).toBe('后退');

    const long = 'x'.repeat(100);
    const result2 = normalizeToolbar([{ id: 'back', label: long }]);
    expect(result2.find((b) => b.id === 'back').label.length).toBe(24);
  });

  it('preserves deleted flag', () => {
    const result = normalizeToolbar([{ id: 'rewind', deleted: true }]);
    expect(result.find((b) => b.id === 'rewind').deleted).toBe(true);
  });

  it('sorts by order ascending', () => {
    const result = normalizeToolbar([
      { id: 'back', order: 999 },
      { id: 'settings', order: 1 }
    ]);
    expect(result[0].id).toBe('settings');
  });
});
```

- [ ] **Step 4：跑测试和 lint。**

```
npm test
npm run lint
```

期望全部 PASS（lint 仅 warning 可忽略）。

- [ ] **Step 5：启动验证。**

```
npm start
```

期望启动正常，设置抽屉打开看工具栏编辑器条目还在。

- [ ] **Step 6：commit。**

```
git add lib/normalize-settings.js tests/normalize-settings.test.js main.js
git commit -m "test: extract and cover normalizeSettings / normalizeToolbar"
```

---

### PR3 / Task 10：提取 `lib/normalize-items.js` + 测试

**Files：**
- Create: `lib/normalize-items.js`
- Create: `tests/normalize-items.test.js`
- Modify: `main.js`

- [ ] **Step 1：创建 `lib/normalize-items.js`。**

```js
'use strict';

function createId() {
  if (global.crypto && typeof global.crypto.randomUUID === 'function') {
    return global.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeItems(items, maxItems) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .filter((item) => item && typeof item.url === 'string' && item.url.trim())
    .map((item) => ({
      id: String(item.id || createId()),
      title: String(item.title || item.url).slice(0, 160),
      url: item.url,
      createdAt: item.createdAt || item.visitedAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.visitedAt || new Date().toISOString(),
      visitedAt: item.visitedAt || item.updatedAt || item.createdAt || new Date().toISOString()
    }))
    .slice(0, maxItems);
}

module.exports = { createId, normalizeItems };
```

- [ ] **Step 2：在 `main.js` require 并删除内联定义。**

在 `main.js` 顶部 require 块追加：

```js
const { createId, normalizeItems } = require('./lib/normalize-items');
```

删除 `main.js` 里的 `createId`（约 212 行）和 `normalizeItems`（约 171 行）定义。

- [ ] **Step 3：写测试 `tests/normalize-items.test.js`。**

```js
const { describe, it, expect } = require('vitest');
const { normalizeItems, createId } = require('../lib/normalize-items');

describe('normalizeItems', () => {
  it('returns empty array for non-array input', () => {
    expect(normalizeItems(null, 10)).toEqual([]);
    expect(normalizeItems('garbage', 10)).toEqual([]);
    expect(normalizeItems({}, 10)).toEqual([]);
  });

  it('drops items without a usable url', () => {
    const out = normalizeItems([
      { url: 'https://a.com' },
      { url: '' },
      { url: '   ' },
      { title: 'missing url' },
      null
    ], 10);
    expect(out.length).toBe(1);
    expect(out[0].url).toBe('https://a.com');
  });

  it('truncates title to 160 chars', () => {
    const out = normalizeItems([{ url: 'https://a.com', title: 'x'.repeat(500) }], 10);
    expect(out[0].title.length).toBe(160);
  });

  it('uses url as fallback title', () => {
    const out = normalizeItems([{ url: 'https://a.com' }], 10);
    expect(out[0].title).toBe('https://a.com');
  });

  it('applies maxItems cap', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ url: `https://x${i}.com` }));
    expect(normalizeItems(items, 5).length).toBe(5);
  });

  it('fills missing timestamps with current ISO time', () => {
    const out = normalizeItems([{ url: 'https://a.com' }], 10);
    expect(typeof out[0].createdAt).toBe('string');
    expect(out[0].createdAt).toBe(out[0].updatedAt);
    expect(() => new Date(out[0].createdAt).toISOString()).not.toThrow();
  });
});

describe('createId', () => {
  it('returns non-empty unique-ish string', () => {
    const a = createId();
    const b = createId();
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 4：跑测试 + lint + 启动验证。**

```
npm test
npm run lint
npm start
```

- [ ] **Step 5：commit。**

```
git add lib/normalize-items.js tests/normalize-items.test.js main.js
git commit -m "test: extract and cover normalizeItems"
```

---

### PR3 / Task 11：提取 `lib/toolbar-order.js` + 测试

**Files：**
- Create: `lib/toolbar-order.js`
- Create: `tests/toolbar-order.test.js`
- Modify: `index.html`（renderer `moveToolbarButton` 改用新模块）

**Why：** renderer 端 `moveToolbarButton` 是纯函数式的排序计算，单测它能防止"上移到顶后排序错乱"等回归。

- [ ] **Step 1：创建 `lib/toolbar-order.js`。**

```js
'use strict';

function reorderToolbar(toolbar, id, direction) {
  const active = toolbar.filter((button) => !button.deleted);
  const deleted = toolbar.filter((button) => button.deleted);
  const index = active.findIndex((button) => button.id === id);
  const nextIndex = index + direction;

  if (index < 0 || nextIndex < 0 || nextIndex >= active.length) {
    return toolbar.slice();
  }

  const [item] = active.splice(index, 1);
  active.splice(nextIndex, 0, item);
  active.forEach((button, nextOrder) => {
    button.order = (nextOrder + 1) * 10;
  });
  return [...active, ...deleted];
}

module.exports = { reorderToolbar };
```

- [ ] **Step 2：写测试 `tests/toolbar-order.test.js`。**

```js
const { describe, it, expect } = require('vitest');
const { reorderToolbar } = require('../lib/toolbar-order');

const sample = () => [
  { id: 'a', order: 10, deleted: false },
  { id: 'b', order: 20, deleted: false },
  { id: 'c', order: 30, deleted: false },
  { id: 'gone', order: 40, deleted: true }
];

describe('reorderToolbar', () => {
  it('moves item down by 1', () => {
    const out = reorderToolbar(sample(), 'a', 1);
    expect(out.map((b) => b.id)).toEqual(['b', 'a', 'c', 'gone']);
    expect(out[0].order).toBe(10);
    expect(out[1].order).toBe(20);
    expect(out[2].order).toBe(30);
  });

  it('moves item up by 1', () => {
    const out = reorderToolbar(sample(), 'c', -1);
    expect(out.map((b) => b.id)).toEqual(['a', 'c', 'b', 'gone']);
  });

  it('returns copy unchanged when moving first item up', () => {
    const out = reorderToolbar(sample(), 'a', -1);
    expect(out.map((b) => b.id)).toEqual(['a', 'b', 'c', 'gone']);
  });

  it('returns copy unchanged when moving last item down', () => {
    const out = reorderToolbar(sample(), 'c', 1);
    expect(out.map((b) => b.id)).toEqual(['a', 'b', 'c', 'gone']);
  });

  it('keeps deleted items at end and does not reassign their order', () => {
    const out = reorderToolbar(sample(), 'b', 1);
    expect(out[out.length - 1].id).toBe('gone');
    expect(out[out.length - 1].order).toBe(40);
  });

  it('returns copy unchanged when id not found', () => {
    const out = reorderToolbar(sample(), 'nonexistent', 1);
    expect(out.map((b) => b.id)).toEqual(['a', 'b', 'c', 'gone']);
  });
});
```

- [ ] **Step 3：在 `index.html` 的 renderer `<script>` 中接入。**

在 `require` 块附近追加：

```js
const { reorderToolbar } = require('./lib/toolbar-order');
```

把 renderer 中原 `function moveToolbarButton(id, direction) { ... }`（约 1321 行）替换为：

```js
function moveToolbarButton(id, direction) {
  const next = reorderToolbar(sortedToolbar(), id, direction);
  updateSettings({ toolbar: next });
}
```

- [ ] **Step 4：跑全套验证。**

```
npm test
npm run lint
npm start
```

启动后：打开设置 → 工具栏编辑器 → 点击某个按钮的 ↑ ↓ 验证顺序正确变化、删除态保留。

- [ ] **Step 5：commit。**

```
git add lib/toolbar-order.js tests/toolbar-order.test.js index.html
git commit -m "test: extract and cover toolbar reordering"
```

---

> **Wave 1 完成节点。** 此时仓库状态：
> - 7 个 PR 中前 3 个完成（PR1+PR2+PR3 各自独立可发布）
> - 4 个明显 bug 已修
> - 工程化基线就位（lint + 4 个测试文件，27 个 it 全绿）
> - 代码体积变化：`main.js` 约 -120 行，`index.html` 约 -20 行，`lib/` 新增 4 个文件约 200 行
>
> 建议在此打 tag `v1.0.1-wave1`，先合一个发布，再进入 Wave 2。

---

## Wave 2 · 架构重构

### PR4 / Task 12：抽出 `renderer/styles.css`

**Files：**
- Create: `renderer/styles.css`
- Modify: `index.html`（删除 `<style>` 块，改 `<link rel="stylesheet">`）

**Why：** 纯搬运，零逻辑变化，作为 Wave 2 的最小热身。

- [ ] **Step 1：创建目录并复制 CSS。**

```
mkdir renderer
```

把 `index.html` 第 7–571 行（`<style>` 内的所有 CSS）整体移到新文件 `renderer/styles.css`（不带 `<style>` 标签）。

- [ ] **Step 2：在 `index.html` 的 `<head>` 中加入：**

替换原 `<style>...</style>` 块为：

```html
<link rel="stylesheet" href="renderer/styles.css">
```

- [ ] **Step 3：启动验证视觉一致。**

```
npm start
```

期望 UI 完全没有变化（关键检查：透明度、主题色 accent、工具栏 hover 态、侧栏布局）。

- [ ] **Step 4：commit。**

```
git add renderer/styles.css index.html
git commit -m "refactor: extract renderer styles to dedicated file (Phase C)"
```

---

### PR4 / Task 13：抽出 `main/storage.js`

**Files：**
- Create: `main/storage.js`
- Modify: `main.js`（删除 storage 函数、改 require）

- [ ] **Step 1：创建 `main/storage.js`。**

```js
'use strict';

const fs = require('fs');
const path = require('path');

function getDataPathFactory(userDataDir) {
  return function getDataPath(fileName) {
    return path.join(userDataDir, fileName);
  };
}

function loadJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed == null ? clone(fallback) : parsed;
  } catch (_error) {
    return clone(fallback);
  }
}

function saveJson(filePath, data) {
  try {
    const dir = path.dirname(filePath);
    const tempPath = `${filePath}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  getDataPathFactory,
  loadJson,
  saveJson
};
```

- [ ] **Step 2：修改 `main.js` 顶部 require。**

追加：

```js
const storage = require('./main/storage');
```

然后改写 `loadJson` / `saveJson` / `getDataPath` 调用点：把 `main.js` 中原 `function getDataPath(fileName)`、`function loadJson(...)`、`function saveJson(...)` 三个定义删除。在 `loadAllData` 上方加：

```js
const getDataPath = storage.getDataPathFactory(app.getPath('userData'));
function loadJson(fileName, fallback) {
  return storage.loadJson(getDataPath(fileName), fallback);
}
function saveJson(fileName, data) {
  return storage.saveJson(getDataPath(fileName), data);
}
```

> 这一层 thin wrapper 保留是为了让 `loadAllData` / `saveSettings` 等调用点不变，最小化触碰面。

- [ ] **Step 3：启动验证。**

```
npm start
```

启动 → 改一下透明度并松手 → 退出 → 再启动 → 透明度保持。`settings.json` 写入 OK。

- [ ] **Step 4：commit。**

```
git add main/storage.js main.js
git commit -m "refactor: extract storage helpers to main/storage.js (Phase C)"
```

---

### PR4 / Task 14：抽出 `main/native-click-through.js` + `main/chromium-flags.js`

**Files：**
- Create: `main/native-click-through.js`
- Create: `main/chromium-flags.js`
- Modify: `main.js`

- [ ] **Step 1：创建 `main/native-click-through.js`。**

把 `main.js` 里 `getNativeWindowHandleValue`、`applyNativeClickThrough`、`queueNativeClickThrough` 三个函数搬过来，但 `queueNativeClickThrough` 持有的 `nativeClickThroughTimer` 也封装进模块：

```js
'use strict';

const { execFile } = require('child_process');

let nativeClickThroughTimer = null;

function getNativeWindowHandleValue(win) {
  if (!win || win.isDestroyed()) {
    return null;
  }
  const handle = win.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) {
    return null;
  }
  if (handle.length >= 8) {
    return handle.readBigUInt64LE(0).toString();
  }
  return BigInt(handle.readUInt32LE(0)).toString();
}

function applyNativeClickThrough(win, enabled) {
  if (process.platform !== 'win32') {
    return;
  }
  const hwnd = getNativeWindowHandleValue(win);
  if (!hwnd) {
    return;
  }

  const script = `
param([int64]$Handle, [bool]$Enabled)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class AmiyaClickThrough {
  private const int GWL_EXSTYLE = -20;
  private const long WS_EX_TRANSPARENT = 0x00000020L;
  private const long WS_EX_LAYERED = 0x00080000L;

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)]
  private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)]
  private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

  [DllImport("user32.dll", SetLastError=true)]
  private static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

  private static void ApplyOne(IntPtr hWnd, bool enabled) {
    long style = GetWindowLongPtr(hWnd, GWL_EXSTYLE).ToInt64();
    if (enabled) { style = style | WS_EX_LAYERED | WS_EX_TRANSPARENT; }
    else { style = style & ~WS_EX_TRANSPARENT; }
    SetWindowLongPtr(hWnd, GWL_EXSTYLE, new IntPtr(style));
  }

  public static void Apply(long handle, bool enabled) {
    IntPtr hWnd = new IntPtr(handle);
    ApplyOne(hWnd, enabled);
    EnumChildWindows(hWnd, delegate(IntPtr child, IntPtr lParam) {
      ApplyOne(child, enabled);
      return true;
    }, IntPtr.Zero);
  }
}
"@

[AmiyaClickThrough]::Apply($Handle, $Enabled)
`;

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
      '-Handle', String(hwnd),
      '-Enabled', enabled ? '$true' : '$false'
    ],
    { windowsHide: true },
    (error, _stdout, stderr) => {
      if (process.env.AMIYAPLAYER_DEBUG && (error || stderr)) {
        // eslint-disable-next-line no-console
        console.error('[native-click-through]', error || stderr);
      }
    }
  );
}

function queueNativeClickThrough(win, enabled) {
  if (nativeClickThroughTimer) {
    clearTimeout(nativeClickThroughTimer);
  }
  applyNativeClickThrough(win, enabled);
  nativeClickThroughTimer = setTimeout(() => applyNativeClickThrough(win, enabled), 250);
}

module.exports = { applyNativeClickThrough, queueNativeClickThrough };
```

- [ ] **Step 2：创建 `main/chromium-flags.js`。**

```js
'use strict';

// Chromium 启动开关清单。每条都注明用途，删除前请确认替代手段。
const CHROMIUM_DISABLED_FEATURES = [
  'MediaRouter',
  'DialMediaRouteProvider',
  'GlobalMediaControlsCastStartStop',
  'WebRtcHideLocalIpsWithMdns'
];

const CHROMIUM_SWITCHES = [
  ['disable-features', CHROMIUM_DISABLED_FEATURES.join(',')],
  ['disable-quic', null],
  ['disable-webrtc', null],
  ['disable-background-networking', null],
  ['disable-domain-reliability', null],
  ['force-webrtc-ip-handling-policy', 'disable_non_proxied_udp'],
  ['webrtc-ip-handling-policy', 'disable_non_proxied_udp']
];

function applyChromiumFlags(app) {
  CHROMIUM_SWITCHES.forEach(([key, value]) => {
    if (value == null) {
      app.commandLine.appendSwitch(key);
    } else {
      app.commandLine.appendSwitch(key, value);
    }
  });
}

module.exports = { applyChromiumFlags };
```

- [ ] **Step 3：修改 `main.js`。**

把 `main.js` 顶部的 chromium-flags 整块替换为：

```js
const { applyChromiumFlags } = require('./main/chromium-flags');
const { queueNativeClickThrough } = require('./main/native-click-through');

applyChromiumFlags(app);
```

把 `setClickThrough` 中的 `queueNativeClickThrough(isClickThrough)` 改为 `queueNativeClickThrough(win, isClickThrough)`。

删除 `main.js` 里的 `getNativeWindowHandleValue / applyNativeClickThrough / queueNativeClickThrough / nativeClickThroughTimer` 4 个定义。

- [ ] **Step 4：跑验证。**

```
npm start
```

按 F8 → 期望穿透切换正常。

- [ ] **Step 5：commit。**

```
git add main/native-click-through.js main/chromium-flags.js main.js
git commit -m "refactor: extract native click-through and chromium flags (Phase C)"
```

---

### PR5 / Task 15：创建 `preload.js` 与 `window.amiyaAPI`

**Files：**
- Create: `preload.js`
- Modify: `main.js`（`createWindow` 改 webPreferences）
- Modify: `index.html`（renderer 改用 `window.amiyaAPI`）

**Why：** Wave 2 的核心一步。完成后主窗口安全配置达到推荐档（`contextIsolation:true / nodeIntegration:false`）。

- [ ] **Step 1：创建 `preload.js`。**

```js
'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('amiyaAPI', {
  getAppState: () => ipcRenderer.invoke('get-app-state'),
  onStatePatch: (handler) => ipcRenderer.on('app-state-updated', (_e, p) => handler(p)),
  onRunAction: (handler) => ipcRenderer.on('run-action', (_e, a) => handler(a)),
  onToggleUI: (handler) => ipcRenderer.on('toggle-ui', (_e, v) => handler(v)),
  onOpenUrl: (handler) => ipcRenderer.on('open-url-in-webview', (_e, u) => handler(u)),
  windowControl: (cmd) => ipcRenderer.invoke('window-control', cmd),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  toggleClickThrough: () => ipcRenderer.invoke('toggle-click-through'),
  setOpacity: (v) => ipcRenderer.invoke('set-opacity', v),
  commitOpacity: () => ipcRenderer.invoke('commit-opacity'),
  updateSettings: (patch) => ipcRenderer.invoke('update-settings', patch),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),
  recordHistory: (p) => ipcRenderer.invoke('record-history', p),
  saveTabs: (tabs) => ipcRenderer.invoke('save-tabs', tabs),
  removeTab: (id) => ipcRenderer.invoke('remove-tab', id),
  removeHistory: (id) => ipcRenderer.invoke('remove-history', id),
  addFavorite: (p) => ipcRenderer.invoke('add-favorite', p),
  removeFavorite: (id) => ipcRenderer.invoke('remove-favorite', id),
  clearCurrentSiteData: (origin) => ipcRenderer.invoke('clear-current-site-data', origin),
  clearAllWebData: () => ipcRenderer.invoke('clear-all-web-data'),
  openUserDataFolder: () => ipcRenderer.invoke('open-user-data-folder'),
  setPositionalClickThrough: (rect) => ipcRenderer.invoke('set-positional-click-through', rect),
  webviewPreloadUrl: pathToFileURL(path.join(__dirname, 'webview-preload.js')).toString()
});
```

- [ ] **Step 2：修改 `main.js` 的 `createWindow`。**

找到 `webPreferences: { nodeIntegration: true, contextIsolation: false, ... }`（约 473 行），替换为：

```js
webPreferences: {
  preload: path.join(__dirname, 'preload.js'),
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: false,
  webviewTag: true,
  partition: WEBVIEW_PARTITION,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}
```

- [ ] **Step 3：在 `index.html` 中替换 renderer `<script>` 顶部的 require 块。**

找到 `<script>` 开头处：

```js
const { ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
```

替换为：

```js
const api = window.amiyaAPI;
```

然后**全文检索并替换** renderer `<script>` 内所有 `ipcRenderer.invoke('xxx', ...)` 和 `ipcRenderer.on('xxx', ...)` 调用为 `api` 对应方法。映射表：

| 旧 | 新 |
|---|---|
| `ipcRenderer.invoke('get-app-state')` | `api.getAppState()` |
| `ipcRenderer.invoke('window-control', cmd)` | `api.windowControl(cmd)` |
| `ipcRenderer.invoke('toggle-always-on-top')` | `api.toggleAlwaysOnTop()` |
| `ipcRenderer.invoke('toggle-click-through')` | `api.toggleClickThrough()` |
| `ipcRenderer.invoke('set-opacity', v)` | `api.setOpacity(v)` |
| `ipcRenderer.invoke('commit-opacity')` | `api.commitOpacity()` |
| `ipcRenderer.invoke('update-settings', p)` | `api.updateSettings(p)` |
| `ipcRenderer.invoke('reset-settings')` | `api.resetSettings()` |
| `ipcRenderer.invoke('record-history', p)` | `api.recordHistory(p)` |
| `ipcRenderer.invoke('save-tabs', t)` | `api.saveTabs(t)` |
| `ipcRenderer.invoke('remove-tab', id)` | `api.removeTab(id)` |
| `ipcRenderer.invoke('remove-history', id)` | `api.removeHistory(id)` |
| `ipcRenderer.invoke('add-favorite', p)` | `api.addFavorite(p)` |
| `ipcRenderer.invoke('remove-favorite', id)` | `api.removeFavorite(id)` |
| `ipcRenderer.invoke('clear-current-site-data', o)` | `api.clearCurrentSiteData(o)` |
| `ipcRenderer.invoke('clear-all-web-data')` | `api.clearAllWebData()` |
| `ipcRenderer.invoke('open-user-data-folder')` | `api.openUserDataFolder()` |
| `ipcRenderer.on('toggle-ui', cb)` | `api.onToggleUI(cb)` |
| `ipcRenderer.on('run-action', cb)` | `api.onRunAction(cb)` |
| `ipcRenderer.on('open-url-in-webview', cb)` | `api.onOpenUrl(cb)` |
| `ipcRenderer.on('app-state-updated', cb)` | `api.onStatePatch(cb)` |

> 注意 `api.onXxx` 的 handler 签名只收 patch（不带 `_event` 参数），要调整 callback。

- [ ] **Step 4：替换 webview 的 `preload` 属性来源。**

renderer `<script>` 顶部原有：

```js
webview.setAttribute('preload', pathToFileURL(path.join(__dirname, 'webview-preload.js')).toString());
```

替换为：

```js
webview.setAttribute('preload', api.webviewPreloadUrl);
```

并删除 renderer 中所有 `require('path')` / `require('url')` 残留。

- [ ] **Step 5：把 lib/ 的 `require` 改用 `<script>` 加载。**

由于 renderer 现在没有 nodeIntegration，无法 `require()`。把 `lib/normalize-url.js`、`lib/toolbar-order.js` 改造为双导出（UMD-lite）：

修改 `lib/normalize-url.js` 末尾：

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeUrl };
} else if (typeof window !== 'undefined') {
  window.AmiyaNormalize = window.AmiyaNormalize || {};
  window.AmiyaNormalize.normalizeUrl = normalizeUrl;
}
```

（把原来的 `module.exports = { normalizeUrl };` 替换为上面这块。）

同样修改 `lib/toolbar-order.js` 末尾：

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { reorderToolbar };
} else if (typeof window !== 'undefined') {
  window.AmiyaToolbar = window.AmiyaToolbar || {};
  window.AmiyaToolbar.reorderToolbar = reorderToolbar;
}
```

然后在 `index.html` 的 `</body>` 之前的 `<script>` **之前**新增：

```html
<script src="lib/normalize-url.js"></script>
<script src="lib/toolbar-order.js"></script>
```

并在 renderer 主 `<script>` 顶部把原来的：

```js
const { normalizeUrl } = require('./lib/normalize-url');
const { reorderToolbar } = require('./lib/toolbar-order');
```

替换为：

```js
const { normalizeUrl } = window.AmiyaNormalize;
const { reorderToolbar } = window.AmiyaToolbar;
```

- [ ] **Step 6：跑测试确认 UMD 改造没破单测。**

```
npm test
```

期望所有测试仍 PASS。

- [ ] **Step 7：启动验证。**

```
npm start
```

启动后**完整回归一遍**：
- 顶部地址栏输入 URL 能打开
- 工具栏所有按钮可点
- 设置抽屉可打开、改透明度
- F8 穿透切换正常
- 关闭重开仍记得 lastUrl

如果 DevTools 报 `window.amiyaAPI is undefined`，检查 preload 路径和 `contextIsolation` 是否真的为 true。

- [ ] **Step 8：commit。**

```
git add preload.js main.js index.html lib/normalize-url.js lib/toolbar-order.js
git commit -m "refactor: contextBridge preload + safe renderer config (B1, Phase C)"
```

---

### PR5 / Task 16：B2 IPC 输入校验

**Files：**
- Create: `main/ipc-validators.js`
- Modify: `main.js`（在每个 `ipcMain.handle` 入口套校验）

- [ ] **Step 1：创建 `main/ipc-validators.js`。**

```js
'use strict';

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value) {
  return typeof value === 'string';
}

function isNonEmptyString(value) {
  return isString(value) && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateWindowCommand(cmd) {
  return ['minimize', 'maximize', 'close'].includes(cmd);
}

function validateOpacity(value) {
  return isFiniteNumber(Number(value)) && Number(value) >= 0 && Number(value) <= 1.5;
}

function validateSettingsPatch(patch) {
  return isPlainObject(patch);
}

function validateUrlPayload(payload) {
  return isPlainObject(payload) && isNonEmptyString(payload.url);
}

function validateTabsArray(tabs) {
  return Array.isArray(tabs);
}

function validateId(id) {
  return isString(id) && id.length > 0;
}

function validateOrigin(origin) {
  return isNonEmptyString(origin);
}

module.exports = {
  validateWindowCommand,
  validateOpacity,
  validateSettingsPatch,
  validateUrlPayload,
  validateTabsArray,
  validateId,
  validateOrigin
};
```

- [ ] **Step 2：在 `main.js` 顶部 require：**

```js
const validators = require('./main/ipc-validators');
```

- [ ] **Step 3：给每个 `ipcMain.handle` 套上校验。**

逐个修改：

```js
ipcMain.handle('window-control', (_event, command) => {
  if (!validators.validateWindowCommand(command)) {
    return false;
  }
  // ...原逻辑
});

ipcMain.handle('set-opacity', (_event, value) => {
  if (!validators.validateOpacity(value)) {
    return settings.opacity;
  }
  applyOpacityValue(value);
  return settings.opacity;
});

ipcMain.handle('update-settings', (_event, patch) => {
  if (!validators.validateSettingsPatch(patch)) {
    return settings;
  }
  // ...原逻辑
});

ipcMain.handle('record-history', (_event, payload) => {
  if (!validators.validateUrlPayload(payload)) {
    return historyItems;
  }
  // ...原逻辑
});

ipcMain.handle('save-tabs', (_event, nextTabs) => {
  if (!validators.validateTabsArray(nextTabs)) {
    return tabs;
  }
  // ...原逻辑
});

ipcMain.handle('remove-tab', (_event, id) => {
  if (!validators.validateId(id)) {
    return tabs;
  }
  // ...原逻辑
});

ipcMain.handle('remove-history', (_event, id) => {
  if (!validators.validateId(id)) {
    return historyItems;
  }
  // ...原逻辑
});

ipcMain.handle('add-favorite', (_event, payload) => {
  if (!validators.validateUrlPayload(payload)) {
    return favorites;
  }
  // ...原逻辑
});

ipcMain.handle('remove-favorite', (_event, id) => {
  if (!validators.validateId(id)) {
    return favorites;
  }
  // ...原逻辑
});

ipcMain.handle('clear-current-site-data', async (_event, origin) => {
  if (!validators.validateOrigin(origin)) {
    return false;
  }
  // ...原逻辑
});
```

- [ ] **Step 4：写一个最小的校验函数测试 `tests/ipc-validators.test.js`。**

```js
const { describe, it, expect } = require('vitest');
const v = require('../main/ipc-validators');

describe('ipc validators', () => {
  it('validates window commands', () => {
    expect(v.validateWindowCommand('minimize')).toBe(true);
    expect(v.validateWindowCommand('close')).toBe(true);
    expect(v.validateWindowCommand('explode')).toBe(false);
    expect(v.validateWindowCommand(null)).toBe(false);
  });

  it('validates opacity', () => {
    expect(v.validateOpacity(0.5)).toBe(true);
    expect(v.validateOpacity('0.5')).toBe(true);
    expect(v.validateOpacity(-1)).toBe(false);
    expect(v.validateOpacity(NaN)).toBe(false);
    expect(v.validateOpacity('garbage')).toBe(false);
  });

  it('validates url payloads', () => {
    expect(v.validateUrlPayload({ url: 'https://x.com' })).toBe(true);
    expect(v.validateUrlPayload({ url: '' })).toBe(false);
    expect(v.validateUrlPayload({})).toBe(false);
    expect(v.validateUrlPayload(null)).toBe(false);
  });

  it('validates ids', () => {
    expect(v.validateId('abc')).toBe(true);
    expect(v.validateId('')).toBe(false);
    expect(v.validateId(42)).toBe(false);
  });
});
```

- [ ] **Step 5：跑测试 + 启动验证。**

```
npm test
npm start
```

期望全部 OK。功能层面无可见变化。

- [ ] **Step 6：commit。**

```
git add main/ipc-validators.js tests/ipc-validators.test.js main.js
git commit -m "feat: validate IPC inputs at every handler entry (B2)"
```

---

### PR6 / Task 17：renderer 模块拆分（一次性大动作）

**Files：**
- Create: `renderer/state.js`、`renderer/dom.js`、`renderer/bilibili.js`、`renderer/webview-bridge.js`、`renderer/sidebar.js`、`renderer/settings.js`、`renderer/actions.js`、`renderer/bootstrap.js`
- Modify: `index.html`（只保留 DOM + `<script>` 顺序加载）

**Why：** `index.html` 当前 1917 行中约 1230 行是 `<script>`。一次性拆完，之后 PR7+ 都直接编辑独立文件。

> **方法论：每抽一个文件，跑一次 `npm start` 验证应用仍正常**。如果中途坏掉立刻回滚到上一个工作点。

- [ ] **Step 1：创建 `renderer/state.js`。**

```js
'use strict';

window.AmiyaState = (function () {
  const LAYOUT_FOCUS = 'focus';
  const LAYOUT_SELECT = 'select';
  const DEFAULT_HOME = 'https://www.bilibili.com';
  const RECORD_DEDUPE_MS = 500;

  const state = {
    settings: {},
    history: [],
    favorites: [],
    tabs: [],
    isAlwaysOnTop: true,
    isClickThrough: false
  };

  const ui = {
    currentSection: 'tabs',
    currentUrl: 'about:blank',
    currentTitle: '空白页',
    insertedCssKey: null,
    webviewReady: false,
    sidebarCollapsed: false,
    cleanMode: false,
    playbackMode: false,
    pendingRecord: null,
    lastRecordedAt: 0
  };

  return {
    LAYOUT_FOCUS, LAYOUT_SELECT, DEFAULT_HOME, RECORD_DEDUPE_MS,
    state, ui
  };
})();
```

- [ ] **Step 2：创建 `renderer/dom.js`（DOM 引用 + showStatus）。**

```js
'use strict';

window.AmiyaDom = (function () {
  const refs = {};
  let statusTimer = null;

  function bind() {
    refs.appEl = document.getElementById('app');
    refs.input = document.getElementById('url-input');
    refs.goBtn = document.getElementById('go-btn');
    refs.toolbarEl = document.getElementById('toolbar');
    refs.webview = document.getElementById('video-frame');
    refs.statusStrip = document.getElementById('status-strip');
    refs.statusText = document.getElementById('status-text');
    refs.statusDot = document.querySelector('.status-dot');
    refs.sidebarList = document.getElementById('sidebar-list');
    refs.sidebarSearch = document.getElementById('sidebar-search');
    refs.settingsDrawer = document.getElementById('settings-drawer');
    refs.opacitySlider = document.getElementById('opacity-slider');
    refs.opacityValue = document.getElementById('opacity-value');
    refs.themeColor = document.getElementById('theme-color');
    refs.sidebarWidth = document.getElementById('sidebar-width');
    refs.topbarPlayback = document.getElementById('topbar-playback');
    refs.restoreLastTabs = document.getElementById('restore-last-tabs');
    refs.openLastUrl = document.getElementById('open-last-url');
    refs.homeUrl = document.getElementById('home-url');
    refs.toolbarEditor = document.getElementById('toolbar-editor');
    refs.shortcutMessage = document.getElementById('shortcut-message');
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[char]));
  }

  function showStatus(message, type, sticky) {
    clearTimeout(statusTimer);
    refs.statusText.textContent = message;
    refs.statusDot.classList.toggle('error', type === 'error');
    refs.statusStrip.classList.add('visible');
    if (!sticky) {
      statusTimer = setTimeout(() => refs.statusStrip.classList.remove('visible'), 2600);
    }
  }

  return { bind, refs, escapeHtml, showStatus };
})();
```

- [ ] **Step 3：创建 `renderer/bilibili.js`（搬运 `BILIBILI_RULE` + `BILIBILI_LAYOUT_HELPER` + `applyLayoutMode` + `currentPageMatchesBilibili`）。**

由于此块约 460 行（CSS 字符串），直接从 `index.html` 复制 `const BILIBILI_RULE = { ... };` 到 `function applyLayoutMode(...)` 整段，外层包成 IIFE 暴露到 `window.AmiyaBilibili`：

```js
'use strict';

window.AmiyaBilibili = (function () {
  const { state, ui, LAYOUT_FOCUS, LAYOUT_SELECT } = window.AmiyaState;
  const { refs, showStatus } = window.AmiyaDom;

  const BILIBILI_RULE = { /* ...完整复制原 index.html 中的 BILIBILI_RULE 对象... */ };
  const BILIBILI_LAYOUT_HELPER = `...`; // 完整复制

  function currentPageMatchesBilibili() {
    return /^https:\/\/www\.bilibili\.com\/(video|list|bangumi\/play|medialist\/play|cheese\/play)\//i.test(ui.currentUrl);
  }

  async function applyLayoutMode(mode, attempt) {
    mode = mode || state.settings.layoutMode;
    attempt = attempt || 0;

    if (!ui.webviewReady || !currentPageMatchesBilibili()) {
      return;
    }

    try {
      if (ui.insertedCssKey) {
        await refs.webview.removeInsertedCSS(ui.insertedCssKey);
      }
    } catch (_error) {
      // 页面跳转后旧的 CSS key 可能失效，忽略。
    }

    try {
      ui.insertedCssKey = await refs.webview.insertCSS(BILIBILI_RULE.modes[mode] || BILIBILI_RULE.modes.focus);
      const layoutState = await refs.webview.executeJavaScript(
        BILIBILI_LAYOUT_HELPER.replace('__AMIYA_MODE__', JSON.stringify(mode)),
        true
      );
      if (!layoutState.hasPlayer && attempt < 4) {
        setTimeout(() => applyLayoutMode(mode, attempt + 1), 700);
      } else if (!layoutState.hasPlayer) {
        showStatus('B 站页面结构未识别，已保留原页面', 'error');
      } else if (mode === LAYOUT_SELECT && !layoutState.hasPlaylist) {
        showStatus('选集模式已应用，但未找到选集列表', 'error');
      } else {
        showStatus(mode === LAYOUT_SELECT ? '选集模式已应用' : '纯净模式已应用');
      }
    } catch (_error) {
      ui.insertedCssKey = null;
      if (attempt < 4) {
        setTimeout(() => applyLayoutMode(mode, attempt + 1), 700);
      } else {
        showStatus('页面样式注入失败，已保留原页面', 'error');
      }
    }
  }

  function toggleLayoutMode() {
    const nextMode = state.settings.layoutMode === LAYOUT_SELECT ? LAYOUT_FOCUS : LAYOUT_SELECT;
    window.amiyaAPI.updateSettings({ layoutMode: nextMode }).then(() => applyLayoutMode(nextMode));
  }

  return { applyLayoutMode, toggleLayoutMode, currentPageMatchesBilibili };
})();
```

> **注：** `BILIBILI_RULE.modes.focus` / `BILIBILI_RULE.modes.select` 两个长 CSS 字符串和 `BILIBILI_LAYOUT_HELPER` 字符串需要 1:1 从原 `index.html` 复制过来，不要重写。

- [ ] **Step 4：创建 `renderer/webview-bridge.js`（搬运 `installWebviewLinkFallback` + `openUrlFromWebview`）。**

```js
'use strict';

window.AmiyaWebviewBridge = (function () {
  const { refs } = window.AmiyaDom;

  function installWebviewLinkFallback() {
    if (!refs.webview.getWebContentsId()) {
      return;
    }
    const script = `
      /* ...完整复制 index.html 原 installWebviewLinkFallback 中的 script 字符串... */
    `;
    refs.webview.executeJavaScript(script, true).catch(() => {});
  }

  function openUrlFromWebview(url) {
    return url;
  }

  return { installWebviewLinkFallback, openUrlFromWebview };
})();
```

- [ ] **Step 5：创建 `renderer/sidebar.js`、`renderer/settings.js`、`renderer/actions.js`。**

按 `index.html` 中的对应函数划分：
- `sidebar.js`：`renderSidebar` / `getSectionItems` / `saveCurrentTab` / `recordVisit` / `favoriteCurrentPage` / `clearCurrentSiteData` / `clearAllWebData`
- `settings.js`：`applyVisualSettings` / `updateOpacityUI` / `renderToolbar` / `renderToolbarEditor` / `validateToolbarShortcuts` / `updateSettings` / `updateToolbarButton` / `moveToolbarButton` / `isActionActive`
- `actions.js`：`runAction` / `openUrl` / `loadFromInput` / `controlVideo` / `handleNavigation` / `updateChromeState` / `sortedToolbar`

> 每个模块外层 IIFE 暴露到 `window.AmiyaSidebar` / `window.AmiyaSettings` / `window.AmiyaActions`。

由于每个模块 80–200 行，逐个粘贴并把原来的 `state.x` 改为 `window.AmiyaState.state.x`，把对其他模块函数的调用加上命名空间前缀（如 `renderSidebar()` → `window.AmiyaSidebar.renderSidebar()`）。

**这一步的关键是仔细。建议每抽出一个模块都跑一次 `npm start` 验证。**

- [ ] **Step 6：创建 `renderer/bootstrap.js`（搬运 `bindEvents` + `init`）。**

```js
'use strict';

(function () {
  const { state, ui, DEFAULT_HOME } = window.AmiyaState;
  const { refs, bind } = window.AmiyaDom;
  const api = window.amiyaAPI;

  function bindEvents() {
    /* ...完整复制原 bindEvents 内容，把 ipcRenderer 调用替换成 api，把跨模块函数调用加上命名空间... */
  }

  async function init() {
    bind();
    Object.assign(state, await api.getAppState());
    ui.currentUrl = state.settings.lastUrl || 'about:blank';
    ui.currentTitle = ui.currentUrl;
    bindEvents();
    window.AmiyaSettings.applyVisualSettings();
    window.AmiyaSidebar.renderSidebar();
    window.AmiyaSettings.renderToolbar();
    window.AmiyaSettings.renderToolbarEditor();
    window.AmiyaActions.updateChromeState();

    if (state.settings.openLastUrl !== false && state.settings.lastUrl) {
      window.AmiyaActions.openUrl(state.settings.lastUrl);
    } else {
      refs.input.value = '';
    }
  }

  init();
})();
```

- [ ] **Step 7：重写 `index.html` 末尾。**

把原 `<script>...</script>`（约 689–1916 行）整段删掉，替换为：

```html
<script src="lib/normalize-url.js"></script>
<script src="lib/toolbar-order.js"></script>
<script src="renderer/state.js"></script>
<script src="renderer/dom.js"></script>
<script src="renderer/bilibili.js"></script>
<script src="renderer/webview-bridge.js"></script>
<script src="renderer/sidebar.js"></script>
<script src="renderer/settings.js"></script>
<script src="renderer/actions.js"></script>
<script src="renderer/bootstrap.js"></script>
```

- [ ] **Step 8：CSP 收紧到目标态。**

renderer JS 已完全外链，可以去掉 `script-src` 的 `'unsafe-inline'`。把 `index.html` 的 CSP meta 改为：

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self';">
```

- [ ] **Step 9：跑全套验证。**

```
npm run lint
npm test
npm start
```

启动后**完整回归**：
- 地址栏打开 B 站 → focus 模式生效
- F4 切换选集模式 → playlist 出现
- F8 穿透切换正常
- 设置抽屉：透明度、主题色、侧栏宽度、工具栏编辑器全部能改
- 侧栏：tabs / history / favorites 切换、搜索、删除
- 关闭重开 → lastUrl 自动加载

**如果有任何一项坏掉，回退到 PR5 末尾状态再分批拆。** 不要硬调。

- [ ] **Step 10：commit。**

```
git add renderer/ index.html
git commit -m "refactor: split renderer into focused modules (Phase C complete)"
```

---

> **Wave 2 完成节点。** 此时仓库状态：
> - 主窗口 `nodeIntegration:false / contextIsolation:true`
> - `main.js` 从 711 行降到 ~400 行
> - `index.html` 从 1917 行降到 ~150 行
> - renderer/ 8 个文件，每个 < 250 行
> - 6 个测试文件，~35 个 it 全绿
>
> 建议打 tag `v1.1.0-wave2`。

---

## Wave 3 · UX 补漏 + Electron 升级

### PR7 / Task 18：A4 上限放大

**Files：**
- Modify: `lib/normalize-items.js`（新增导出常量）
- Modify: `main.js`（用新常量替换 `MAX_SAVED_ITEMS`）
- Modify: `renderer/sidebar.js`（搜索结果不再 slice 10）

- [ ] **Step 1：在 `lib/normalize-items.js` 末尾导出常量。**

修改 `module.exports`：

```js
const LIMITS = {
  MAX_HISTORY: 200,
  MAX_FAVORITES: 50,
  MAX_TABS: 50,
  SIDEBAR_RENDER_LIMIT: 100
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createId, normalizeItems, LIMITS };
} else if (typeof window !== 'undefined') {
  window.AmiyaItems = { LIMITS };
}
```

> 注意：`normalizeItems` 主要给 main 用，所以 renderer 端只暴露 LIMITS。

- [ ] **Step 2：修改 `main.js`。**

把 `const MAX_SAVED_ITEMS = 10;`（约第 13 行）删除。在 require 行替换为：

```js
const { createId, normalizeItems, LIMITS } = require('./lib/normalize-items');
```

把所有 `MAX_SAVED_ITEMS` 引用替换：
- `loadAllData` 中 `historyItems = normalizeItems(loadJson(DATA_FILES.history, []), MAX_SAVED_ITEMS);` → `LIMITS.MAX_HISTORY`
- `favorites = ...` → `LIMITS.MAX_FAVORITES`
- `tabs = ...` → `LIMITS.MAX_TABS`
- `record-history` IPC 中 `historyItems = historyItems.slice(0, MAX_SAVED_ITEMS);` → `LIMITS.MAX_HISTORY`
- `add-favorite` IPC 中 `favorites = favorites.slice(0, MAX_SAVED_ITEMS);` → `LIMITS.MAX_FAVORITES`
- `save-tabs` IPC 中 `normalizeItems(nextTabs, MAX_SAVED_ITEMS)` → `LIMITS.MAX_TABS`

- [ ] **Step 3：在 `index.html` 顶部加 `<script src="lib/normalize-items.js">`。**

放在 `<script src="lib/normalize-url.js"></script>` 之后。

- [ ] **Step 4：修改 `renderer/sidebar.js`。**

找到 `renderSidebar` 中：

```js
}).slice(0, 10);
```

替换为：

```js
}).slice(0, window.AmiyaItems.LIMITS.SIDEBAR_RENDER_LIMIT);
```

把 `saveCurrentTab` 中 `.slice(0, 10)` 替换为 `.slice(0, window.AmiyaItems.LIMITS.MAX_TABS)`。

- [ ] **Step 5：启动验证。**

```
npm start
```

访问 20 个不同的页面 → 切换到"历史"侧栏 → 期望看到 20 条记录（之前只会留 10 条）。

- [ ] **Step 6：commit。**

```
git add lib/normalize-items.js main.js index.html renderer/sidebar.js
git commit -m "feat: raise history/favorites/tabs caps (A4)"
```

---

### PR7 / Task 19：A5 应急 UI 锚点

**Files：**
- Modify: `main.js`（处理 `set-positional-click-through` IPC + 切换 forward 模式）
- Modify: `preload.js`（已在 PR5 暴露 `setPositionalClickThrough`，OK）
- Modify: `renderer/styles.css`（新增锚点样式）
- Modify: `index.html`（新增锚点 DOM）
- Modify: `renderer/actions.js`（mousemove 监听 + 临时关闭穿透 + 锚点点击）

**Why：** Spec §4 A5。click-through 状态下没有视觉化的恢复入口。

- [ ] **Step 1：在 `main.js` 的 `setClickThrough` 中改为 forward 模式。**

```js
function setClickThrough(nextValue) {
  isClickThrough = Boolean(nextValue);
  if (!win || win.isDestroyed()) {
    return;
  }
  win.setFocusable(!isClickThrough);
  win.setIgnoreMouseEvents(isClickThrough, { forward: isClickThrough });
  queueNativeClickThrough(win, isClickThrough);
  if (isClickThrough) { win.blur(); } else { win.focus(); }
  applyOpacity();
  win.webContents.send('toggle-ui', !isClickThrough);
  sendStatePatch({ isClickThrough });
}
```

- [ ] **Step 2：新增 `set-positional-click-through` IPC（临时关穿透）。**

在 `main.js` IPC 区追加：

```js
ipcMain.handle('set-positional-click-through', (_event, payload) => {
  if (!win || win.isDestroyed() || !isClickThrough) {
    return false;
  }
  const inAnchor = payload && payload.inAnchor === true;
  win.setIgnoreMouseEvents(!inAnchor, { forward: !inAnchor });
  return true;
});
```

- [ ] **Step 3：在 `renderer/styles.css` 末尾新增锚点样式。**

```css
#emergency-anchor {
  position: fixed;
  right: 4px;
  bottom: 4px;
  width: 24px;
  height: 24px;
  display: none;
  place-items: center;
  border-radius: 6px;
  background: rgba(214, 59, 59, 0.85);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  z-index: 10000;
  user-select: none;
  pointer-events: auto;
}

#app.click-through #emergency-anchor {
  display: grid;
}

#emergency-anchor:hover {
  background: rgba(214, 59, 59, 1);
}

#emergency-top-strip {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  height: 6px;
  display: none;
  z-index: 9999;
  pointer-events: auto;
}

#app.click-through #emergency-top-strip {
  display: block;
}

#emergency-top-strip:hover {
  height: 36px;
  background: rgba(0, 161, 214, 0.4);
}
```

- [ ] **Step 4：在 `index.html` 的 `<div id="app">` 内部、`</div>` 闭合之前新增：**

```html
<div id="emergency-top-strip" title="点击恢复 UI"></div>
<div id="emergency-anchor" title="退出鼠标穿透">⊘</div>
```

- [ ] **Step 5：在 `renderer/dom.js` 的 `bind()` 函数末尾追加：**

```js
refs.emergencyAnchor = document.getElementById('emergency-anchor');
refs.emergencyTopStrip = document.getElementById('emergency-top-strip');
```

- [ ] **Step 6：在 `renderer/actions.js` 中新增锚点 + mousemove 逻辑。**

```js
function bindEmergencyAnchor() {
  const { refs } = window.AmiyaDom;
  const api = window.amiyaAPI;

  refs.emergencyAnchor.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.AmiyaState.state.isClickThrough = await api.toggleClickThrough();
    window.AmiyaActions.updateChromeState();
  });

  refs.emergencyTopStrip.addEventListener('click', async () => {
    if (window.AmiyaState.ui.cleanMode) {
      window.AmiyaState.ui.cleanMode = false;
      window.AmiyaActions.updateChromeState();
    }
  });

  let lastInAnchor = false;
  document.addEventListener('mousemove', (event) => {
    if (!window.AmiyaState.state.isClickThrough) {
      return;
    }
    const x = event.clientX;
    const y = event.clientY;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const inTopStrip = y <= 6;
    const inAnchor = x >= w - 32 && y >= h - 32;
    const inAny = inTopStrip || inAnchor;
    if (inAny !== lastInAnchor) {
      lastInAnchor = inAny;
      api.setPositionalClickThrough({ inAnchor: inAny });
    }
  });
}
```

把 `bindEmergencyAnchor()` 在 `bootstrap.js` 的 `bindEvents` 末尾调用。

- [ ] **Step 7：本地验证。**

```
npm start
```

按 F8 进入穿透 → 把鼠标移到窗口右下角 → 期望红色 ⊘ 锚点亮起并可点击 → 点击后退出穿透。再按 F8 → 鼠标移到窗口顶部 → 蓝色触发条可见。

- [ ] **Step 8：commit。**

```
git add main.js renderer/styles.css index.html renderer/dom.js renderer/actions.js
git commit -m "feat: emergency UI anchors under click-through (A5)"
```

---

### PR8 / Task 20：B3 Electron 28 → 33 升级

**Files：**
- Modify: `package.json`

- [ ] **Step 1：升级依赖。**

```
npm install --save-dev electron@33 electron-builder@latest
```

- [ ] **Step 2：检查 `package.json` 锁定版本。**

确认 `devDependencies` 大致为：

```json
"electron": "^33.0.0",
"electron-builder": "^25.0.0"
```

- [ ] **Step 3：清依赖重装跑冒烟。**

```
npm ci
npm start
```

启动验证：
- B 站视频页能播
- F8 穿透
- 设置抽屉
- 透明度滑块
- 关闭重开

**如果启动报错**，根据具体错误回退或调整。常见点：`webview` 的 `webpreferences` 字符串格式在 33 中略变（`contextIsolation=yes` 仍兼容）。

- [ ] **Step 4：跑 `build-portable.bat` 验证打包。**

```
build-portable.bat
```

期望 `dist/` 下生成 exe。双击启动 → 走一遍冒烟。

- [ ] **Step 5：commit。**

```
git add package.json package-lock.json
git commit -m "chore: bump Electron 28 -> 33 + electron-builder (B3)"
```

---

### PR8 / Task 21：B4 P2P 拦截正则化 + 测试

**Files：**
- Create: `main/p2p-filter.js`
- Create: `tests/p2p-filter.test.js`
- Modify: `main.js`

- [ ] **Step 1：创建 `main/p2p-filter.js`。**

```js
'use strict';

const BLOCK_PATTERNS = [
  /\/p2p\//i,
  /p2p\./i,
  /-p2p/i,
  /webrtc/i,
  /\/stun/i,
  /\/turn/i
];

const TARGET_RESOURCE_TYPES = new Set(['script', 'xhr', 'fetch', 'websocket']);

function shouldBlockP2P(url, resourceType) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  if (!TARGET_RESOURCE_TYPES.has(resourceType)) {
    return false;
  }
  return BLOCK_PATTERNS.some((pattern) => pattern.test(url));
}

module.exports = { shouldBlockP2P };
```

- [ ] **Step 2：写测试 `tests/p2p-filter.test.js`。**

```js
const { describe, it, expect } = require('vitest');
const { shouldBlockP2P } = require('../main/p2p-filter');

describe('shouldBlockP2P', () => {
  it('blocks p2p paths', () => {
    expect(shouldBlockP2P('https://a.com/p2p/abc', 'xhr')).toBe(true);
  });

  it('blocks p2p subdomains', () => {
    expect(shouldBlockP2P('https://p2p.bili.com/x', 'fetch')).toBe(true);
  });

  it('blocks webrtc/stun/turn', () => {
    expect(shouldBlockP2P('https://x.com/webrtc-client.js', 'script')).toBe(true);
    expect(shouldBlockP2P('https://x.com/stun/server', 'fetch')).toBe(true);
    expect(shouldBlockP2P('wss://x.com/turn', 'websocket')).toBe(true);
  });

  it('allows normal video resources', () => {
    expect(shouldBlockP2P('https://upos.bilibili.com/video.m4s', 'xhr')).toBe(false);
    expect(shouldBlockP2P('https://api.bilibili.com/x/web', 'fetch')).toBe(false);
  });

  it('does not block non-target resource types', () => {
    expect(shouldBlockP2P('https://x.com/webrtc.js', 'image')).toBe(false);
    expect(shouldBlockP2P('https://x.com/p2p/x', 'stylesheet')).toBe(false);
  });

  it('handles bad input gracefully', () => {
    expect(shouldBlockP2P(null, 'xhr')).toBe(false);
    expect(shouldBlockP2P('', 'xhr')).toBe(false);
    expect(shouldBlockP2P(42, 'xhr')).toBe(false);
  });
});
```

- [ ] **Step 3：在 `main.js` 中接入。**

把 `configureWebSession` 中的 `onBeforeRequest` 回调替换为：

```js
const { shouldBlockP2P } = require('./main/p2p-filter');

// ...在 configureWebSession 内：
webSession.webRequest.onBeforeRequest((details, callback) => {
  callback({ cancel: shouldBlockP2P(details.url, details.resourceType) });
});
```

- [ ] **Step 4：跑测试 + 启动。**

```
npm test
npm start
```

打开 B 站视频 → DevTools Network → 不应看到 p2p / webrtc 相关请求成功；视频仍能播。

- [ ] **Step 5：commit。**

```
git add main/p2p-filter.js tests/p2p-filter.test.js main.js
git commit -m "refactor: extract P2P filter with explicit regex + tests (B4)"
```

---

### PR8 / Task 22：B6 webview-preload 版本化防重入

**Files：**
- Modify: `webview-preload.js`
- Modify: `package.json`（无新版本，仅参考）

- [ ] **Step 1：修改 `webview-preload.js` 顶部。**

把整个外层 IIFE 包裹改为：

```js
(() => {
  const EXPECTED_VERSION = '2026-05-15-1';

  if (window.__amiyaplayerPreloadVersion === EXPECTED_VERSION) {
    return;
  }
  window.__amiyaplayerPreloadVersion = EXPECTED_VERSION;

  /* ...原 IIFE 内容保持不变... */
})();
```

- [ ] **Step 2：本地验证。**

```
npm start
```

访问 B 站 → DevTools console 不应有重复注入提示；视频能播；登录态保留。

- [ ] **Step 3：commit。**

```
git add webview-preload.js
git commit -m "fix: version-guarded webview preload injection (B6)"
```

---

> **Wave 3 完成节点。** 标签 `v1.2.0-wave3`。

---

## Wave 4 · 新功能 + CI

### PR9 / Task 23：D1 托盘 + Boss Key

**Files：**
- Create: `main/tray.js`
- Modify: `main.js`
- Modify: `lib/normalize-settings.js`（新增 `closeBehavior` 默认值 + `bossKey` 默认值）
- Modify: `preload.js`（暴露 boss key 触发 IPC）
- Modify: `renderer/settings.js`（设置 UI 新增 closeBehavior 与 bossKey 选项）

- [ ] **Step 1：扩展 `DEFAULT_SETTINGS`。**

修改 `lib/normalize-settings.js` 中 `DEFAULT_SETTINGS`：

```js
const DEFAULT_SETTINGS = {
  schemaVersion: 3,
  opacity: 0.9,
  themeColor: '#00a1d6',
  sidebarWidth: 240,
  showTopBarInPlayback: true,
  restoreLastTabs: true,
  openLastUrl: true,
  homeUrl: 'https://www.bilibili.com',
  lastUrl: '',
  layoutMode: 'focus',
  closeBehavior: 'tray',
  bossKey: 'Ctrl+Alt+H',
  toolbar: DEFAULT_TOOLBAR
};
```

在 `normalizeSettings` 函数返回对象中追加：

```js
closeBehavior: ['tray', 'quit'].includes(loaded.closeBehavior) ? loaded.closeBehavior : DEFAULT_SETTINGS.closeBehavior,
bossKey: typeof loaded.bossKey === 'string' && loaded.bossKey.trim() ? loaded.bossKey.trim().slice(0, 32) : DEFAULT_SETTINGS.bossKey,
```

- [ ] **Step 2：创建 `main/tray.js`。**

```js
'use strict';

const { Tray, Menu, app, globalShortcut } = require('electron');
const path = require('path');

let tray = null;
let bossKeyAccelerator = null;

function buildMenu(win, { isAlwaysOnTop }) {
  return Menu.buildFromTemplate([
    {
      label: '显示 / 隐藏',
      click: () => {
        if (!win) { return; }
        if (win.isVisible()) { win.hide(); } else { win.show(); }
      }
    },
    {
      label: `置顶（${isAlwaysOnTop ? '开' : '关'}）`,
      click: () => {
        if (!win) { return; }
        win.setAlwaysOnTop(!win.isAlwaysOnTop(), 'screen-saver');
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      }
    }
  ]);
}

function createTray(win, getState) {
  if (tray) { return tray; }
  tray = new Tray(path.join(__dirname, '..', 'icon.ico'));
  tray.setToolTip('AmiyaPlayer');
  tray.on('click', () => {
    if (!win) { return; }
    if (win.isVisible()) { win.hide(); } else { win.show(); }
  });
  refreshMenu(win, getState);
  return tray;
}

function refreshMenu(win, getState) {
  if (!tray) { return; }
  tray.setContextMenu(buildMenu(win, getState()));
}

function bindBossKey(accelerator, win) {
  if (bossKeyAccelerator && bossKeyAccelerator !== accelerator) {
    try { globalShortcut.unregister(bossKeyAccelerator); } catch (_e) {}
    bossKeyAccelerator = null;
  }
  if (!accelerator || bossKeyAccelerator === accelerator) { return; }
  try {
    const ok = globalShortcut.register(accelerator, () => {
      if (!win || win.isDestroyed()) { return; }
      if (win.isVisible()) { win.hide(); } else { win.show(); }
    });
    if (ok) {
      bossKeyAccelerator = accelerator;
    }
  } catch (_e) {
    // 非法 accelerator 静默忽略
  }
}

module.exports = { createTray, refreshMenu, bindBossKey };
```

- [ ] **Step 3：在 `main.js` 中初始化托盘和 boss key。**

`app.whenReady().then(...)` 改为：

```js
const tray = require('./main/tray');

app.whenReady().then(() => {
  loadAllData();
  configureWebSession();
  createWindow();
  tray.createTray(win, () => ({ isAlwaysOnTop }));
  tray.bindBossKey(settings.bossKey, win);
});
```

`update-settings` IPC 末尾追加：

```js
tray.bindBossKey(settings.bossKey, win);
tray.refreshMenu(win, () => ({ isAlwaysOnTop }));
```

修改 `window-control` `close` 分支：

```js
} else if (command === 'close') {
  if (settings.closeBehavior === 'tray') {
    win.hide();
  } else {
    win.close();
  }
}
```

- [ ] **Step 4：设置 UI 中加入选项（`renderer/settings.js` + `index.html`）。**

在 `index.html` 的设置抽屉"启动"分段下方新增"窗口"分段：

```html
<div class="settings-section">
  <h2>窗口</h2>
  <div class="field">
    <label for="close-behavior">关闭按钮行为</label>
    <select id="close-behavior">
      <option value="tray">隐藏到托盘</option>
      <option value="quit">真正退出</option>
    </select>
  </div>
  <div class="field">
    <label for="boss-key">Boss Key</label>
    <input id="boss-key" type="text" placeholder="Ctrl+Alt+H">
  </div>
</div>
```

`renderer/dom.js` 的 `bind()` 追加：

```js
refs.closeBehavior = document.getElementById('close-behavior');
refs.bossKey = document.getElementById('boss-key');
```

`renderer/settings.js` 的 `applyVisualSettings` 末尾追加：

```js
refs.closeBehavior.value = state.settings.closeBehavior || 'tray';
refs.bossKey.value = state.settings.bossKey || 'Ctrl+Alt+H';
```

`renderer/bootstrap.js` 的 `bindEvents` 追加：

```js
refs.closeBehavior.addEventListener('change', () => {
  window.AmiyaSettings.updateSettings({ closeBehavior: refs.closeBehavior.value });
});
refs.bossKey.addEventListener('change', () => {
  window.AmiyaSettings.updateSettings({ bossKey: refs.bossKey.value.trim() });
});
```

- [ ] **Step 5：本地验证。**

```
npm start
```

- 任务栏托盘区应出现 AmiyaPlayer 图标 → 右键看到菜单
- 按 Ctrl+Alt+H → 窗口隐藏；再按 → 窗口显示
- 设置中改 closeBehavior 为 quit → 点关窗按钮直接退出

- [ ] **Step 6：commit。**

```
git add lib/normalize-settings.js main/tray.js main.js preload.js index.html renderer/dom.js renderer/settings.js renderer/bootstrap.js
git commit -m "feat: tray icon and boss key (D1)"
```

---

### PR10 / Task 24：D2 命令面板

**Files：**
- Create: `renderer/command-palette.js`
- Modify: `renderer/styles.css`
- Modify: `index.html`
- Modify: `renderer/bootstrap.js`（绑定 Ctrl+K）

- [ ] **Step 1：在 `renderer/styles.css` 末尾追加面板样式。**

```css
#command-palette {
  position: fixed;
  top: 80px;
  left: 50%;
  transform: translateX(-50%);
  width: min(480px, 92vw);
  max-height: 320px;
  display: none;
  flex-direction: column;
  background: rgba(20, 23, 28, 0.96);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
  z-index: 10001;
  overflow: hidden;
}

#command-palette.open {
  display: flex;
}

#command-palette-input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border: 0;
  border-bottom: 1px solid var(--line);
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 14px;
}

#command-palette-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.cp-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
}

.cp-item:hover,
.cp-item.active {
  background: rgba(255, 255, 255, 0.08);
}

.cp-item .cp-title {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cp-item .cp-kind {
  color: var(--muted);
  font-size: 11px;
}
```

- [ ] **Step 2：在 `index.html` 的 `<div id="app">` 内末尾新增：**

```html
<div id="command-palette" role="dialog" aria-label="命令面板">
  <input id="command-palette-input" type="text" placeholder="输入命令或关键字...">
  <div id="command-palette-list"></div>
</div>
```

- [ ] **Step 3：创建 `renderer/command-palette.js`。**

```js
'use strict';

window.AmiyaCommandPalette = (function () {
  const { state, ui } = window.AmiyaState;
  let activeIndex = 0;
  let currentItems = [];
  let inputEl = null;
  let listEl = null;
  let paletteEl = null;

  const ACTIONS = [
    { kind: 'action', action: 'nav.back', title: '后退' },
    { kind: 'action', action: 'nav.forward', title: '前进' },
    { kind: 'action', action: 'nav.refresh', title: '刷新当前页' },
    { kind: 'action', action: 'nav.home', title: '回到主页' },
    { kind: 'action', action: 'ui.toggleSidebar', title: '切换侧栏' },
    { kind: 'action', action: 'ui.toggleCleanMode', title: '切换纯净模式' },
    { kind: 'action', action: 'ui.togglePlaybackMode', title: '切换播放模式' },
    { kind: 'action', action: 'ui.openSettings', title: '打开设置' },
    { kind: 'action', action: 'window.toggleAlwaysOnTop', title: '切换置顶' },
    { kind: 'action', action: 'window.toggleClickThrough', title: '切换鼠标穿透' },
    { kind: 'action', action: 'bilibili.toggleMode', title: '切换 B 站布局（纯净 / 选集）' },
    { kind: 'action', action: 'video.togglePlay', title: '播放 / 暂停' },
    { kind: 'action', action: 'data.favoriteCurrent', title: '收藏当前页' },
    { kind: 'action', action: 'appearance.opacityDown', title: '降低透明度' },
    { kind: 'action', action: 'appearance.opacityUp', title: '提高透明度' }
  ];

  function getAllItems() {
    const items = [...ACTIONS];
    (state.tabs || []).forEach((tab) => items.push({ kind: 'tab', title: tab.title, url: tab.url }));
    (state.favorites || []).forEach((fav) => items.push({ kind: 'favorite', title: fav.title, url: fav.url }));
    (state.history || []).forEach((h) => items.push({ kind: 'history', title: h.title, url: h.url }));
    return items;
  }

  function score(item, query) {
    if (!query) { return 1; }
    const text = `${item.title || ''} ${item.url || ''} ${item.action || ''}`.toLowerCase();
    if (!text.includes(query)) { return 0; }
    const titlePos = (item.title || '').toLowerCase().indexOf(query);
    const titleHit = titlePos >= 0 ? 100 - titlePos : 0;
    const urlHit = (item.url || '').toLowerCase().includes(query) ? 30 : 0;
    return titleHit + urlHit + 1;
  }

  function filter(query) {
    const q = String(query || '').trim().toLowerCase();
    return getAllItems()
      .map((item) => ({ item, s: score(item, q) }))
      .filter((entry) => entry.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((entry) => entry.item);
  }

  function render() {
    listEl.innerHTML = '';
    currentItems.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'cp-item' + (index === activeIndex ? ' active' : '');
      el.innerHTML = `
        <div class="cp-title">${window.AmiyaDom.escapeHtml(item.title || item.url || item.action || '')}</div>
        <div class="cp-kind">${item.kind}</div>
      `;
      el.addEventListener('click', () => execute(item));
      listEl.appendChild(el);
    });
  }

  function execute(item) {
    close();
    if (item.kind === 'action') {
      window.AmiyaActions.runAction(item.action);
    } else if (item.url) {
      window.AmiyaActions.openUrl(item.url);
    }
  }

  function open() {
    paletteEl.classList.add('open');
    inputEl.value = '';
    activeIndex = 0;
    currentItems = filter('');
    render();
    inputEl.focus();
  }

  function close() {
    paletteEl.classList.remove('open');
  }

  function toggle() {
    if (paletteEl.classList.contains('open')) { close(); } else { open(); }
  }

  function bind() {
    paletteEl = document.getElementById('command-palette');
    inputEl = document.getElementById('command-palette-input');
    listEl = document.getElementById('command-palette-list');

    inputEl.addEventListener('input', () => {
      activeIndex = 0;
      currentItems = filter(inputEl.value);
      render();
    });

    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { close(); }
      else if (event.key === 'ArrowDown') {
        activeIndex = Math.min(currentItems.length - 1, activeIndex + 1);
        render();
        event.preventDefault();
      } else if (event.key === 'ArrowUp') {
        activeIndex = Math.max(0, activeIndex - 1);
        render();
        event.preventDefault();
      } else if (event.key === 'Enter') {
        const item = currentItems[activeIndex];
        if (item) { execute(item); }
        event.preventDefault();
      }
    });

    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        toggle();
      }
    });
  }

  return { bind, open, close, toggle };
})();
```

- [ ] **Step 4：在 `index.html` 中加 `<script src="renderer/command-palette.js">`。**

放在 `actions.js` 之后、`bootstrap.js` 之前。

- [ ] **Step 5：在 `renderer/bootstrap.js` 的 `init` 函数末尾调用：**

```js
window.AmiyaCommandPalette.bind();
```

- [ ] **Step 6：本地验证。**

```
npm start
```

按 Ctrl+K → 命令面板浮层弹出 → 输入 "穿透" → 候选含"切换鼠标穿透" → 回车 → F8 同等效果。

- [ ] **Step 7：commit。**

```
git add renderer/command-palette.js renderer/styles.css index.html renderer/bootstrap.js
git commit -m "feat: command palette (Ctrl+K) (D2)"
```

---

### PR11 / Task 25：D3 数据导入导出

**Files：**
- Modify: `main.js`（新增 `export-backup` / `import-backup` IPC）
- Modify: `preload.js`（已在 PR5 暴露）
- Modify: `index.html`（设置抽屉新增"数据备份"分段）
- Modify: `renderer/dom.js` / `renderer/bootstrap.js`

- [ ] **Step 1：在 `main.js` 顶部 require dialog。**

```js
const { dialog } = require('electron');
```

- [ ] **Step 2：新增导出 IPC。**

```js
ipcMain.handle('export-backup', async (_event, opts) => {
  const includeHistory = !!(opts && opts.includeHistory);
  const result = await dialog.showSaveDialog(win, {
    title: '导出 AmiyaPlayer 备份',
    defaultPath: `amiyaplayer-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) {
    return { success: false };
  }
  const payload = {
    schemaVersion: settings.schemaVersion || 3,
    exportedAt: new Date().toISOString(),
    settings,
    favorites,
    tabs,
    history: includeHistory ? historyItems : []
  };
  try {
    require('fs').writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { success: true, path: result.filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
});
```

- [ ] **Step 3：新增导入 IPC。**

```js
ipcMain.handle('import-backup', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '导入 AmiyaPlayer 备份',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths.length) {
    return { success: false, reason: 'cancelled' };
  }
  try {
    const raw = require('fs').readFileSync(result.filePaths[0], 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, reason: 'invalid' };
    }
    if (parsed.settings) {
      settings = normalizeSettings(parsed.settings);
      saveSettings();
    }
    if (Array.isArray(parsed.favorites)) {
      favorites = normalizeItems(parsed.favorites, LIMITS.MAX_FAVORITES);
      saveFavorites();
    }
    if (Array.isArray(parsed.tabs)) {
      tabs = normalizeItems(parsed.tabs, LIMITS.MAX_TABS);
      saveTabs();
    }
    if (Array.isArray(parsed.history)) {
      historyItems = normalizeItems(parsed.history, LIMITS.MAX_HISTORY);
      saveHistory();
    }
    registerShortcuts();
    applyOpacity();
    sendStatePatch(getAppState());
    return { success: true };
  } catch (error) {
    return { success: false, reason: 'parse_error', error: String(error) };
  }
});
```

- [ ] **Step 4：在 `preload.js` 中追加（如果 PR5 没暴露的话）：**

```js
exportBackup: (opts) => ipcRenderer.invoke('export-backup', opts),
importBackup: () => ipcRenderer.invoke('import-backup'),
```

（PR5 已暴露，此步骤是验证）

- [ ] **Step 5：在 `index.html` 设置抽屉中新增"数据备份"分段。**

放在"网页数据"分段之前：

```html
<div class="settings-section">
  <h2>数据备份</h2>
  <label class="check-row">
    <input id="export-include-history" type="checkbox">
    导出时包含历史记录
  </label>
  <button class="mini-btn" id="export-backup-btn">导出备份</button>
  <button class="mini-btn" id="import-backup-btn">导入备份</button>
</div>
```

- [ ] **Step 6：在 `renderer/dom.js` 的 `bind()` 中追加引用，在 `renderer/bootstrap.js` 的 `bindEvents` 中绑定。**

`dom.js`：

```js
refs.exportIncludeHistory = document.getElementById('export-include-history');
refs.exportBackupBtn = document.getElementById('export-backup-btn');
refs.importBackupBtn = document.getElementById('import-backup-btn');
```

`bootstrap.js`：

```js
refs.exportBackupBtn.addEventListener('click', async () => {
  const result = await api.exportBackup({ includeHistory: refs.exportIncludeHistory.checked });
  window.AmiyaDom.showStatus(result.success ? `已导出到 ${result.path}` : '导出已取消', result.success ? 'info' : 'error');
});

refs.importBackupBtn.addEventListener('click', async () => {
  if (!window.confirm('导入备份将覆盖当前设置 / 收藏 / 标签。是否继续？')) {
    return;
  }
  const result = await api.importBackup();
  if (result.success) {
    window.AmiyaDom.showStatus('备份已导入');
  } else if (result.reason !== 'cancelled') {
    window.AmiyaDom.showStatus(`导入失败：${result.reason || 'unknown'}`, 'error');
  }
});
```

- [ ] **Step 7：本地验证完整往返。**

```
npm start
```

- 设置 → 改透明度到 50%、改主题色为 #ff0000、收藏一个 URL
- 点击"导出备份"→ 选保存位置
- 改回原设置（透明度 90%、主题色蓝、删除收藏）
- 点击"导入备份"→ 选刚才的文件
- 期望：UI 立刻变回 50% 透明度 / 红主题色 / 收藏出现

- [ ] **Step 8：commit。**

```
git add main.js index.html renderer/dom.js renderer/bootstrap.js
git commit -m "feat: import / export backup (D3)"
```

---

### PR12 / Task 26：CI workflow + QA checklist

**Files：**
- Create: `.github/workflows/ci.yml`
- Create: `docs/QA-CHECKLIST.md`

- [ ] **Step 1：创建 `.github/workflows/ci.yml`。**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm test
```

- [ ] **Step 2：创建 `docs/QA-CHECKLIST.md`。**

```markdown
# AmiyaPlayer 手动回归清单

每次发版前按顺序过一遍，全部 ✅ 才可发。

## 基础启动
- [ ] `npm start` 启动无错误
- [ ] 窗口透明 + 默认置顶生效
- [ ] 关闭重开后 lastUrl 自动加载

## B 站布局
- [ ] 打开 `https://www.bilibili.com/video/<任一 BV>` → focus 模式生效
- [ ] 打开 `https://www.bilibili.com/bangumi/play/<任一 ep>` → focus 模式生效
- [ ] 按 F4 切换 select 模式 → 选集列表可见
- [ ] 切回 focus → 选集列表隐藏

## 穿透
- [ ] F8 进入穿透 → 鼠标点击穿透到下层窗口
- [ ] 鼠标进入右下角红色 ⊘ 锚点 → 锚点可点击 → 点击退出穿透
- [ ] 鼠标进入顶部边缘 → 蓝色触发条出现

## 透明度
- [ ] 拖动滑块 → 实时变化但 `userData/settings.json` mtime 不变
- [ ] 松手 1 秒后 → mtime 更新

## 数据
- [ ] 访问 5 个不同页面 → 历史侧栏看到 5 条
- [ ] 收藏当前页 → 收藏侧栏出现
- [ ] 搜索框输入关键字 → 过滤生效
- [ ] 导出备份到桌面 → 文件存在且为合法 JSON
- [ ] 改某项设置 → 导入备份 → 设置还原

## 新功能
- [ ] 任务栏托盘图标可见 → 右键菜单可用
- [ ] Ctrl+Alt+H 切换窗口显示 / 隐藏
- [ ] Ctrl+K 唤出命令面板 → 输入关键字模糊匹配 → 回车执行

## 打包
- [ ] `build-portable.bat` 无错误
- [ ] `dist/` 下生成 exe，双击启动成功
- [ ] 携带 exe 到另一台 Windows 机器启动正常
```

- [ ] **Step 3：commit。**

```
git add .github/workflows/ci.yml docs/QA-CHECKLIST.md
git commit -m "ci: add lint+test workflow and QA checklist"
```

- [ ] **Step 4：推送验证 CI（如有 origin）。**

```
git push
```

在 GitHub 上查看 Actions 标签，期望本次 push 触发的 workflow 通过。

---

> **Wave 4 完成节点。** 标签 `v1.3.0`。
>
> 此时所有 spec 内容已落地：
> - 7 个 bug 修复（A1–A7）
> - 安全 / 性能 6 项（B1–B6）
> - 架构重构（Phase C）完成，主窗口配置达推荐档
> - 3 项新功能（D1 托盘 + Boss Key、D2 命令面板、D3 导入导出）
> - CI 跑 lint + test、QA checklist 文档化

---

## 验收（Definition of Done）

按 spec §12，全部满足后可视为完成：

- [ ] Phase A 的 7 个 bug 在 `docs/QA-CHECKLIST.md` 全部通过
- [ ] 主窗口 `webPreferences.nodeIntegration === false && contextIsolation === true`（在 DevTools `process` 中 `process == null` 验证）
- [ ] `npm run lint && npm test && npm start` 全部通过
- [ ] Boss Key、命令面板、导入导出三个新功能各跑通一次手动用例
- [ ] `build-portable.bat` 输出的 exe 双击启动正常并通过最小冒烟（B 站视频 + focus 切换 + 关闭重开仍登录）
- [ ] `docs/QA-CHECKLIST.md` 与本计划一并提交
