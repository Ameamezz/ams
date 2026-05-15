# AmiyaPlayer 集中优化方案设计

- 日期：2026-05-15
- 范围：bug 修复 + 安全/性能加固 + 架构重构 + 三项新功能
- 目标：在保持"单 exe 可携带"和"看视频好用"两个核心价值的前提下，把当前一次性原型代码升级到可长期维护的状态。

## 1. 当前状态

仓库 `git log` 只有一次初始提交 `Initial AmiyaPlayer project`。代码组织如下：

- `main.js`（710 行）：主进程，混合了窗口创建、IPC、JSON 存储、全局快捷键、Win32 鼠标穿透、webview session 配置。
- `index.html`（1917 行）：DOM + 全部 CSS + 全部 renderer JS 内联。
- `webview-preload.js`（84 行）：注入到 webview，禁用 WebRTC / mediaDevices。
- `package.json`：Electron 28，零运行时依赖。
- 没有测试、Lint、CI。

功能上 Phase 1–6（UPGRADE_TASKS.md）已基本实现：浮窗 + B 站 focus/select 模式 + tabs/history/favorites + 设置抽屉 + 工具栏自定义 + 全局快捷键。

## 2. 设计目标 / 非目标

**目标**

- 修掉已识别的 7 个 bug。
- 主窗口达到推荐安全配置（`nodeIntegration: false`, `contextIsolation: true`）。
- 把 `index.html` / `main.js` 拆成可单文件理解的模块。
- 加最小限度的工程化：ESLint、Vitest、GitHub Actions。
- 增加 3 项高价值新功能：托盘 + Boss Key、命令面板、数据导入导出。

**非目标**

- 不引入构建工具（esbuild / Vite / TypeScript）。
- 不引入前端框架（React / Vue / Svelte）。
- 不做 E2E 测试、覆盖率门禁、视觉回归。
- 不重做 B 站布局规则（保留现有 CSS + helper 注入策略）。
- 不实现 UPGRADE_TASKS.md 中其他 nice-to-have（PiP、自动隐藏顶栏、按站点偏好、截图）。

## 3. 目标架构

```
amiyaplayer/
├── main/
│   ├── index.js                  app 生命周期 + createWindow
│   ├── storage.js                JSON 原子读写 + normalize/clamp/clone
│   ├── shortcuts.js              globalShortcut 注册 + 差异化更新
│   ├── native-click-through.js   Win32 透明窗口辅助
│   ├── session.js                persist:amiyaplayer + P2P/WebRTC 拦截
│   ├── chromium-flags.js         命令行开关 + 注释说明
│   └── ipc.js                    所有 ipcMain.handle 集中点
├── preload.js                    contextBridge 暴露 window.amiyaAPI
├── renderer/
│   ├── index.html                DOM 骨架 + <link>/<script>
│   ├── styles.css                全部 CSS
│   ├── state.js                  state 单例 + selectors
│   ├── dom.js                    DOM 引用 + showStatus 等 helper
│   ├── bilibili.js               layoutMode CSS + helper 注入
│   ├── webview-bridge.js         webview 链接拦截 / 搜索拦截脚本
│   ├── sidebar.js                tabs / history / favorites 渲染
│   ├── settings.js               设置抽屉 + 工具栏编辑器 + 导入导出
│   ├── command-palette.js        Ctrl+K 命令面板
│   ├── actions.js                runAction 路由表
│   └── bootstrap.js              init + bindEvents 入口
├── webview-preload.js            保留，由 session.js 注入到 webview
├── tests/
│   ├── normalize-settings.test.js
│   ├── normalize-items.test.js
│   ├── normalize-url.test.js
│   └── toolbar-order.test.js
├── .github/workflows/ci.yml
├── eslint.config.js
├── vitest.config.js
├── package.json
├── icon.ico
├── build-portable.bat
├── USER_MANUAL.md
└── UPGRADE_TASKS.md
```

**加载顺序约定**：renderer 端 `<script>` 顺序为 `state → dom → bilibili → webview-bridge → sidebar → settings → command-palette → actions → bootstrap`。不引入 ES module，依赖通过全局对象命名空间（如 `window.AmiyaState`、`window.AmiyaDom`）显式暴露。

**主窗口安全配置变更**：

| 配置 | 现状 | 目标 |
|---|---|---|
| `nodeIntegration` | true | false |
| `contextIsolation` | false | true |
| `sandbox` | (default false) | false（保留以让 preload 用 Node） |
| `webviewTag` | true | true（保留） |

