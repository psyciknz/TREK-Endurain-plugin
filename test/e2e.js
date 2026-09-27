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

function jwt(claims) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

(async () => {
  const mock = createMockHost({
    grants: ['db:own', 'db:read:trips', 'db:write:places', 'db:write:days', 'db:write:itinerary', 'db:meta', 'http:outbound'],
    actingUserId: 1,
    userSettings: {
      endurain_url: 'https://endurain.example.test',
      endurain_username: 'rider@example.test',
      endurain_password: 'test-password',
    },
    trips: {
      7: { members: [1], data: { id: 7, title: 'Ride weekend', start_date: '2026-09-20', end_date: '2026-09-25' }, days: [] },
    },
  });
  const route = (path) => plugin.routes.find((entry) => entry.path === path);
  const requests = [];
  const authRows = new Map();
  const originalQuery = mock.ctx.db.query.bind(mock.ctx.db);
  const originalExec = mock.ctx.db.exec.bind(mock.ctx.db);
  mock.ctx.db.query = async (sql, ...args) => {
    if (sql.includes('FROM endurain_auth')) return authRows.has(`${args[0]}:${args[1]}`) ? [authRows.get(`${args[0]}:${args[1]}`)] : [];
    return originalQuery(sql, ...args);
  };
  mock.ctx.db.exec = async (sql, ...args) => {
    if (sql.startsWith('INSERT OR REPLACE INTO endurain_auth')) {
      authRows.set(`${args[0]}:${args[1]}`, { token_data: args[2] });
      return { changes: 1 };
    }
    return originalExec(sql, ...args);
  };
  const initialAccessToken = jwt({ sub: '1', exp: Math.floor(Date.now() / 1000) + 120 });
  const initialRefreshToken = jwt({ sub: '1', exp: Math.floor(Date.now() / 1000) + 604800 });
  const refreshedAccessToken = jwt({ sub: '1', exp: Math.floor(Date.now() / 1000) + 900 });
  const refreshedRefreshToken = jwt({ sub: '1', exp: Math.floor(Date.now() / 1000) + 604800 });

  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/auth/login')) {
      assert.strictEqual(options.method, 'POST');
      assert.strictEqual(options.headers['X-Client-Type'], 'mobile');
      assert.strictEqual(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.strictEqual(new URLSearchParams(options.body).get('username'), 'rider@example.test');
      assert.strictEqual(new URLSearchParams(options.body).get('password'), 'test-password');
      return response({ access_token: initialAccessToken, refresh_token: initialRefreshToken, expires_in: 120, refresh_token_expires_in: 604800 }, 200);
    }
    if (url.endsWith('/auth/refresh')) {
      assert.strictEqual(options.method, 'POST');
      assert.strictEqual(options.headers.Authorization, `Bearer ${initialRefreshToken}`);
      assert.strictEqual(options.headers['X-Client-Type'], 'mobile');
      return response({ access_token: refreshedAccessToken, refresh_token: refreshedRefreshToken, expires_in: 900, refresh_token_expires_in: 604800 }, 200);
    }
    if (url.includes('/activities/user/1/page_number/1/num_records/100?')) {
      assert.strictEqual(new URL(url).searchParams.get('start_date'), '2026-09-20');
      assert.strictEqual(new URL(url).searchParams.get('end_date'), '2026-09-25');
      assert.strictEqual(new URL(url).searchParams.get('name_search'), 'Morning');
      return response({ records: [{ id: 42, name: 'Morning ride', sport_type: 'cycling', start_date_local: '2026-09-22T08:00:00Z', start_latitude: 51.5, start_longitude: -0.1, distance: 12345 }] }, 200);
    }
    if (url.endsWith('/activities/42')) {
      return response({ id: 42, name: 'Morning ride', sport_type: 'cycling', start_date_local: '2026-09-22T08:00:00Z', description: 'Test activity' }, 200);
    }
    if (url.endsWith('/activities_streams/activity_id/42/stream_type/7')) {
      return response({ stream_waypoints: [{ lat: null, lon: null }, { latitude: 51.5, longitude: -0.1 }] }, 200);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await plugin.onLoad(mock.ctx);
    const range = await route('/trip-range').handler({ query: { tripId: '7' }, body: null }, mock.ctx);
    const rangeBody = JSON.parse(range.body);
    assert.deepStrictEqual(rangeBody, { startDate: '2026-09-20', endDate: '2026-09-25' });

    const list = await route('/activities').handler({ user: { id: 1 }, query: { page: '1', limit: '100', startDate: '2026-09-20', endDate: '2026-09-25', nameSearch: 'Morning' }, body: null }, mock.ctx);
    const listBody = JSON.parse(list.body);
    assert.strictEqual(list.status, 200, list.body);
    assert.strictEqual(listBody.activities[0].id, '42');
    const listRequest = requests.find((request) => request.url.includes('/activities/user/'));
    assert.strictEqual(listRequest.options.headers.Authorization, `Bearer ${refreshedAccessToken}`);
    assert.strictEqual(listRequest.options.headers['X-Client-Type'], 'mobile');
    assert.strictEqual(listRequest.options.headers['User-Agent'], 'Endurain Import TREK plugin/1.2');
    assert.strictEqual(requests.filter((request) => request.url.endsWith('/auth/login')).length, 1);
    assert.strictEqual(requests.filter((request) => request.url.endsWith('/auth/refresh')).length, 1);
    const storedTokens = Array.from(authRows.values())[0].token_data;
    assert.strictEqual(storedTokens.includes(refreshedAccessToken), false);
    assert.strictEqual(storedTokens.includes(refreshedRefreshToken), false);

    const imported = await route('/import').handler({ user: { id: 1 }, body: { tripId: 7, activityIds: ['42'] } }, mock.ctx);
    const importedBody = JSON.parse(imported.body);
    assert.strictEqual(imported.status, 200);
    assert.strictEqual(importedBody.imported[0].duplicate, false);
    assert.strictEqual(importedBody.imported[0].activity.name, 'Morning ride');
    assert.strictEqual(importedBody.imported[0].activity.startLat, 51.5);
    assert.strictEqual(importedBody.imported[0].activity.startLng, -0.1);
    assert.strictEqual(requests.some((request) => request.url.endsWith('/activities_streams/activity_id/42/stream_type/7')), true);
    const createdPlaces = await mock.ctx.trips.getPlaces(7);
    assert.strictEqual(createdPlaces[0].website, 'https://endurain.example.test/activity/42');
    assert.ok(createdPlaces[0].notes.includes('https://endurain.example.test/activity/42'));
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
