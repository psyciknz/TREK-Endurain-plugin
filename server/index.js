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

function tokenUserId(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const id = Number(payload.sub || payload.user_id || payload.userId);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (_) {
    return null;
  }
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.records)) return data.records;
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
  ctx.log.info(`Endurain request: ${(options && options.method) || 'GET'} ${API_PREFIX}${path}`);
  let response;
  try {
    response = await fetch(`${base}${API_PREFIX}${path}`, {
      ...(options || {}),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Client-Type': 'mobile',
        'User-Agent': 'Endurain Import TREK plugin/1.1',
        ...((options && options.headers) || {}),
      },
    });
  } catch (error) {
    throw new Error(`Could not reach Endurain: ${error.message}`);
  }
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail || ''; } catch (_) {}
    ctx.log.warn(`Endurain response: HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
    throw new Error(`Endurain returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  ctx.log.info(`Endurain response: HTTP ${response.status}`);
  return response.json();
}

async function tripRange(ctx, tripId) {
  const trips = await ctx.trips.listMine();
  const trip = (trips || []).find((item) => Number(item.id) === Number(tripId));
  return {
    startDate: trip && (trip.start_date || trip.startDate) || null,
    endDate: trip && (trip.end_date || trip.endDate) || null,
  };
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
    ctx.log.info('Endurain Import loaded');
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
          const startDate = String(req.query.startDate || '').trim();
          const endDate = String(req.query.endDate || '').trim();
          const nameSearch = String(req.query.nameSearch || '').trim();
          const token = await setting(ctx, 'access_token');
          const userId = tokenUserId(token);
          if (!userId) throw new Error('The Endurain access token does not contain a usable user id (JWT sub claim).');
          const params = new URLSearchParams({ sort_by: 'start_time', sort_order: 'desc' });
          if (startDate) params.set('start_date', startDate);
          if (endDate) params.set('end_date', endDate);
          if (nameSearch) params.set('name_search', nameSearch);
          const path = `/activities/user/${userId}/page_number/${page}/num_records/${limit}?${params}`;
          ctx.log.info(`Loading Endurain activities: user=${userId}, page=${page}, limit=${limit}, start=${startDate || '-'}, end=${endDate || '-'}, name=${nameSearch || '-'}`);
          const data = await endurainRequest(ctx, path);
          return jsonResponse(200, { ok: true, activities: asArray(data).map(normalizeActivity), page, limit });
        } catch (error) {
          ctx.log.warn(`Endurain activity list failed: ${error.message}`);
          return fail(422, error.message);
        }
      },
    },
    {
      method: 'GET',
      path: '/trip-range',
      auth: true,
      async handler(req, ctx) {
        const tripId = Number(req.query.tripId);
        if (!Number.isInteger(tripId) || tripId < 1) return jsonResponse(200, { startDate: null, endDate: null });
        try {
          const range = await tripRange(ctx, tripId);
          ctx.log.info(`Trip range loaded: trip=${tripId}, start=${range.startDate || '-'}, end=${range.endDate || '-'}`);
          return jsonResponse(200, range);
        } catch (error) {
          ctx.log.warn(`Trip range failed for trip ${tripId}: ${error.message}`);
          return jsonResponse(200, { startDate: null, endDate: null, error: error.message });
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
