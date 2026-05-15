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