**CSP 重写**（位于 `renderer/index.html`）：

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https: http:;
connect-src 'self';
```

去掉 `frame-src`（`<webview>` 不受 CSP frame-src 约束）。`script-src` 不再需要 `'unsafe-inline'`，因为 renderer JS 已外链。`style-src` 暂保留 `'unsafe-inline'`（B 站注入 CSS 字符串需要）。

## 4. Phase A — Bug 修复

| ID | 位置 | 问题 | 修法 |
|---|---|---|---|
| A1 | `main.js:304` | `$${enabled ? 'true' : 'false'}` 在模板字符串中产出字面 `$$true`/`$$false`，PowerShell 解析为错误，原生穿透实际未生效 | 改为通过 `-EncodedCommand` 传一个 `param([bool]$enabled, [int64]$handle)` 的脚本，bool 与 handle 从 `execFile` 参数列表传入而非字符串插值；同时捕获 stderr 写入 debug 日志（仅在 `process.env.AMIYAPLAYER_DEBUG` 开启时） |
| A2 | `index.html:1862` 与 `:1892` | `did-navigate` 与 `page-title-updated` 各触发一次 `recordVisit`，每次导航双写历史，且首次写入 title 为 url | 改为：`did-navigate` 仅更新 `currentUrl` + 内存中的 placeholder；`page-title-updated` 之后做实际写入；对相同 URL 做 500ms 内去重 |
| A3 | `index.html:1828` + `main.js:325` | 透明度滑块 `input` 事件每帧 IPC 且每次 `setOpacity` 都落盘 | renderer 端 debounce 150ms 才发 `set-opacity`；main 端把 `setOpacity` 拆成 `applyOpacity` 与 `persistOpacity`，IPC `set-opacity` 默认只 apply，新增 `commit-opacity` IPC 在 `change` 事件触发时落盘 |
| A4 | `index.html:1380` + `main.js:13` | `MAX_SAVED_ITEMS = 10` 同时限制了存储与渲染，搜索体验差 | 拆为：`MAX_HISTORY = 200`、`MAX_FAVORITES = 50`、`MAX_TABS = 50`、`SIDEBAR_RENDER_LIMIT = 100`。renderer 渲染时按 limit 截断；搜索时不再 slice 10 |
| A5 | UX | `clean-mode` / `click-through` 下所有窗口控件消失，新用户卡死 | 实现"鼠标位置感知的选择性穿透"：开启 click-through 时使用 `setIgnoreMouseEvents(true, { forward: true })`，renderer 监听 `mousemove`（forward 模式下事件仍送到 renderer），检测光标进入顶部 6px 触发条或右下角 24×24 应急锚点矩形时，通过 IPC 让主进程临时 `setIgnoreMouseEvents(false)`；离开后再切回 true。锚点上画一个半透明的 ⊘ 图标，点击 = 关闭穿透/clean mode |
| A6 | `index.html:5` | CSP 中 `frame-src` 对 `<webview>` 无效且包含 `'unsafe-inline'` | 替换为第 3 节给出的新 CSP |
| A7 | `main.js:572` | `update-settings` 每次都 `unregisterAll` + 全量重注册快捷键 | 在 `main.js` 内（PR1 阶段尚未拆模块）新增一个模块级 `registeredShortcuts: Map<string, string>`；`registerShortcuts` 改为：计算新旧 shortcut 列表差异，仅 `unregister` 差集、`register` 新增集。Phase C 把这套逻辑整体搬到 `main/shortcuts.js` |

## 5. Phase B — 安全 / 性能加固

- **B1 preload 桥**：新增 `preload.js`，通过 `contextBridge.exposeInMainWorld('amiyaAPI', { ... })` 暴露所有 renderer 需要的 IPC 方法；renderer 不再 `require('electron')`。
- **B2 IPC 输入校验**：每个 `ipcMain.handle` 入口加轻量校验函数（手写，不引 zod），不符合预期则返回当前状态而非崩溃；记录到 debug 日志。
- **B3 Electron 28 → 33**：`package.json` 升级 `electron` 与 `electron-builder`；验证 `webview.executeJavaScript`、`setIgnoreMouseEvents`、`session.fromPartition` 等核心 API 表现一致；本地跑 `build-portable.bat` 输出 exe 并冒烟启动。
- **B4 P2P 拦截正则化**：当前 `webRequest.onBeforeRequest` 内嵌字符串 `includes` 判断，改为模块化的正则数组并导出纯函数 `shouldBlockP2P(url, resourceType)`；为该函数加 `tests/p2p-filter.test.js`。
- **B5 chromium-flags 模块化**：把 `app.commandLine.appendSwitch(...)` 集合搬到 `main/chromium-flags.js`，每个开关旁注释为什么存在（防止后续误删后破坏穿透或导致 P2P 泄漏）。
- **B6 webview-preload 防重入**：注入脚本前检查 `window.__amiyaplayerPreloadVersion === EXPECTED_VERSION`，相同则跳过；不同则覆盖。EXPECTED_VERSION 与 `package.json` 同步。

## 6. Phase C — 架构重构

按第 3 节布局拆分。**每次只搬一个文件并保证 `npm start` 通过**。

建议顺序：

1. 抽 `renderer/styles.css`（搬运，无逻辑变化）。
2. 抽 `main/storage.js` + `main/native-click-through.js`（独立纯函数与 Win32 辅助）。
3. 抽 `main/session.js` + `main/chromium-flags.js`。
4. 新增 `preload.js`，主窗口切换到 `contextIsolation:true / nodeIntegration:false`，renderer 改用 `window.amiyaAPI`（Phase B1 在此落地）。
5. renderer 按 `state → dom → bilibili → webview-bridge → sidebar → settings → actions → bootstrap` 顺序拆。
6. 抽 `main/ipc.js` + `main/shortcuts.js`，`main/index.js` 收尾。

**`window.amiyaAPI` 接口设计**（preload.js）：

```js
contextBridge.exposeInMainWorld('amiyaAPI', {
  getAppState: () => ipcRenderer.invoke('get-app-state'),
  onStatePatch: (handler) => { ipcRenderer.on('app-state-updated', (_e, p) => handler(p)); },
  onRunAction: (handler) => { ipcRenderer.on('run-action', (_e, a) => handler(a)); },
  onToggleUI: (handler) => { ipcRenderer.on('toggle-ui', (_e, v) => handler(v)); },
  onOpenUrl: (handler) => { ipcRenderer.on('open-url-in-webview', (_e, u) => handler(u)); },
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
  exportBackup: (opts) => ipcRenderer.invoke('export-backup', opts),
  importBackup: () => ipcRenderer.invoke('import-backup'),
});
```

renderer 端 `path.join(__dirname, 'webview-preload.js')` 之类的 Node API 改由主进程通过 IPC 返回字符串路径或 `file://` URL。

