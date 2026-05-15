'use strict';

function normalizeUrl(rawUrl) {
  let url = String(rawUrl == null ? '' : rawUrl).trim();
  if (!url) {
    return '';
  }
  if (url === 'about:blank') {
    return url;
  }
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url;
}

module.exports = { normalizeUrl };
