import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
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