## 7. Phase D — 新功能

### D1 托盘 + Boss Key

- 主进程 `app.whenReady()` 后 `new Tray(path.join(__dirname, 'icon.ico'))`。
- 托盘菜单：显示 / 隐藏、置顶切换、退出。
- 全局快捷键默认 `Ctrl+Alt+H`（设置中可改），按下时切换 `win.isVisible()`：隐藏前 `win.setTitle('')` 清空任务栏标题；显示时还原。
- 关窗按钮（`window-control: close`）默认改为"隐藏到托盘"；新增设置项 `closeBehavior: 'tray' | 'quit'`；按住 Shift 点关窗按钮无条件真退出。
- 设置项默认值在 `normalizeSettings` 中处理。

### D2 命令面板

- `renderer/command-palette.js`，全局监听 `Ctrl+K`。
- 浮层结构：居中 480×320，输入框 + 候选列表 + footer 提示。
- 候选源：
  - 内置 actions（`runAction` 全表 + 友好描述）
  - tabs / history / favorites 条目（标题 + URL）
  - 设置项跳转（打开设置抽屉 + 滚动到指定 section）
- 模糊匹配实现：`for...of` 顺序扫描，得分 = `title.toLowerCase().includes(q) * 100 + url.includes(q) * 30 + 子串位置加权`；不引入 fuzzy 库。
- 仅在主窗口焦点时触发（webview 内的 keydown 不冒泡到 host，自然不冲突）。

### D3 数据导入导出

- 主进程新增 IPC：
  - `export-backup({ includeHistory: boolean })`：用 `dialog.showSaveDialog` 选路径，写入 `{ schemaVersion, exportedAt, settings, favorites, tabs, history? }`。
  - `import-backup()`：`dialog.showOpenDialog` → 读 + 校验 schema → 二次确认（renderer 弹 `confirm`）→ 应用到内存 + 落盘 + 推 `app-state-updated`。
- 校验失败任何环节都不触动现有文件。
- 设置抽屉新增"数据"分段，含两个按钮 + 一个 "导出包含历史" 复选框。

## 8. 测试

**Vitest 单元测试**（覆盖纯函数）：

