'use strict';

const { definePlugin } = require('trek-plugin-sdk');

const API_PREFIX = '/api/v1';
const MAX_ACTIVITY_LIMIT = 100;

function jsonResponse(status, body) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function fail(status, message) {
  return jsonResponse(status, { ok: false, message });
}

function cleanUrl(value) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(url)) throw new Error('Endurain URL must use HTTPS.');
  return url;
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.activities)) return data.activities;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

function activityId(activity) {
  return activity && (activity.id || activity.activity_id || activity.uuid);
}

function activityDate(activity) {
  const value = activity && (activity.start_date_local || activity.start_time || activity.created_at);
  if (!value) return null;
  const date = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function coordinate(activity, names) {
  for (const name of names) {
    const value = activity && activity[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function normalizeActivity(activity) {
  const id = activityId(activity);
  return {
    id: id == null ? null : String(id),
    name: String(activity.name || activity.title || activity.sport_type || 'Endurain activity'),
    sport: activity.sport_type || activity.activity_type || activity.type || '',
    date: activityDate(activity),
    distance: activity.distance ?? activity.distance_meters ?? null,
    duration: activity.moving_time ?? activity.duration_seconds ?? activity.elapsed_time ?? null,
    startLat: coordinate(activity, ['start_latitude', 'start_lat', 'latitude']),
    startLng: coordinate(activity, ['start_longitude', 'start_lng', 'longitude']),
    description: activity.description || '',
  };
}

async function setting(ctx, key) {
  const value = await ctx.settings.get(key);
  if (!value) throw new Error(`Configure the Endurain ${key === 'endurain_url' ? 'URL' : 'access token'} in Settings -> Plugins.`);
  return value;
}

async function endurainRequest(ctx, path, options) {
  const base = cleanUrl(await setting(ctx, 'endurain_url'));
  const token = await setting(ctx, 'access_token');
  let response;
  try {
    response = await fetch(`${base}${API_PREFIX}${path}`, {
      ...(options || {}),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Client-Type': 'mobile',
        ...((options && options.headers) || {}),
      },
    });
  } catch (error) {
    throw new Error(`Could not reach Endurain: ${error.message}`);
  }
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail || ''; } catch (_) {}
    throw new Error(`Endurain returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}

async function findOrCreateDay(ctx, tripId, date) {
  const days = await ctx.trips.getDays(tripId);
  const existing = (days || []).find((day) => String(day.date || '').slice(0, 10) === date);
  if (existing) return existing;
  return ctx.days.create(tripId, { date: date || undefined });
}

async function importActivity(ctx, tripId, activity) {
  const id = activityId(activity);
  if (id == null) throw new Error('Endurain returned an activity without an id.');

  const existing = await ctx.db.query(
    'SELECT place_id FROM activity_imports WHERE trip_id = ? AND activity_id = ?',
    tripId, String(id),
  );
  if (existing.length) return { duplicate: true, placeId: Number(existing[0].place_id) };

  const normalized = normalizeActivity(activity);
  if (normalized.startLat == null || normalized.startLng == null) {
    throw new Error(`Activity "${normalized.name}" has no starting coordinates.`);
  }

  const day = await findOrCreateDay(ctx, tripId, normalized.date);
  const notes = [
    'Imported from Endurain.',
    `Endurain activity: ${id}.`,
    normalized.sport ? `Sport: ${normalized.sport}.` : '',
    normalized.description,
  ].filter(Boolean).join(' ');
  const place = await ctx.places.create(tripId, {
    name: normalized.name,
    lat: normalized.startLat,
    lng: normalized.startLng,
    notes,
  });
  await ctx.itinerary.assign(tripId, day.id, place.id, notes);
  await ctx.db.exec(
    'INSERT INTO activity_imports (trip_id, activity_id, place_id, imported_at) VALUES (?, ?, ?, ?)',
    tripId, String(id), Number(place.id), new Date().toISOString(),
  );
  return { duplicate: false, placeId: Number(place.id), dayId: Number(day.id), activity: normalized };
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate(
      '001_activity_imports',
      `CREATE TABLE IF NOT EXISTS activity_imports (
        trip_id INTEGER NOT NULL,
        activity_id TEXT NOT NULL,
        place_id INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (trip_id, activity_id)
      )`,
    );
  },

  routes: [
    {
      method: 'GET',
      path: '/activities',
      auth: true,
      async handler(req, ctx) {
        try {
          const page = Math.max(1, Number(req.query.page || 1));
          const limit = Math.min(MAX_ACTIVITY_LIMIT, Math.max(1, Number(req.query.limit || 50)));
          const params = new URLSearchParams({ page: String(page), limit: String(limit) });
          const data = await endurainRequest(ctx, `/activities?${params}`);
          return jsonResponse(200, { ok: true, activities: asArray(data).map(normalizeActivity), page, limit });
        } catch (error) {
          ctx.log.warn(`Endurain activity list failed: ${error.message}`);
          return fail(422, error.message);
        }
      },
    },
    {
      method: 'POST',
      path: '/import',
      auth: true,
      async handler(req, ctx) {
        const input = req.body && typeof req.body === 'object' ? req.body : {};
        const tripId = Number(input.tripId);
        const ids = Array.isArray(input.activityIds) ? input.activityIds.map(String).filter(Boolean) : [];
        if (!Number.isInteger(tripId) || tripId < 1) return fail(400, 'tripId is required.');
        if (!ids.length) return fail(400, 'Select at least one Endurain activity.');
        if (ids.length > MAX_ACTIVITY_LIMIT) return fail(400, `Select no more than ${MAX_ACTIVITY_LIMIT} activities.`);

        try {
          const results = [];
          for (const id of ids) {
            const data = await endurainRequest(ctx, `/activities/${encodeURIComponent(id)}`);
            const activity = data && (data.activity || data);
            results.push(await importActivity(ctx, tripId, activity));
          }
          return jsonResponse(200, { ok: true, tripId, imported: results });
        } catch (error) {
          ctx.log.warn(`Endurain activity import failed: ${error.message}`);
          return fail(422, error.message);
        }
      },
    },
  ],
});
