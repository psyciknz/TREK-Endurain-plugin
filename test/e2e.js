'use strict';

const assert = require('assert');
const { createMockHost } = require('trek-plugin-sdk/testing');
const plugin = require('../server/index.js');

const originalFetch = global.fetch;

function response(body, status) {
  return {
    ok: status === 200,
    status,
    async json() { return body; },
  };
}

(async () => {
  const mock = createMockHost({
    grants: ['db:own', 'db:read:trips', 'db:write:places', 'db:write:days', 'db:write:itinerary', 'db:meta', 'http:outbound'],
    actingUserId: 1,
    userSettings: {
      endurain_url: 'https://endurain.example.test',
      access_token: 'test-token',
    },
    trips: {
      7: { members: [1], data: { id: 7, title: 'Ride weekend' }, days: [] },
    },
  });
  const route = (path) => plugin.routes.find((entry) => entry.path === path);
  const requests = [];

  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/activities?page=1&limit=100')) {
      return response({ activities: [{ id: 42, name: 'Morning ride', sport_type: 'cycling', start_date_local: '2026-09-22T08:00:00Z', start_latitude: 51.5, start_longitude: -0.1, distance: 12345 }] }, 200);
    }
    if (url.endsWith('/activities/42')) {
      return response({ id: 42, name: 'Morning ride', sport_type: 'cycling', start_date_local: '2026-09-22T08:00:00Z', start_latitude: 51.5, start_longitude: -0.1, description: 'Test activity' }, 200);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await plugin.onLoad(mock.ctx);
    const list = await route('/activities').handler({ query: { page: '1', limit: '100' }, body: null }, mock.ctx);
    const listBody = JSON.parse(list.body);
    assert.strictEqual(list.status, 200);
    assert.strictEqual(listBody.activities[0].id, '42');
    assert.strictEqual(requests[0].options.headers.Authorization, 'Bearer test-token');
    assert.strictEqual(requests[0].options.headers['X-Client-Type'], 'mobile');

    const imported = await route('/import').handler({ body: { tripId: 7, activityIds: ['42'] } }, mock.ctx);
    const importedBody = JSON.parse(imported.body);
    assert.strictEqual(imported.status, 200);
    assert.strictEqual(importedBody.imported[0].duplicate, false);
    assert.strictEqual(importedBody.imported[0].activity.name, 'Morning ride');
    assert.strictEqual(mock.calls.some((call) => call.method === 'places.create'), true);
    assert.strictEqual(mock.calls.some((call) => call.method === 'itinerary.assign'), true);
  } finally {
    global.fetch = originalFetch;
  }

  console.log('Endurain route tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