- `tests/normalize-settings.test.js`：opacity / sidebarWidth / themeColor / layoutMode / toolbar 的 normalize 边界。
- `tests/normalize-items.test.js`：history / favorites / tabs 的 normalize、上限截断、缺字段容错。
- `tests/normalize-url.test.js`：自动补 `https://`、`about:blank` 直通、空白容错。
- `tests/toolbar-order.test.js`：`moveToolbarButton` 上下移、删除态保留、order 重排。
- `tests/p2p-filter.test.js`（Phase B4 落地时新增）：`shouldBlockP2P` 对 P2P/WebRTC/STUN/TURN URL 的拦截与正常请求的放行。

**手动回归清单**（每次发版前执行，记入 `docs/QA-CHECKLIST.md`）：

- B 站视频页 / 列表页 / 番剧页 → focus / select 模式切换正常。
- 关闭重开 → 登录态保留、上次 URL 自动打开。
- F8 鼠标穿透 → 鼠标真的穿透（窗口下层应用能点）。
- 透明度滑块拖动 → 不卡顿，松手后才落盘（用户数据目录 mtime 验证）。
- Boss Key 隐藏 / 显示 → 不丢窗口位置。
- 命令面板 → 关键字模糊匹配能命中 tab / favorite / action。
- 导入导出 → 文件能往返一次还原全部状态。
- `build-portable.bat` 输出的 exe 双击启动正常。

**不做**：Playwright / Spectron E2E、覆盖率门禁、视觉回归。

## 9. CI

`.github/workflows/ci.yml`：

```yaml
on: [push, pull_request]
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run lint
      - run: npm test
```

不在 CI 中跑 electron-builder（成本高、对单 exe 应用价值低）。本地通过 `build-portable.bat` 触发。

## 10. 落地节奏

```
PR1  A1 + A2 + A3 + A7              4 个 main.js 范围内的 bug
PR2  A6 CSP + B5 chromium-flags 整理
PR3  ESLint + Vitest 接入 + tests/
PR4  C 阶段：抽 styles.css / storage.js / native-click-through.js
PR5  C 阶段：新增 preload.js + B1 切换安全配置 + B2 IPC 校验    ← 最大风险点
PR6  C 阶段：renderer 拆分
PR7  A4 上限放大 + A5 应急 UI 锚点
PR8  B3 Electron 28→33 + B4 P2P 正则 + B6 preload 防重入
PR9  D1 托盘 + Boss Key
PR10 D2 命令面板
PR11 D3 导入导出
PR12 CI workflow + docs/QA-CHECKLIST.md
```

每个 PR 限定在 1–4 小时改动量内，便于回滚。

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Electron 33 + `nodeIntegration:false` 后某些 IPC 拼错 | 启动黑屏 | PR5 单独提，本地完整手动回归后再合并 |
| native click-through 修复在不同 Windows 版本表现差 | A1 反而坏掉 | 保留 `setIgnoreMouseEvents` 兜底；PowerShell 调用 try/catch 不影响主流程 |
| 命令面板 `Ctrl+K` 与 B 站某些页面快捷键冲突 | 用户键入丢失 | 命令面板只在主窗口焦点时触发，webview 内不拦截 |
| 历史上限从 10 放大到 200 后 JSON 体积膨胀 | 启动 IO 慢 | 启动一次性 load；renderer 端按 `SIDEBAR_RENDER_LIMIT=100` 限制 DOM；后续若仍慢再考虑 SQLite |
| `style-src 'unsafe-inline'` 仍保留 | 仍是潜在 XSS 面 | 接受。B 站布局 CSS 字符串注入必须，且 webview 与主窗口隔离 |
| portable exe 在 Electron 升级后体积变化 | 用户感知 | 在 release notes 记录；不作为阻塞项 |

## 12. Definition of Done

- Phase A 的 7 个 bug 在手动回归清单上全部通过。
- 主窗口 `webPreferences` 满足 `nodeIntegration === false && contextIsolation === true`。
- `npm run lint && npm test && npm start` 全部通过。
- Boss Key、命令面板、导入导出三个新功能各跑通一次手动用例。
- `build-portable.bat` 输出的 exe 双击启动正常并通过最小冒烟（打开 B 站视频 + 切换 focus + 关闭重开仍登录）。
- `docs/QA-CHECKLIST.md` 与本 spec 一并提交。

## 13. 范围外（明确不做）

- PiP 紧凑模式、自动隐藏顶栏、按站点偏好、webview 截图：留待后续单独提案。
- 引入构建工具、TypeScript、前端框架。
- 替换 JSON 存储为 SQLite（除非 Phase A4 放大后实测启动 IO 不可接受）。
- Linux / macOS 支持（native click-through 是 Windows 专属，跨平台需单独设计）。
- 自动更新。
