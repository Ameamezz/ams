# AemeathTool

一个基于 Electron 的桌面半透明浮窗网页/视频播放器，专注于把 B 站等视频页面"贴"在桌面顶层观看。

## 核心特性

- **浮窗 + 置顶 + 透明度** 30%–100% 任意调节
- **鼠标穿透**（F8）：让点击穿透到下层应用，方便边看边工作
- **B 站布局增强**：纯净 / 选集两种模式，自动注入 CSS + 选集列表识别
- **持久登录**：使用独立 Chromium session 分区，账号在重启后保留
- **侧栏**：tabs / history / favorites，可搜索
- **工具栏可定制**：按钮显隐 / 改名 / 排序 / 绑定快捷键
- **隐私收紧**：禁用 WebRTC / mDNS，拦截 P2P/STUN/TURN，禁止屏幕捕获等敏感权限

## 快速开始

```powershell
npm install
npm start
```

构建 Windows 便携版：

```powershell
npm run build
```

产物输出到 `dist/AemeathTool <version>.exe`。

## 开发

```powershell
npm run lint   # ESLint 9 flat config
npm test       # Vitest 单元测试
```

测试覆盖 `lib/` 下的纯函数（settings 归一化、items 上限、URL 规范化、工具栏排序）。

## 文档

- [`USER_MANUAL.md`](USER_MANUAL.md) — 完整用户手册（功能、快捷键、设置、常见问题）
- [`docs/superpowers/specs/2026-05-15-amiyaplayer-optimization-design.md`](docs/superpowers/specs/2026-05-15-amiyaplayer-optimization-design.md) — 当前优化方案设计稿
- [`docs/superpowers/plans/2026-05-15-amiyaplayer-optimization.md`](docs/superpowers/plans/2026-05-15-amiyaplayer-optimization.md) — 12-PR 实施计划
- [`UPGRADE_TASKS.md`](UPGRADE_TASKS.md) — 早期路线图（已被上面两份文档继承）

## 技术栈

- Electron 28（Wave 3 升级到 33）
- 原生 JavaScript（CommonJS），无构建步骤
- Vitest + ESLint
- electron-builder 输出 Windows portable exe

## 当前状态（2026-05-15）

Wave 1 完成：4 个明显 bug 已修，工程化基线就位。
Wave 2 进行中：架构重构（preload 桥、renderer 拆分）。
后续：UX 应急锚点 / Electron 升级 / 托盘 + Boss Key / 命令面板 / 数据导入导出 / CI。

## License

未公开声明（保留所有权利）。
