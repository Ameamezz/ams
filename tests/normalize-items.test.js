import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
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
