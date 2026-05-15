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
  'Back',
  'Forward',
  'Refresh',
  'Home',
  'Sidebar',
  'Favorite',
  'Pin',
  'Click-through',
  'Playback',
  'Clean',
  'Mode',
  'B站模式',
  'Play',
  'Rewind',
  'Forward 5s',
  'Less opaque',
  'More opaque',
  'Settings'
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
