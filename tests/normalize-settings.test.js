import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
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
