const { app, BrowserWindow, globalShortcut, ipcMain, session, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  DEFAULT_SETTINGS,
  clone,
  clamp,
  normalizeSettings
} = require('./lib/normalize-settings');

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

let win;
let isClickThrough = false;
let isAlwaysOnTop = true;
let settings = clone(DEFAULT_SETTINGS);
let historyItems = [];
let favorites = [];
let tabs = [];
let quitting = false;
let nativeClickThroughTimer = null;
const registeredShortcuts = new Map();

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

function createId() {
  if (global.crypto && typeof global.crypto.randomUUID === 'function') {
    return global.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function getNativeWindowHandleValue() {
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

function applyNativeClickThrough(enabled) {
  if (process.platform !== 'win32') {
    return;
  }

  const hwnd = getNativeWindowHandleValue();
  if (!hwnd) {
    return;
  }

  const script = `
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
[AmiyaClickThrough]::Apply([Int64]"${hwnd}", $${enabled ? 'true' : 'false'})
`;

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true },
    () => {}
  );
}

function queueNativeClickThrough(enabled) {
  if (nativeClickThroughTimer) {
    clearTimeout(nativeClickThroughTimer);
  }

  applyNativeClickThrough(enabled);
  nativeClickThroughTimer = setTimeout(() => applyNativeClickThrough(enabled), 250);
}

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

function setClickThrough(nextValue) {
  isClickThrough = Boolean(nextValue);

  if (!win || win.isDestroyed()) {
    return;
  }

  win.setFocusable(!isClickThrough);
  win.setIgnoreMouseEvents(isClickThrough);
  queueNativeClickThrough(isClickThrough);
  if (isClickThrough) {
    win.blur();
  } else {
    win.focus();
  }
  applyOpacity();
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
