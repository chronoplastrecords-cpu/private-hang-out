const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBandcampOEmbedUrl } = require('../server');

test('buildBandcampOEmbedUrl preserves the source URL and format', () => {
  const url = 'https://artist.bandcamp.com/album/example';
  const built = buildBandcampOEmbedUrl(url);

  assert.equal(built.origin, 'https://bandcamp.com');
  assert.equal(built.pathname, '/oembed');
  assert.equal(built.searchParams.get('format'), 'json');
  assert.equal(built.searchParams.get('url'), url);
});
