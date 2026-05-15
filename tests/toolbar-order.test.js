import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
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
