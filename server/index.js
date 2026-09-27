'use strict';

const crypto = require('crypto');
const { definePlugin } = require('trek-plugin-sdk');

const API_PREFIX = '/api/v1';
const MAX_ACTIVITY_LIMIT = 100;
const ACCESS_TOKEN_REFRESH_BUFFER_SECONDS = 300;
const authCache = new Map();
const authRequests = new Map();

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

function tokenClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function tokenExpiry(claims, fallbackSeconds) {
  const expiry = Number(claims && claims.exp);
  return Number.isFinite(expiry) && expiry > 0 ? expiry : Math.floor(Date.now() / 1000) + fallbackSeconds;
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
  const value = activity && (activity.start_time_tz_applied || activity.start_date_local || activity.start_time || activity.created_at);
  if (!value) return null;
  const date = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function matchesDateRange(activity, startDate, endDate) {
  if (!startDate && !endDate) return true;
  const date = activityDate(activity);
  return !!date && (!startDate || date >= startDate) && (!endDate || date <= endDate);
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

function firstGpsPoint(stream) {
  const waypoints = Array.isArray(stream) ? stream : stream && (stream.stream_waypoints || stream.data);
  if (!Array.isArray(waypoints)) return null;
  for (const waypoint of waypoints) {
    if (!waypoint || typeof waypoint !== 'object') continue;
    const latitude = Number(waypoint.lat ?? waypoint.latitude);
    const longitude = Number(waypoint.lon ?? waypoint.lng ?? waypoint.longitude);
    if (Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180) {
      return { latitude, longitude };
    }
  }
  return null;
}

async function setting(ctx, key) {
  const value = await ctx.settings.get(key);
  if (value == null || String(value).trim() === '') {
    const labels = { endurain_url: 'URL', endurain_username: 'username', endurain_password: 'password' };
    throw new Error(`Configure the Endurain ${labels[key] || key} in Settings -> Plugins.`);
  }
  return String(value);
}

function makeAuthContext(user, base, username, password) {
  const trekUserId = Number(user && user.id);
  if (!Number.isInteger(trekUserId) || trekUserId < 1) throw new Error('Open this plugin as a signed-in TREK user.');
  const accountKey = crypto.createHash('sha256').update(JSON.stringify([trekUserId, base, username])).digest('hex');
  const passwordFingerprint = crypto.createHash('sha256').update(password).digest('hex');
  return { trekUserId, accountKey, password, passwordFingerprint, base, username };
}

async function endurainAuthContext(ctx, user) {
  const base = cleanUrl(await setting(ctx, 'endurain_url'));
  const username = (await setting(ctx, 'endurain_username')).trim();
  const password = await setting(ctx, 'endurain_password');
  return makeAuthContext(user, base, username, password);
}

class EndurainHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function requestEndurain(ctx, base, path, options, bearerToken) {
  const requestOptions = options || {};
  const method = requestOptions.method || 'GET';
  const headers = {
    Accept: 'application/json',
    'X-Client-Type': 'mobile',
    'User-Agent': 'Endurain Import TREK plugin/1.2',
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...(requestOptions.headers || {}),
  };
  ctx.log.info(`Endurain request: ${method} ${API_PREFIX}${path.split('?')[0]}`);
  let response;
  try {
    response = await fetch(`${base}${API_PREFIX}${path}`, {
      ...requestOptions,
      headers,
    });
  } catch (error) {
    throw new Error(`Could not reach Endurain: ${error.message}`);
  }
  let data;
  try { data = await response.json(); } catch (_) { data = null; }
  if (!response.ok) {
    const detail = data && data.detail || '';
    ctx.log.warn(`Endurain response: HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
    throw new EndurainHttpError(response.status, `Endurain returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  ctx.log.info(`Endurain response: HTTP ${response.status}`);
  return data;
}

function parseTokenResponse(data, previousTokens) {
  if (data && data.mfa_required) {
    const error = new Error('This Endurain account requires MFA. MFA sign-in is not supported by this plugin yet.');
    error.code = 'ENDURAIN_MFA_REQUIRED';
    throw error;
  }
  const accessToken = data && data.access_token;
  const refreshToken = data && (data.refresh_token || (previousTokens && previousTokens.refreshToken));
  if (!accessToken || !refreshToken) throw new Error('Endurain login did not return both access and refresh tokens.');
  const claims = tokenClaims(accessToken);
  const userId = Number(claims && claims.sub);
  if (!Number.isInteger(userId) || userId < 1) throw new Error('Endurain did not return an access token with a numeric user id.');
  const now = Math.floor(Date.now() / 1000);
  const accessLifetime = Math.max(1, Number(data.expires_in) || 900);
  const refreshLifetime = Math.max(1, Number(data.refresh_token_expires_in) || 604800);
  const refreshClaims = tokenClaims(refreshToken);
  return {
    userId,
    accessToken,
    refreshToken,
    accessExpiresAt: tokenExpiry(claims, accessLifetime),
    refreshExpiresAt: tokenExpiry(refreshClaims, refreshLifetime),
  };
}

function encryptionKey(password, accountKey) {
  return crypto.scryptSync(password, Buffer.from(accountKey, 'hex'), 32);
}

function encryptTokens(tokens, password, accountKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(password, accountKey), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function decryptTokens(value, password, accountKey) {
  try {
    const [ivPart, tagPart, encryptedPart] = String(value).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(password, accountKey), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encryptedPart, 'base64url')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (_) {
    return null;
  }
}

async function loginEndurain(ctx, auth) {
  const body = new URLSearchParams({ username: auth.username, password: auth.password }).toString();
  const data = await requestEndurain(ctx, auth.base, '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return parseTokenResponse(data);
}

async function refreshEndurain(ctx, auth, tokens) {
  const data = await requestEndurain(ctx, auth.base, '/auth/refresh', { method: 'POST' }, tokens.refreshToken);
  return parseTokenResponse(data, tokens);
}

async function saveTokens(ctx, auth, tokens) {
  const encrypted = encryptTokens(tokens, auth.password, auth.accountKey);
  await ctx.db.exec(
    'INSERT OR REPLACE INTO endurain_auth (user_id, account_key, token_data, updated_at) VALUES (?, ?, ?, ?)',
    auth.trekUserId, auth.accountKey, encrypted, new Date().toISOString(),
  );
}

async function renewOrLogin(ctx, auth, tokens) {
  const now = Math.floor(Date.now() / 1000);
  if (tokens && tokens.refreshExpiresAt > now) {
    try {
      return await refreshEndurain(ctx, auth, tokens);
    } catch (error) {
      if (!(error instanceof EndurainHttpError) || ![401, 403].includes(error.status)) throw error;
    }
  }
  return loginEndurain(ctx, auth);
}

async function endurainSession(ctx, user, forceRefresh) {
  const auth = await endurainAuthContext(ctx, user);
  const cacheKey = `${auth.trekUserId}:${auth.accountKey}`;
  const inFlight = authRequests.get(cacheKey);
  if (inFlight) return inFlight;

  const request = (async function () {
    let tokens = null;
    let persist = false;
    const cached = authCache.get(cacheKey);
    if (cached && cached.passwordFingerprint === auth.passwordFingerprint) {
      tokens = cached.tokens;
    } else {
      const rows = await ctx.db.query(
        'SELECT token_data FROM endurain_auth WHERE user_id = ? AND account_key = ?',
        auth.trekUserId, auth.accountKey,
      );
      if (rows.length) tokens = decryptTokens(rows[0].token_data, auth.password, auth.accountKey);
    }

    const now = Math.floor(Date.now() / 1000);
    if (forceRefresh || !tokens || tokens.accessExpiresAt - now <= ACCESS_TOKEN_REFRESH_BUFFER_SECONDS) {
      tokens = await renewOrLogin(ctx, auth, tokens);
      persist = true;
    }
    if (persist) await saveTokens(ctx, auth, tokens);
    authCache.set(cacheKey, { passwordFingerprint: auth.passwordFingerprint, tokens });
    return { base: auth.base, accessToken: tokens.accessToken, userId: tokens.userId };
  }());

  authRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (authRequests.get(cacheKey) === request) authRequests.delete(cacheKey);
  }
}

async function endurainRequest(ctx, user, path, options) {
  let session = await endurainSession(ctx, user, false);
  let response;
  try {
    response = await requestEndurain(ctx, session.base, path, options, session.accessToken);
  } catch (error) {
    if (!(error instanceof EndurainHttpError) || error.status !== 401) throw error;
    session = await endurainSession(ctx, user, true);
    response = await requestEndurain(ctx, session.base, path, options, session.accessToken);
  }
  return response;
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

  const activityUrl = `${cleanUrl(await setting(ctx, 'endurain_url'))}/activity/${encodeURIComponent(id)}`;
  const day = await findOrCreateDay(ctx, tripId, normalized.date);
  const notes = [
    'Imported from Endurain.',
    `Endurain activity: ${id}.`,
    activityUrl,
    normalized.sport ? `Sport: ${normalized.sport}.` : '',
    normalized.description,
  ].filter(Boolean).join(' ');
  const place = await ctx.places.create(tripId, {
    name: normalized.name,
    lat: normalized.startLat,
    lng: normalized.startLng,
    website: activityUrl,
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
    await ctx.db.migrate(
      '002_endurain_auth',
      `CREATE TABLE IF NOT EXISTS endurain_auth (
        user_id INTEGER NOT NULL,
        account_key TEXT NOT NULL,
        token_data TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, account_key)
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
          const session = await endurainSession(ctx, req.user, false);
          const userId = session.userId;
          if (!Number.isInteger(userId) || userId < 1) throw new Error('Endurain did not return an access token with a numeric user id.');
          const params = new URLSearchParams({ sort_by: 'start_time', sort_order: 'desc' });
          if (startDate) params.set('start_date', startDate);
          if (endDate) params.set('end_date', endDate);
          if (nameSearch) params.set('name_search', nameSearch);
          const path = `/activities/user/${userId}/page_number/${page}/num_records/${limit}?${params}`;
          ctx.log.info(`Loading Endurain activities: user=${userId}, page=${page}, limit=${limit}, start=${startDate || '-'}, end=${endDate || '-'}, name=${nameSearch || '-'}`);
          const data = await endurainRequest(ctx, req.user, path);
          const activities = asArray(data)
            .filter((activity) => matchesDateRange(activity, startDate, endDate))
            .map(normalizeActivity);
          return jsonResponse(200, { ok: true, activities, page, limit });
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
            const data = await endurainRequest(ctx, req.user, `/activities/${encodeURIComponent(id)}`);
            let activity = data && (data.activity || data);
            const normalized = normalizeActivity(activity);
            if (normalized.startLat == null || normalized.startLng == null) {
              let stream = null;
              try {
                stream = await endurainRequest(ctx, req.user, `/activities_streams/activity_id/${encodeURIComponent(id)}/stream_type/7`);
              } catch (error) {
                if (!(error instanceof EndurainHttpError) || ![404, 422].includes(error.status)) throw error;
              }
              const point = firstGpsPoint(stream);
              if (point) {
                activity = {
                  ...activity,
                  start_latitude: normalized.startLat == null ? point.latitude : normalized.startLat,
                  start_longitude: normalized.startLng == null ? point.longitude : normalized.startLng,
                };
              }
            }
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
