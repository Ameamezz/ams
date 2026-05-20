const { app, BrowserWindow, globalShortcut, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_SETTINGS,
  clone,
  clamp,
  normalizeSettings
} = require('./lib/normalize-settings');
const { createId, normalizeItems } = require('./lib/normalize-items');

const WEBVIEW_PARTITION = 'persist:amiyaplayer';
const DATA_FILES = {
  settings: 'settings.json',
  tabs: 'tabs.json',
  history: 'history.json',
  favorites: 'favorites.json'
};
const MAX_SAVED_ITEMS = 10;


// Chromium 启动开关清单。每条都注明用途，删除前请确认替代手段。
const CHROMIUM_DISABLED_FEATURES = [
  'MediaRouter',                       // 关闭 Chromium 内置投屏发现，避免遮蔽穿透层。
  'DialMediaRouteProvider',            // 同上，DLNA 设备发现。
  'GlobalMediaControlsCastStartStop',  // 隐藏全局媒体控制中的投屏按钮。
  'WebRtcHideLocalIpsWithMdns',        // 配合下方 WebRTC 关闭，避免 mDNS 局部地址泄露。
  'CalculateNativeWinOcclusion'        // 透明窗口在 Windows 下经常被 DWM 误判为被遮挡，导致 Chromium
                                       // 暂停合成（表现为视频帧黑屏、UI 出现旧帧残留 / 重影）。关闭此项
                                       // 让 Chromium 不再听信遮挡判定，永远全速合成。
];

const CHROMIUM_SWITCHES = [
  ['disable-features', CHROMIUM_DISABLED_FEATURES.join(',')],
  ['disable-quic', null],                                          // 关 QUIC，避免某些 CDN 走 UDP 绕过抓包。
  ['disable-webrtc', null],                                        // 主要防 P2P/IP 泄露。
  ['disable-background-networking', null],                          // 关闭 Chromium 后台心跳。
  ['disable-domain-reliability', null],                             // 关闭 domain reliability 上报。
  ['force-webrtc-ip-handling-policy', 'disable_non_proxied_udp'],   // 双保险：即使 WebRTC 启用也走代理。
  ['webrtc-ip-handling-policy', 'disable_non_proxied_udp'],
  ['disable-backgrounding-occluded-windows', null],                 // F8 click-through 后窗口失焦，Chromium
                                                                     // 默认会把"看起来被遮挡"的窗口降频，导致
                                                                     // 视频停止刷新（黑屏）。强制不降。
  ['disable-renderer-backgrounding', null],                         // 同上，对应 renderer 进程层面的降级。
  ['disable-direct-composition', null]                              // Chromium 默认用 DirectComposition 合成视频到
                                                                     // layered window，但 click-through (WS_EX_TRANSPARENT)
                                                                     // 状态下 DComp 不再更新表面 → 视频帧停在最后一帧 → 黑屏。
                                                                     // 强制走传统 GDI/Skia 合成路径，每次 invalidate 都能真实
                                                                     // 写入 layered window。代价：失去部分硬件视频加速。
];

CHROMIUM_SWITCHES.forEach(([key, value]) => {
  if (value == null) {
    app.commandLine.appendSwitch(key);
  } else {
    app.commandLine.appendSwitch(key, value);
  }
});

let win;
let isClickThrough = false;
let isAlwaysOnTop = true;
let settings = clone(DEFAULT_SETTINGS);
let historyItems = [];
let favorites = [];
let tabs = [];
let quitting = false;
let invalidationPumpTimer = null;
const registeredShortcuts = new Map();
const INVALIDATION_PUMP_INTERVAL_MS = 33; // ~30fps，强制 Chromium 在 click-through 下持续重绘视频帧

function getDataPath(fileName) {
  return path.join(app.getPath('userData'), fileName);
}

function loadJson(fileName, fallback) {
  try {
    const raw = fs.readFileSync(getDataPath(fileName), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed == null ? clone(fallback) : parsed;
  } catch (_error) {
    return clone(fallback);
  }
}

function saveJson(fileName, data) {
  try {
    const filePath = getDataPath(fileName);
    const dir = path.dirname(filePath);
    const tempPath = `${filePath}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (_error) {
    // Storage must never interrupt playback.
  }
}

function loadAllData() {
  settings = normalizeSettings(loadJson(DATA_FILES.settings, DEFAULT_SETTINGS));
  historyItems = normalizeItems(loadJson(DATA_FILES.history, []), MAX_SAVED_ITEMS);
  favorites = normalizeItems(loadJson(DATA_FILES.favorites, []), MAX_SAVED_ITEMS);
  tabs = normalizeItems(loadJson(DATA_FILES.tabs, []), MAX_SAVED_ITEMS);
}

function saveSettings() {
  saveJson(DATA_FILES.settings, settings);
}

function saveHistory() {
  saveJson(DATA_FILES.history, historyItems);
}

function saveFavorites() {
  saveJson(DATA_FILES.favorites, favorites);
}

function saveTabs() {
  saveJson(DATA_FILES.tabs, tabs);
}

function getEffectiveOpacity() {
  return settings.opacity;
}

function sendStatePatch(patch) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('app-state-updated', patch);
  }
}

function applyOpacity() {
  if (win && !win.isDestroyed()) {
    win.setOpacity(getEffectiveOpacity());
  }
}

// 历史决定：之前用 PowerShell + Win32 API 给所有子窗口设 WS_EX_TRANSPARENT / WS_EX_LAYERED 作为
// click-through 的"双保险"。结果是该兜底比病更糟 —— 子窗口被设 WS_EX_TRANSPARENT 后 Chromium 的视频
// 帧停止绘制（黑屏）；execFile 启动 powershell.exe 又把 F8 切换变得明显卡顿。Electron 自己的
// setIgnoreMouseEvents 已经设置顶层 HWND 的 WS_EX_TRANSPARENT，Windows 根本不会把鼠标消息送到这个
// 窗口，OOPIF 子窗口也就收不到。所以整套 PowerShell shim 已彻底移除。
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

function adjustOpacity(delta) {
  setOpacity(settings.opacity + delta);
}

function startInvalidationPump() {
  stopInvalidationPump();
  // click-through 状态下 Windows 不再向窗口投递鼠标/输入消息，Chromium 合成线程缺少 tick 驱动，
  // 视频帧停在最后一帧（呈现为黑屏）。除了 webContents.invalidate() 触发 Chromium 内部重绘，还要让
  // Windows 主动 swap layered window 表面 —— 在 base opacity 之上做极小幅 (±0.001) 抖动，每次 setOpacity
  // 都会调一次 SetLayeredWindowAttributes，强制 DWM 重新合成 layered window。肉眼几乎察觉不到。
  let toggle = false;
  invalidationPumpTimer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      stopInvalidationPump();
      return;
    }
    win.webContents.invalidate();
    const baseOpacity = getEffectiveOpacity();
    // 抖动方向也不能让 opacity > 1，否则 Electron 会忽略。固定向下抖。
    const jittered = toggle ? Math.max(0.3, baseOpacity - 0.001) : baseOpacity;
    win.setOpacity(jittered);
    toggle = !toggle;
  }, INVALIDATION_PUMP_INTERVAL_MS);
}

function stopInvalidationPump() {
  if (invalidationPumpTimer) {
    clearInterval(invalidationPumpTimer);
    invalidationPumpTimer = null;
  }
}

function setClickThrough(nextValue) {
  isClickThrough = Boolean(nextValue);

  if (!win || win.isDestroyed()) {
    return;
  }

  // forward:true 让 mousemove 事件继续转发到 webContents（点击仍然穿透），逼 Chromium 合成线程保持活跃。
  // 不再调用 setFocusable(false) / blur() —— 窗口仍可获焦，但用户的"不可聚焦"诉求由 click-through 本身
  // 满足（鼠标穿透，用户点不到窗口；视频操作走 globalShortcut → IPC → webview.executeJavaScript）。
  win.setIgnoreMouseEvents(isClickThrough, { forward: true });
  // 阻止 webContents 被认为后台后降频，否则即使开了 disable-renderer-backgrounding 也可能被节流。
  win.webContents.setBackgroundThrottling(false);
  if (isClickThrough) {
    startInvalidationPump();
  } else {
    stopInvalidationPump();
    win.webContents.invalidate(); // 恢复时立刻刷一帧，清掉 click-through 期间合成残留的旧像素。
  }
  win.webContents.send('toggle-ui', !isClickThrough);
  sendStatePatch({ isClickThrough });
}

function setAlwaysOnTop(nextValue) {
  isAlwaysOnTop = Boolean(nextValue);

  if (!win || win.isDestroyed()) {
    return;
  }

  win.setAlwaysOnTop(isAlwaysOnTop, 'screen-saver');
  sendStatePatch({ isAlwaysOnTop });
}

function configureWebSession() {
  const webSession = session.fromPartition(WEBVIEW_PARTITION);
  const preloadPath = path.join(__dirname, 'webview-preload.js');

  try {
    webSession.setPreloads([preloadPath]);
  } catch (_error) {
    // The webview element also sets the preload path from the renderer.
  }

  webSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(!['display-capture', 'geolocation', 'media', 'midi', 'midiSysex', 'notifications', 'openExternal', 'window-management'].includes(permission));
  });

  webSession.setPermissionCheckHandler((_webContents, permission) => (
    !['display-capture', 'geolocation', 'media', 'midi', 'midiSysex', 'notifications', 'openExternal', 'window-management'].includes(permission)
  ));

  webSession.webRequest.onBeforeRequest((details, callback) => {
    const url = String(details.url || '').toLowerCase();
    const shouldBlock = (
      (details.resourceType === 'script' || details.resourceType === 'xhr' || details.resourceType === 'fetch' || details.resourceType === 'websocket') &&
      (url.includes('/p2p/') || url.includes('p2p.') || url.includes('-p2p') || url.includes('webrtc') || url.includes('/stun') || url.includes('/turn'))
    );

    callback({ cancel: shouldBlock });
  });
}

function getAppState() {
  return {
    settings,
    history: historyItems,
    favorites,
    tabs,
    isClickThrough,
    isAlwaysOnTop,
    userDataPath: app.getPath('userData'),
    webviewPartition: WEBVIEW_PARTITION
  };
}

function runShortcutAction(action) {
  if (!win || win.isDestroyed()) {
    return;
  }

  if (action === 'window.toggleAlwaysOnTop') {
    setAlwaysOnTop(!isAlwaysOnTop);
  } else if (action === 'window.toggleClickThrough') {
    setClickThrough(!isClickThrough);
  } else if (action === 'appearance.opacityDown') {
    adjustOpacity(-0.05);
  } else if (action === 'appearance.opacityUp') {
    adjustOpacity(0.05);
  } else {
    win.webContents.send('run-action', action);
  }
}

function registerShortcuts() {
  const desired = new Map();
  // F8 是硬编码的紧急穿透开关，优先级高于 toolbar 配置；若用户在 toolbar 中把 F8 绑给其他 action，下方 desired.has(key) 会静默跳过，确保 F8 永远能恢复 UI。
  desired.set('f8', { action: '__builtin.toggleClickThrough', label: 'F8 紧急穿透切换', accelerator: 'F8' });

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
    const current = registeredShortcuts.get(key);
    if (!desiredKeys.has(key) || desired.get(key).action !== current.action) {
      try {
        globalShortcut.unregister(current.accelerator);
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
    try {
      const ok = globalShortcut.register(value.accelerator, () => {
        if (value.action === '__builtin.toggleClickThrough') {
          setClickThrough(!isClickThrough);
        } else {
          runShortcutAction(value.action);
        }
      });
      if (ok) {
        registeredShortcuts.set(key, value);
      }
    } catch (_error) {
      // 非法 accelerator 在设置 UI 已提示，这里静默跳过。
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 960,
    height: 620,
    minWidth: 800,
    minHeight: 420,
    icon: path.join(__dirname, 'icon.ico'),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      partition: WEBVIEW_PARTITION,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  setAlwaysOnTop(true);
  win.loadFile('index.html');
  applyOpacity();

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('did-attach-webview', (_event, guestContents) => {
    guestContents.setWindowOpenHandler(({ url }) => {
      if (url && url !== 'about:blank') {
        win.webContents.send('open-url-in-webview', url);
      }

      return { action: 'deny' };
    });
  });

  win.webContents.on('did-finish-load', () => {
    sendStatePatch(getAppState());
  });

  registerShortcuts();
}

app.whenReady().then(() => {
  loadAllData();
  configureWebSession();
  createWindow();
});

app.on('before-quit', async (event) => {
  if (quitting) {
    return;
  }

  quitting = true;
  event.preventDefault();

  try {
    const persistentSession = session.fromPartition(WEBVIEW_PARTITION);
    await Promise.allSettled([
      persistentSession.flushStorageData(),
      persistentSession.cookies.flushStore()
    ]);
  } finally {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  registeredShortcuts.clear();
  stopInvalidationPump();
});

ipcMain.handle('get-app-state', () => getAppState());

ipcMain.handle('window-control', (_event, command) => {
  if (!win || win.isDestroyed()) {
    return false;
  }

  if (command === 'minimize') {
    win.minimize();
  } else if (command === 'maximize') {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  } else if (command === 'close') {
    win.close();
  }

  return true;
});

ipcMain.handle('toggle-always-on-top', () => {
  setAlwaysOnTop(!isAlwaysOnTop);
  return isAlwaysOnTop;
});

ipcMain.handle('toggle-click-through', () => {
  setClickThrough(!isClickThrough);
  return isClickThrough;
});

ipcMain.handle('set-opacity', (_event, value) => {
  applyOpacityValue(value);
  return settings.opacity;
});

ipcMain.handle('commit-opacity', () => {
  persistOpacity();
  return settings.opacity;
});

ipcMain.handle('update-settings', (_event, patch) => {
  const nextSettings = {
    ...settings,
    ...(patch && typeof patch === 'object' ? patch : {})
  };
  settings = normalizeSettings(nextSettings);
  saveSettings();
  registerShortcuts();
  applyOpacity();
  sendStatePatch({ settings });
  return settings;
});

ipcMain.handle('reset-settings', () => {
  settings = normalizeSettings(DEFAULT_SETTINGS);
  saveSettings();
  registerShortcuts();
  applyOpacity();
  sendStatePatch({ settings });
  return settings;
});

ipcMain.handle('record-history', (_event, payload) => {
  const url = String(payload && payload.url ? payload.url : '').trim();
  if (!url || url === 'about:blank') {
    return historyItems;
  }

  const now = new Date().toISOString();
  const title = String((payload && payload.title) || url).slice(0, 160);
  const newest = historyItems[0];

  if (newest && newest.url === url) {
    newest.title = title;
    newest.visitedAt = now;
    newest.updatedAt = now;
  } else {
    historyItems = historyItems.filter((item) => item.url !== url);
    historyItems.unshift({
      id: createId(),
      title,
      url,
      visitedAt: now,
      createdAt: now,
      updatedAt: now
    });
  }

  historyItems = historyItems.slice(0, MAX_SAVED_ITEMS);
  settings.lastUrl = url;
  saveHistory();
  saveSettings();
  sendStatePatch({ history: historyItems, settings });
  return historyItems;
});

ipcMain.handle('save-tabs', (_event, nextTabs) => {
  tabs = normalizeItems(nextTabs, MAX_SAVED_ITEMS);
  saveTabs();
  sendStatePatch({ tabs });
  return tabs;
});

ipcMain.handle('remove-tab', (_event, id) => {
  tabs = tabs.filter((item) => item.id !== id && item.url !== id);
  saveTabs();
  sendStatePatch({ tabs });
  return tabs;
});

ipcMain.handle('remove-history', (_event, id) => {
  historyItems = historyItems.filter((item) => item.id !== id && item.url !== id);
  saveHistory();
  sendStatePatch({ history: historyItems });
  return historyItems;
});

ipcMain.handle('add-favorite', (_event, payload) => {
  const url = String(payload && payload.url ? payload.url : '').trim();
  if (!url || url === 'about:blank') {
    return favorites;
  }

  const now = new Date().toISOString();
  const title = String((payload && payload.title) || url).slice(0, 160);
  const existing = favorites.find((item) => item.url === url);

  if (existing) {
    existing.title = title;
    existing.updatedAt = now;
  } else {
    favorites.unshift({
      id: createId(),
      title,
      url,
      createdAt: now,
      updatedAt: now,
      visitedAt: now
    });
  }

  favorites = favorites.slice(0, MAX_SAVED_ITEMS);
  saveFavorites();
  sendStatePatch({ favorites });
  return favorites;
});

ipcMain.handle('remove-favorite', (_event, id) => {
  favorites = favorites.filter((item) => item.id !== id && item.url !== id);
  saveFavorites();
  sendStatePatch({ favorites });
  return favorites;
});

ipcMain.handle('clear-current-site-data', async (_event, origin) => {
  const parsedOrigin = String(origin || '').trim();
  if (!parsedOrigin) {
    return false;
  }

  const persistentSession = session.fromPartition(WEBVIEW_PARTITION);
  await persistentSession.clearStorageData({
    origin: parsedOrigin,
    storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
  });
  await persistentSession.cookies.flushStore();
  return true;
});

ipcMain.handle('clear-all-web-data', async () => {
  const persistentSession = session.fromPartition(WEBVIEW_PARTITION);
  await persistentSession.clearStorageData();
  await persistentSession.clearCache();
  await persistentSession.cookies.flushStore();
  return true;
});

ipcMain.handle('open-user-data-folder', async () => {
  return shell.openPath(app.getPath('userData'));
});
