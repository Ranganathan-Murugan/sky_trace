/**
 * SkyTrace - live worldwide flight tracker backend.
 *
 * Zero npm dependencies. Acts as a caching / normalising proxy in front of two
 * free ADS-B networks so the browser never hits them directly (avoids CORS and
 * keeps us inside the upstream rate limits no matter how many tabs are open):
 *
 *   adsb.lol   point + radius, max 250 NM. Rich fields (registration, type,
 *              squawk, emergency, category, military flag). Used when the map
 *              viewport is small enough - i.e. most of the time.
 *   OpenSky    arbitrary bounding box, worldwide. Used for wide / whole-world
 *              views. Anonymous access is credit limited, so responses are
 *              cached longer and credentials can be supplied via env vars.
 *
 * Positions alone do not say where a flight came from or is going, so two more
 * keyless services fill that in when an aircraft is selected:
 *
 *   adsbdb.com callsign -> airline + origin / destination airports (with name,
 *              city, country and coordinates), and ICAO24 -> operator, model
 *              and a photo.
 *   hexdb.io   fallback route lookup, plus airport metadata by ICAO code.
 *
 * Env:
 *   PORT                     default 8787
 *   HOST                     default 0.0.0.0 - every interface, so another
 *                            machine on your network can open it. Set to
 *                            127.0.0.1 to keep it to this machine only.
 *   ACCESS_TOKEN             optional shared secret. When set, every request
 *                            needs ?k=<token> once; the answer is a cookie.
 *                            Set this before exposing the instance publicly.
 *   TILE_CACHE_MB            disk budget for cached map tiles, default 600
 *   TILE_PROXY               "off" redirects tiles to the provider instead of
 *                            proxying them - saves a host's bandwidth, but
 *                            gives up offline maps
 *   CONTACT                  optional e-mail or URL sent in the User-Agent.
 *                            planespotters.net (aircraft photos) requires a
 *                            contactable User-Agent; set this if you expose
 *                            this instance to anyone but yourself.
 *   LOCAL_FEED_URL           optional tar1090 / readsb / dump1090 aircraft.json
 *                            (e.g. http://192.168.1.50/tar1090/data/aircraft.json).
 *                            Your own receiver has no rate limit, so anything it
 *                            hears is merged in and always wins.
 *   OPENSKY_CLIENT_ID        optional, from an OpenSky account (API client)
 *   OPENSKY_CLIENT_SECRET    optional
 *                            Both are read from a .env file if one exists.
 */

'use strict';

// Load .env if there is one, so credentials live in a private file rather than
// in the command line or the shell history. Node has this built in.
try {
  process.loadEnvFile();
} catch {
  /* no .env, or an older Node - env vars can still be passed directly */
}

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const PORT = Number(process.env.PORT || 8787);
/* Bound to every interface by default, so a second machine on the same network
 * can just open the URL - no install, no credentials, only a browser. Set
 * HOST=127.0.0.1 to keep it to this machine alone. */
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const ADSB_MAX_RADIUS_NM = 250;
// Below this radius the view is a single airport or a city's approach, and
// both feeds are queried and merged so nothing on the ground is missed.
const ADSB_UNION_RADIUS_NM = 45;
// ...but only feeds that can answer within this long are worth waiting for.
const UNION_WAIT_MS = 2500;   // hard upper bound of the adsb.lol endpoint
/* How many adsb.lol circles we are willing to sweep for one wide view.
 * Tiling is preferred wherever it is affordable, because only the point feeds
 * carry registration, model, operator and build year. OpenSky covers what is
 * too wide to tile - and with credentials it is also the safety net when a
 * sweep comes back incomplete. */
const ADSB_MAX_TILES_AUTHED = 6;
const ADSB_MAX_TILES_ANON = 8;
const TTL_ADSB = 5000;            // ms - feed itself updates about every second
const TTL_ADSB_TILED = 12000;     // a tiled sweep takes a few seconds to gather
const TTL_OPENSKY = 25000;        // with credentials, close to OpenSky's own rate
/* Without credentials OpenSky allows about 400 credits a day and a whole-world
 * request costs 4, so continuous polling is impossible. Rather than fail, the
 * world view becomes a periodically refreshed snapshot - honestly labelled in
 * the UI - which still fits inside the free quota. */
const TTL_OPENSKY_ANON = 300000;
const UPSTREAM_TIMEOUT = 15000;

const CONTACT = process.env.CONTACT || '';
/* Put the whole instance behind a shared secret. Unset - the normal case for
 * something on your own network - and nothing is gated at all. Set it before
 * putting this on a public URL, or your OpenSky quota is everyone's. */
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
/* Tiles are proxied and cached by default, which is what makes the map work
 * offline. On a host with a bandwidth allowance, "off" redirects the browser
 * to the tile provider instead, so none of it comes out of your quota. */
const TILE_PROXY = (process.env.TILE_PROXY || 'on').toLowerCase() !== 'off';
const UA = `SkyTrace/1.0 (self-hosted flight tracker; +${
  CONTACT ? (CONTACT.includes('@') ? 'mailto:' + CONTACT : CONTACT) : 'http://localhost:' + (process.env.PORT || 8787)
})`;

/* ------------------------------------------------------------------ util --- */

function nowMs() { return Date.now(); }

async function fetchJson(url, options = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), options.timeout || UPSTREAM_TIMEOUT);
  try {
    const res = await fetch(url, {
      ...options,
      signal: ctl.signal,
      headers: { 'User-Agent': UA, accept: 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`upstream ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = text.slice(0, 300);
      throw err;
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error('upstream sent non-JSON');
      err.body = text.slice(0, 200);
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------- upstream pacing ---
 * Every one of these feeds is free and rate limited, and a single browser tab
 * can generate a surprising number of lookups. Each upstream gets a minimum
 * spacing between requests, and a 429 puts it in a cooldown during which we do
 * not touch it at all (the caller falls back or serves cached data).           */

/* Each upstream is paced by an adaptive gap rather than a fixed one. A 429
 * widens the gap (multiplicatively), a success narrows it back towards the
 * floor, and only a run of consecutive refusals triggers a hard cooldown.
 * Measured starting points: adsb.lol sustains roughly one request every two
 * seconds; the others are far more relaxed. This self-tunes, which matters
 * because these services punish a burst for longer than their documented
 * limit suggests. */

function makeGate(minGap, maxGap) {
  return { minGap, maxGap, gap: minGap, next: 0, fails: 0, cooldownUntil: 0 };
}

const gates = {
  'adsb.lol': makeGate(2000, 10000),
  'adsb.fi': makeGate(2000, 10000),
  opensky: makeGate(1500, 30000),
  adsbdb: makeGate(600, 12000),
  hexdb: makeGate(600, 12000),
  auth: makeGate(1000, 10000),
  planespotters: makeGate(600, 15000),
  overpass: makeGate(1500, 60000),
  rainviewer: makeGate(2000, 30000),
  tiles: makeGate(0, 4000),
  metar: makeGate(800, 20000),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gated(name, fn) {
  const g = gates[name];
  const now = nowMs();
  if (g.cooldownUntil > now) {
    const err = new Error(`${name} is rate limited for another ${Math.ceil((g.cooldownUntil - now) / 1000)}s`);
    err.status = 429;
    err.cooldown = true;
    err.local = true;
    throw err;
  }

  // Reserve a slot so concurrent callers queue instead of all firing at once.
  const slot = Math.max(now, g.next);
  if (slot - now > 30000) {
    const err = new Error(`${name} request queue is full`);
    err.status = 429;
    err.local = true;
    throw err;
  }
  g.next = slot + g.gap;
  if (slot > now) await sleep(slot - now);

  try {
    const out = await fn();
    // Success: creep back towards the floor.
    g.fails = 0;
    g.gap = Math.max(g.minGap, Math.round(g.gap * 0.9));
    return out;
  } catch (e) {
    if (!e.local && (e.status === 429 || e.status === 503)) {
      g.fails++;
      g.gap = Math.min(g.maxGap, Math.round(g.gap * 1.35));
      g.next = nowMs() + g.gap;
      if (g.fails >= 4) {
        g.cooldownUntil = nowMs() + 30000;
        g.fails = 0;
        log('warn', `${name} refused 4 in a row - pausing it for 30s`);
      } else {
        log('warn', `${name} returned ${e.status} - slowing to one request every ${(g.gap / 1000).toFixed(1)}s`);
      }
    }
    throw e;
  }
}

const gateState = () =>
  Object.fromEntries(
    Object.entries(gates).map(([k, g]) => [
      k,
      {
        gapMs: g.gap,
        ...(g.cooldownUntil > nowMs() ? { pausedForSec: Math.ceil((g.cooldownUntil - nowMs()) / 1000) } : {}),
      },
    ])
  );

// Great-circle distance in nautical miles.
function distanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const M_TO_FT = 3.280839895;
const MS_TO_KT = 1.943844492;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round(v, dp) {
  return v === null || v === undefined ? null : Math.round(v * 10 ** dp) / 10 ** dp;
}

/* Strip null / false / absent members. On a whole-world OpenSky snapshot most
 * of the optional fields are empty, and this roughly halves the JSON. */
function compact(o) {
  for (const k in o) {
    const v = o[k];
    if (v === null || v === undefined || v === false || v === '') delete o[k];
  }
  return o;
}

/* --------------------------------------------------------------- normalise --- */
/**
 * Canonical aircraft shape sent to the browser. Short keys keep the payload
 * small - a whole-world OpenSky snapshot is 10-20k aircraft.
 *
 *   id  ICAO 24-bit address (hex, lowercase)   lat/lon degrees
 *   cs  callsign                               alt  barometric altitude, ft
 *   reg registration (tail number)             galt geometric altitude, ft
 *   typ ICAO type designator                   gs   ground speed, kt
 *   trk track / true heading, degrees          vs   vertical rate, ft/min
 *   sqk squawk        gnd on ground (bool)     cat  ADS-B emitter category
 *   mil military      emg emergency            src  which feed it came from
 *   nt  ground station / obstacle, not an aircraft
 *   seen seconds since the position was reported
 */

/* Two independent feeds speak the same tar1090 dialect. Alternating between
 * them roughly doubles the request budget, which is what keeps a wide tiled
 * sweep from running into rate limits. adsb.fi is preferred because its
 * records also carry the manufacturer, model, operator and build year. */
const POINT_PROVIDERS = [
  {
    name: 'adsb.fi',
    url: (la, lo, r) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${r}`,
    hex: (id) => `https://opendata.adsb.fi/api/v2/hex/${id}`,
  },
  {
    name: 'adsb.lol',
    url: (la, lo, r) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${r}`,
    hex: (id) => `https://api.adsb.lol/v2/hex/${id}`,
  },
];

/** Whichever feed can serve us soonest, then the other as a fallback. */
function providerOrder() {
  return [...POINT_PROVIDERS].sort((a, b) => {
    const ga = gates[a.name];
    const gb = gates[b.name];
    const availA = Math.max(ga.next, ga.cooldownUntil);
    const availB = Math.max(gb.next, gb.cooldownUntil);
    return availA - availB;
  });
}

/** Combined pace of the healthy point feeds, as an effective gap in ms. */
function pointFeedGap() {
  const now = nowMs();
  const rates = POINT_PROVIDERS.map((p) => gates[p.name])
    .filter((g) => g.cooldownUntil < now)
    .map((g) => 1 / g.gap);
  const total = rates.reduce((a, b) => a + b, 0);
  return total > 0 ? 1 / total : gates['adsb.lol'].maxGap;
}

async function fetchPoint(lat, lon, radiusNm) {
  const r = Math.max(1, Math.min(ADSB_MAX_RADIUS_NM, Math.ceil(radiusNm)));
  let lastErr;
  for (const p of providerOrder()) {
    try {
      stats.upstream[p.name] = (stats.upstream[p.name] || 0) + 1;
      const json = await gated(p.name, () => fetchJson(p.url(lat.toFixed(4), lon.toFixed(4), r)));
      return { aircraft: normaliseAdsb(json, p.name), source: p.name, radiusNm: r, fetchedAt: nowMs() };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no point feed available');
}

/* Zoomed into an airport, one feed is not enough. Aircraft parked on a stand
 * or rolling down a runway are only heard by receivers with line of sight to
 * the field itself, and the two aggregators have different ones - at Delhi,
 * adsb.fi reports the traffic on the apron while adsb.lol reports none of it.
 * A wide view can afford to alternate between the feeds; an airport view has
 * to ask both and merge, or the ramp looks empty. */
async function fetchPointUnion(lat, lon, radiusNm) {
  const r = Math.max(1, Math.min(ADSB_MAX_RADIUS_NM, Math.ceil(radiusNm)));

  // Only ask the feeds that can answer promptly. A feed in a rate-limit
  // cooldown would otherwise hold the whole request for up to half a minute
  // while the other one already has the answer in hand.
  const now = nowMs();
  const ready = POINT_PROVIDERS.filter((p) => {
    const g = gates[p.name];
    return Math.max(g.next, g.cooldownUntil) - now <= UNION_WAIT_MS;
  });
  // Nothing is ready: fall back to the ordinary single-feed path, which waits
  // for whichever gate opens first rather than returning an empty map.
  if (!ready.length) return fetchPoint(lat, lon, radiusNm);

  const results = await Promise.allSettled(
    ready.map(async (p) => {
      stats.upstream[p.name] = (stats.upstream[p.name] || 0) + 1;
      const json = await gated(p.name, () => fetchJson(p.url(lat.toFixed(4), lon.toFixed(4), r)));
      return { aircraft: normaliseAdsb(json, p.name), source: p.name };
    })
  );

  const ok = results.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!ok.length) {
    throw results[0].reason || new Error('no point feed available');
  }

  const byId = new Map();
  for (const part of ok) {
    for (const a of part.aircraft) {
      const prev = byId.get(a.id);
      // Same airframe from both feeds: keep whichever report is fresher, but
      // never lose the make/model/operator fields only adsb.fi carries.
      if (!prev) byId.set(a.id, a);
      else if ((a.seen ?? 99) < (prev.seen ?? 99)) byId.set(a.id, { ...prev, ...a });
      else byId.set(a.id, { ...a, ...prev });
    }
  }

  return {
    aircraft: [...byId.values()],
    source: ok.length > 1 ? 'adsb.fi+adsb.lol' : ok[0].source,
    radiusNm: r,
    fetchedAt: nowMs(),
  };
}

function normaliseAdsb(json, source) {
  const out = [];
  const list = (json && (json.ac || json.aircraft)) || [];
  for (const a of list) {
    const lat = num(a.lat);
    const lon = num(a.lon);
    if (lat === null || lon === null) continue;
    const onGround = a.alt_baro === 'ground';
    // Some receivers pad an unset callsign field with '@' or '?'; that is not
    // a callsign, and showing it as one is worse than showing nothing.
    const raw = (a.flight || '').trim();
    const cs = /[A-Z0-9]/i.test(raw.replace(/[^A-Z0-9]/gi, '')) ? raw.replace(/[^A-Z0-9-]/gi, '') : '';
    // "Non-transponder" ADS-B emitters are not flights: airport surveillance
    // towers, ground obstacles and surface vehicles broadcast on the same
    // frequencies and would otherwise show up parked on every apron.
    const station = a.type === 'adsb_icao_nt' || (a.t || '').trim() === 'TWR';
    out.push(compact({
      id: String(a.hex || '').toLowerCase().replace(/^~/, ''),
      cs: cs || null,
      reg: (a.r || '').trim() || null,
      typ: (a.t || '').trim() || null,
      lat: round(lat, 5),
      lon: round(lon, 5),
      alt: onGround ? 0 : num(a.alt_baro),
      galt: num(a.alt_geom),
      gs: round(num(a.gs), 1),
      trk: round(num(a.track) ?? num(a.true_heading) ?? num(a.mag_heading), 1),
      vs: num(a.baro_rate) ?? num(a.geom_rate),
      sqk: a.squawk || null,
      gnd: onGround,
      nt: station,
      cat: a.category || null,
      mil: Boolean(a.dbFlags & 1),
      emg: a.emergency && a.emergency !== 'none' ? a.emergency : null,
      seen: round(num(a.seen_pos) ?? num(a.seen), 1),
      // adsb.fi ships these; adsb.lol does not. They identify an airframe
      // without any further lookup.
      desc: (a.desc || '').trim() || null,
      op: (a.ownOp || '').trim() || null,
      yr: a.year ? String(a.year).trim() : null,
      src: source || 'adsb.lol',
    }));
  }
  return out;
}

function normaliseOpenSky(json) {
  const out = [];
  const list = (json && json.states) || [];
  for (const s of list) {
    const lat = num(s[6]);
    const lon = num(s[5]);
    if (lat === null || lon === null) continue;
    const onGround = Boolean(s[8]);
    const baroM = num(s[7]);
    const geoM = num(s[13]);
    const cs = (s[1] || '').trim();
    const seen = num(s[3]) ? Math.max(0, Math.round(Date.now() / 1000 - s[3])) : null;
    out.push(compact({
      id: String(s[0] || '').toLowerCase(),
      cs: cs || null,
      reg: null,
      typ: null,
      lat: round(lat, 5),
      lon: round(lon, 5),
      alt: onGround ? 0 : baroM === null ? null : Math.round(baroM * M_TO_FT),
      galt: geoM === null ? null : Math.round(geoM * M_TO_FT),
      gs: num(s[9]) === null ? null : Math.round(s[9] * MS_TO_KT),
      trk: round(num(s[10]), 1),
      vs: num(s[11]) === null ? null : Math.round(s[11] * M_TO_FT * 60),
      sqk: s[14] || null,
      gnd: onGround,
      cat: null,
      mil: false,
      emg: null,
      seen,
      ctry: s[2] || null,
      src: 'opensky',
    }));
  }
  return out;
}

/* ------------------------------------------------------------- opensky auth --- */

const OPENSKY_ID = process.env.OPENSKY_CLIENT_ID || '';
const OPENSKY_SECRET = process.env.OPENSKY_CLIENT_SECRET || '';
const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

let tokenCache = { value: null, expires: 0, pending: null };

async function openskyToken() {
  if (!OPENSKY_ID || !OPENSKY_SECRET) return null;
  if (tokenCache.value && tokenCache.expires > nowMs() + 30000) return tokenCache.value;
  if (tokenCache.pending) return tokenCache.pending;

  tokenCache.pending = (async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: OPENSKY_ID,
      client_secret: OPENSKY_SECRET,
    });
    const j = await gated('auth', () => fetchJson(TOKEN_URL, {
      method: 'POST',
      body: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }));
    tokenCache.value = j.access_token;
    tokenCache.expires = nowMs() + (j.expires_in || 1800) * 1000;
    return tokenCache.value;
  })();

  try {
    return await tokenCache.pending;
  } catch (e) {
    log('warn', 'opensky auth failed: ' + e.message);
    return null;
  } finally {
    tokenCache.pending = null;
  }
}

/* ------------------------------------------------------- cache / singleflight --- */

const cache = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> Promise

/** Cache with single-flight de-duplication. A produced value may carry its own
 *  `_ttl`, which wins over the caller's default - a confirmed route is good for
 *  hours, a transient lookup failure for seconds. */
async function cached(key, ttl, producer) {
  const hit = cache.get(key);
  if (hit && nowMs() - hit.at < (hit.value._ttl || ttl)) return { ...hit.value, cached: true };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const value = await producer();
      cache.set(key, { at: nowMs(), value, ttl: value._ttl || ttl });
      return value;
    } catch (err) {
      // Serve stale data rather than nothing - a rate-limited upstream should
      // not blank the map.
      if (hit) return { ...hit.value, stale: true, warning: err.message };
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}

// Keep the cache from growing without bound (each viewport is its own key).
setInterval(() => {
  const now = nowMs();
  for (const [k, v] of cache) if (now - v.at > Math.max(120000, (v.ttl || 0) * 2)) cache.delete(k);
}, 60000).unref();

/* ------------------------------------------------------------- flight fetch --- */

const stats = { requests: 0, upstream: { 'adsb.fi': 0, 'adsb.lol': 0, opensky: 0 }, errors: 0, started: nowMs() };

async function fetchOpenSky(bbox) {
  const [lamin, lomin, lamax, lomax] = bbox;
  const qs = new URLSearchParams({
    lamin: lamin.toFixed(4),
    lomin: lomin.toFixed(4),
    lamax: lamax.toFixed(4),
    lomax: lomax.toFixed(4),
  });
  const headers = {};
  const token = await openskyToken();
  if (token) headers.authorization = `Bearer ${token}`;
  stats.upstream.opensky++;
  const json = await gated('opensky', () =>
    fetchJson(`https://opensky-network.org/api/states/all?${qs}`, { headers })
  );
  return {
    aircraft: normaliseOpenSky(json),
    source: 'opensky',
    authed: Boolean(token),
    fetchedAt: nowMs(),
    feedTime: json && json.time ? json.time : null,
  };
}

/**
 * Cover a bounding box with adsb.lol query circles.
 *
 * The point-and-radius endpoint caps out at 250 NM, which only covers a
 * regional view. Anything wider used to go to OpenSky, whose anonymous quota
 * (400 credits/day, 3-4 per wide request) is exhausted within minutes of
 * continuous polling. Several adsb.lol circles are cheaper and far more
 * detailed, so tile the viewport instead and only fall back to OpenSky when
 * the box is so large that tiling stops being reasonable.
 */
function tileCover(lamin, lomin, lamax, lomax) {
  // A circle of radius R fully covers a square of side R*sqrt(2).
  const stepNm = ADSB_MAX_RADIUS_NM * 1.41;
  const stepLat = stepNm / 60;

  const nLat = Math.max(1, Math.ceil((lamax - lamin) / stepLat));
  const dLat = (lamax - lamin) / nLat;
  const tiles = [];

  for (let i = 0; i < nLat; i++) {
    const lat = lamin + dLat * (i + 0.5);
    const cos = Math.max(0.12, Math.cos((lat * Math.PI) / 180));
    const stepLon = stepLat / cos;
    const nLon = Math.max(1, Math.ceil((lomax - lomin) / stepLon));
    const dLon = (lomax - lomin) / nLon;

    for (let j = 0; j < nLon; j++) {
      const lon = lomin + dLon * (j + 0.5);
      // Radius that reaches this cell's corner, with a little overlap.
      const halfLatNm = (dLat / 2) * 60;
      const halfLonNm = (dLon / 2) * 60 * cos;
      const r = Math.min(ADSB_MAX_RADIUS_NM, Math.hypot(halfLatNm, halfLonNm) * 1.06 + 2);
      tiles.push({ lat, lon, r });
    }
  }
  return tiles;
}

/**
 * Shrink a bounding box around its centre until it can be covered by at most
 * `maxTiles` circles. Used when the wide-area feed is unavailable: a smaller
 * area of live, complete data beats an empty map, as long as the UI says the
 * coverage is partial.
 */
function shrinkToFit(lamin, lomin, lamax, lomax, maxTiles) {
  const clat = (lamin + lamax) / 2;
  const clon = (lomin + lomax) / 2;
  let halfLat = (lamax - lamin) / 2;
  let halfLon = (lomax - lomin) / 2;

  for (let i = 0; i < 14; i++) {
    const box = [clat - halfLat, clon - halfLon, clat + halfLat, clon + halfLon];
    const tiles = tileCover(...box);
    if (tiles.length <= maxTiles) return { box, tiles };
    halfLat *= 0.72;
    halfLon *= 0.72;
  }
  const box = [clat - halfLat, clon - halfLon, clat + halfLat, clon + halfLon];
  return { box, tiles: tileCover(...box).slice(0, maxTiles) };
}

/** Gather several adsb.lol circles into one de-duplicated snapshot. */
async function fetchAdsbTiled(tiles) {
  const attempt = (t) =>
    fetchPoint(t.lat, t.lon, t.r).catch((e) => {
      t.error = e.message;
      return null;
    });

  let parts = await mapLimit(tiles, 2, attempt);

  // adsb.lol refuses the odd request even at a paced rate, and the sweep has
  // slack before its next refresh, so give the failures one more go.
  const retry = tiles.filter((t, i) => !parts[i]);
  if (retry.length && retry.length < tiles.length && pointFeedGap() <= 1600) {
    log('warn', `retrying ${retry.length}/${tiles.length} adsb.lol tiles (${retry[0].error})`);
    const second = await mapLimit(retry, 1, attempt);
    let k = 0;
    parts = parts.map((p, i) => (p ? p : second[k++]));
  }

  const ok = parts.filter(Boolean);
  if (!ok.length) throw new Error(`every adsb.lol tile failed (${tiles[0].error || 'unknown'})`);

  const byId = new Map();
  for (const part of ok) {
    for (const a of part.aircraft) {
      // Overlapping circles return the same aircraft; keep the freshest report.
      const prev = byId.get(a.id);
      if (!prev || (a.seen ?? 99) < (prev.seen ?? 99)) byId.set(a.id, a);
    }
  }
  return {
    aircraft: [...byId.values()],
    source: ok[0].source,
    fetchedAt: nowMs(),
    tiles: tiles.length,
    coverage:
      ok.length < tiles.length
        ? `${ok.length} of ${tiles.length} areas - the rest were rate limited`
        : null,
  };
}

/**
 * Pick a feed for the requested viewport and return normalised aircraft.
 * adsb.lol is preferred (more fields, faster refresh); OpenSky covers anything
 * larger than a 250 NM radius. Each falls back to the other on failure.
 */
async function getFlights(bbox) {
  let [lamin, lomin, lamax, lomax] = bbox;
  lamin = Math.max(-90, lamin);
  lamax = Math.min(90, lamax);

  const clat = (lamin + lamax) / 2;
  const clon = (lomin + lomax) / 2;
  const spansWorld = lomax - lomin >= 355 || lamax - lamin >= 175;
  const radiusNm = spansWorld
    ? Infinity
    : distanceNm(clat, clon, lamax, lomax) || distanceNm(clat, clon, lamax, clon);

  // One circle for a regional view, a handful of circles for a wide one, and
  // only OpenSky when the box is bigger than tiling can sensibly handle.
  if (!spansWorld && radiusNm <= ADSB_MAX_RADIUS_NM) {
    const union = radiusNm <= ADSB_UNION_RADIUS_NM;
    const key = `adsb:${union ? 'u:' : ''}${clat.toFixed(2)}:${clon.toFixed(2)}:${Math.ceil(radiusNm)}`;
    return cached(key, TTL_ADSB, async () => {
      try {
        return union
          ? await fetchPointUnion(clat, clon, radiusNm)
          : await fetchPoint(clat, clon, radiusNm);
      } catch (e) {
        log('warn', `adsb.lol failed (${e.message}), falling back to OpenSky`);
        return await fetchOpenSky([lamin, lomin, lamax, lomax]);
      }
    });
  }

  // Budget the sweep against the pace the limiter has settled on: if adsb.lol
  // is currently slow, a many-tile sweep could not finish before it is stale,
  // so use OpenSky for this view instead of starting a doomed sweep.
  const gap = pointFeedGap();
  const affordable = Math.max(1, Math.floor(45000 / gap));
  const maxTiles = Math.min(
    OPENSKY_ID && OPENSKY_SECRET ? ADSB_MAX_TILES_AUTHED : ADSB_MAX_TILES_ANON,
    affordable
  );
  const tiles = spansWorld ? [] : tileCover(lamin, lomin, lamax, lomax);
  if (tiles.length > 1 && tiles.length <= maxTiles) {
    const key = `tiled:${lamin.toFixed(1)}:${lomin.toFixed(1)}:${lamax.toFixed(1)}:${lomax.toFixed(1)}`;
    // Leave headroom: the sweep itself takes ~2.5s per tile at the paced rate.
    const ttl = Math.max(TTL_ADSB_TILED, Math.round(tiles.length * pointFeedGap() * 1.5 + 3000));
    return cached(key, ttl, async () => {
      try {
        const swept = await fetchAdsbTiled(tiles);
        // A complete sweep is the richest data available. An incomplete one is
        // worse than OpenSky's plainer but whole picture - so when we have
        // credentials, prefer completeness.
        if (swept.coverage && OPENSKY_ID && OPENSKY_SECRET) {
          log('info', `sweep incomplete (${swept.coverage}), using OpenSky for full coverage`);
          try {
            return await fetchOpenSky([lamin, lomin, lamax, lomax]);
          } catch {
            return swept; // partial live data still beats nothing
          }
        }
        return swept;
      } catch (e) {
        log('warn', `tiled sweep failed (${e.message}), falling back to OpenSky`);
        return await fetchOpenSky([lamin, lomin, lamax, lomax]);
      }
    });
  }

  const key = `osky:${lamin.toFixed(1)}:${lomin.toFixed(1)}:${lamax.toFixed(1)}:${lomax.toFixed(1)}`;
  const oskyTtl = OPENSKY_ID && OPENSKY_SECRET ? TTL_OPENSKY : TTL_OPENSKY_ANON;
  return cached(key, oskyTtl, async () => {
    try {
      return await fetchOpenSky([lamin, lomin, lamax, lomax]);
    } catch (e) {
      // OpenSky is out of credits or down. Sweep as much of the middle of the
      // view as the live feeds can cover - a partial map, clearly labelled,
      // is far more use than an empty one.
      log('warn', `OpenSky failed (${e.message}), sweeping the centre with the live feeds instead`);
      try {
        const { box, tiles: centre } = shrinkToFit(lamin, lomin, lamax, lomax, maxTiles);
        const r = await fetchAdsbTiled(centre);
        const spanKm = Math.round(distanceNm(box[0], box[1], box[2], box[3]) * 1.852);
        return {
          ...r,
          coverage: `the middle ~${spanKm} km of this view — the wide-area feed is unavailable`,
        };
      } catch (inner) {
        log('warn', `centre sweep also failed: ${inner.message}`);
        throw e;
      }
    }
  });
}

/* ------------------------------------------------------------------ photos --- */

const TTL_PHOTO = 7 * 24 * 3600 * 1000;
const TTL_PHOTO_MISS = 6 * 3600 * 1000;

/**
 * A real photograph of the actual airframe, from planespotters.net.
 * Their terms require the photographer to be credited and the photo to link
 * back to its page, so both come back with the image and the UI shows them.
 */
async function fetchPhoto(hex, reg) {
  const id = String(hex || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
  const tail = String(reg || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const urls = [];
  if (id.length === 6) urls.push(`https://api.planespotters.net/pub/photos/hex/${id}`);
  if (tail) urls.push(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(tail)}`);
  if (!urls.length) return { photo: null, _ttl: TTL_PHOTO_MISS };

  for (const url of urls) {
    try {
      const j = await gated('planespotters', () => fetchJson(url));
      const ph = j && j.photos && j.photos[0];
      if (!ph) continue;
      return {
        photo: compact({
          thumb: (ph.thumbnail && ph.thumbnail.src) || null,
          large: (ph.thumbnail_large && ph.thumbnail_large.src) || (ph.thumbnail && ph.thumbnail.src) || null,
          link: ph.link || null,
          photographer: ph.photographer || null,
          credit: 'planespotters.net',
        }),
        _ttl: TTL_PHOTO,
      };
    } catch (e) {
      if (e.status !== 404 && !e.cooldown) log('warn', `planespotters ${id || tail}: ${e.message}`);
    }
  }
  return { photo: null, _ttl: TTL_PHOTO_MISS };
}

/* -------------------------------------------------------------- local feed --- */

/* If you run your own ADS-B receiver (an RTL-SDR with dump1090 / readsb /
 * tar1090), point LOCAL_FEED_URL at its aircraft.json. It is on your own
 * network, so there is no quota and no pacing: it is polled every second and
 * its reports override the public feeds, which are always a little behind. */
const LOCAL_FEED_URL = process.env.LOCAL_FEED_URL || '';
let localFeedWarned = false;

async function fetchLocalFeed() {
  if (!LOCAL_FEED_URL) return null;
  try {
    return await cached('local', 1000, async () => {
      const json = await fetchJson(LOCAL_FEED_URL, { timeout: 4000 });
      return { aircraft: normaliseAdsb(json, 'local'), source: 'local', fetchedAt: nowMs() };
    });
  } catch (e) {
    if (!localFeedWarned) {
      log('warn', `local feed ${LOCAL_FEED_URL} unreachable: ${e.message}`);
      localFeedWarned = true;
    }
    return null;
  }
}

/** Overlay whatever the local receiver can hear onto a network snapshot. */
function mergeLocal(result, local, bbox) {
  if (!local || !local.aircraft.length) return result;
  const [lamin, lomin, lamax, lomax] = bbox;
  const inView = local.aircraft.filter(
    (a) => a.lat >= lamin && a.lat <= lamax && a.lon >= lomin && a.lon <= lomax
  );
  if (!inView.length) return result;

  const byId = new Map(result.aircraft.map((a) => [a.id, a]));
  for (const a of inView) byId.set(a.id, a); // the receiver is the fresher source
  return { ...result, aircraft: [...byId.values()], localCount: inView.length };
}

/* ------------------------------------------------------------------- routes --- */

const TTL_ROUTE = 12 * 3600 * 1000;        // routes are stable for a given callsign
const TTL_ROUTE_MISS = 45 * 60 * 1000;     // "no such callsign" is worth remembering
const TTL_SOFT_FAIL = 20 * 1000;           // a network blip is not
const TTL_AIRPORT = 30 * 24 * 3600 * 1000;
const TTL_ACDB = 24 * 3600 * 1000;

function normaliseAirport(a) {
  if (!a) return null;
  return compact({
    iata: a.iata_code || null,
    icao: a.icao_code || null,
    name: a.name || null,
    city: a.municipality || null,
    country: a.country_name || null,
    iso: a.country_iso_name || null,
    lat: num(a.latitude),
    lon: num(a.longitude),
    elev: num(a.elevation),
  });
}

function normaliseHexdbAirport(a) {
  if (!a || !a.icao) return null;
  return compact({
    iata: a.iata || null,
    icao: a.icao || null,
    name: a.airport || null,
    city: a.region_name || null,
    iso: a.country_code || null,
    lat: num(a.latitude),
    lon: num(a.longitude),
  });
}

function airportByIcao(code) {
  const icao = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (icao.length < 3) return Promise.resolve(null);
  return cached(`ap:${icao}`, TTL_AIRPORT, async () => {
    try {
      const j = await gated('hexdb', () => fetchJson(`https://hexdb.io/api/v1/airport/icao/${icao}`));
      return { airport: normaliseHexdbAirport(j), _ttl: TTL_AIRPORT };
    } catch {
      return { airport: null, _ttl: TTL_SOFT_FAIL };
    }
  }).then((r) => r.airport);
}

/**
 * Resolve a callsign to airline + origin / destination.
 * adsbdb.com first (full airport records), hexdb.io as the fallback - it
 * returns bare ICAO codes like "EGLL-KJFK", which we then expand.
 */
async function fetchRoute(callsign) {
  const cs = String(callsign).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cs.length < 3) return { route: null, _ttl: TTL_ROUTE_MISS };

  let hardMiss = false;
  try {
    const j = await gated('adsbdb', () => fetchJson(`https://api.adsbdb.com/v0/callsign/${cs}`));
    const fr = j && j.response && j.response.flightroute;
    if (fr && fr.origin && fr.destination) {
      const origin = normaliseAirport(fr.origin);
      const destination = normaliseAirport(fr.destination);
      return {
        route: compact({
          callsign: fr.callsign || cs,
          iata: fr.callsign_iata || null,
          airline: fr.airline
            ? compact({
                name: fr.airline.name,
                icao: fr.airline.icao,
                iata: fr.airline.iata,
                country: fr.airline.country,
                iso: fr.airline.country_iso,
                radio: fr.airline.callsign,
              })
            : null,
          origin,
          destination,
          via: fr.midpoint ? [normaliseAirport(fr.midpoint)] : null,
          distanceKm: routeDistanceKm(origin, destination, fr.midpoint && normaliseAirport(fr.midpoint)),
          source: 'adsbdb.com',
        }),
        _ttl: TTL_ROUTE,
      };
    }
  } catch (e) {
    if (e.status === 404) hardMiss = true;
    else if (!e.cooldown) log('warn', `adsbdb route ${cs}: ${e.message}`);
  }

  try {
    const h = await gated('hexdb', () => fetchJson(`https://hexdb.io/api/v1/route/icao/${cs}`));
    if (h && typeof h.route === 'string' && h.route.includes('-')) {
      const codes = h.route.split('-').map((c) => c.trim()).filter(Boolean);
      const airports = await Promise.all(codes.map(airportByIcao));
      const origin = airports[0];
      const destination = airports[airports.length - 1];
      if (origin && destination) {
        const via = airports.slice(1, -1).filter(Boolean);
        return {
          route: compact({
            callsign: cs,
            origin,
            destination,
            via: via.length ? via : null,
            distanceKm: routeDistanceKm(origin, destination, via[0]),
            source: 'hexdb.io',
          }),
          _ttl: TTL_ROUTE,
        };
      }
    }
    hardMiss = true;
  } catch (e) {
    if (e.status === 404) hardMiss = true;
    else if (!e.cooldown) log('warn', `hexdb route ${cs}: ${e.message}`);
  }

  return { route: null, _ttl: hardMiss ? TTL_ROUTE_MISS : TTL_SOFT_FAIL };
}

function routeDistanceKm(a, b, via) {
  if (!a || !b || a.lat === undefined || b.lat === undefined) return null;
  const leg = (p, q) => distanceNm(p.lat, p.lon, q.lat, q.lon) * 1.852;
  const total = via && via.lat !== undefined ? leg(a, via) + leg(via, b) : leg(a, b);
  return Math.round(total);
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await worker(items[i]);
        } catch {
          out[i] = null;
        }
      }
    })
  );
  return out;
}

/** ICAO24 -> registration, model, operator and a photo. */
async function fetchAircraftDb(hex) {
  const id = String(hex).toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
  if (id.length !== 6) return { info: null, _ttl: TTL_ROUTE_MISS };
  try {
    const j = await gated('adsbdb', () => fetchJson(`https://api.adsbdb.com/v0/aircraft/${id}`));
    const ac = j && j.response && j.response.aircraft;
    if (!ac) return { info: null, _ttl: TTL_ROUTE_MISS };
    return {
      info: compact({
        reg: ac.registration || null,
        model: ac.type || null,
        icaoType: ac.icao_type || null,
        manufacturer: ac.manufacturer || null,
        owner: ac.registered_owner || null,
        ownerCountry: ac.registered_owner_country_name || null,
        ownerIso: ac.registered_owner_country_iso_name || null,
        operatorIcao: ac.registered_owner_operator_flag_code || null,
        photo: ac.url_photo_thumbnail || ac.url_photo || null,
        photoFull: ac.url_photo || null,
        source: 'adsbdb.com',
      }),
      _ttl: TTL_ACDB,
    };
  } catch (e) {
    return { info: null, _ttl: e.status === 404 ? TTL_ROUTE_MISS : TTL_SOFT_FAIL };
  }
}

/* ------------------------------------------------------------ single aircraft --- */

async function getAircraft(hex) {
  const id = String(hex).toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
  if (id.length !== 6) throw Object.assign(new Error('bad hex'), { status: 400 });
  return cached(`hex:${id}`, TTL_ADSB, async () => {
    let lastErr;
    for (const p of providerOrder()) {
      try {
        const json = await gated(p.name, () => fetchJson(p.hex(id)));
        return { aircraft: normaliseAdsb(json, p.name), source: p.name };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  });
}

/* ------------------------------------------------------------------- server --- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} [${level}] ${msg}`);
}

function sendJson(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const accepts = String(req.headers['accept-encoding'] || '');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  };
  if (body.length > 1024 && /\bgzip\b/.test(accepts)) {
    const gz = zlib.gzipSync(body, { level: 6 });
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
  } else {
    headers['content-length'] = body.length;
    res.writeHead(status, headers);
    res.end(body);
  }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${st.size}-${st.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache', // revalidate via etag - edits show up immediately
      etag,
    });
    fs.createReadStream(file).pipe(res);
  });
}

/**
 * How long the browser should wait before asking again. A tiled sweep needs
 * roughly a second per tile to gather politely, so a wide view refreshes more
 * slowly than a regional one - and the whole-world OpenSky view slowest of
 * all, because its anonymous quota is tiny.
 */
function nextPollMs(result) {
  if (result.source === 'opensky') {
    const ttl = OPENSKY_ID && OPENSKY_SECRET ? TTL_OPENSKY : TTL_OPENSKY_ANON;
    // Come back a little after the snapshot is due to be refreshed.
    const age = result.fetchedAt ? nowMs() - result.fetchedAt : 0;
    return Math.max(15000, ttl - age + 2000);
  }
  const tiles = result.tiles || 1;
  // A sweep costs one paced request per tile, so the refresh has to track the
  // gap the limiter has currently settled on.
  return tiles > 1
    ? Math.max(TTL_ADSB_TILED, Math.round(tiles * pointFeedGap() * 1.5 + 3000))
    : TTL_ADSB;
}

/* ------------------------------------------------------- airport layouts ---
 * Runways, taxiways, aprons, terminals and stands come from OpenStreetMap via
 * Overpass. An airport's concrete does not move, so a layout is fetched once
 * and then kept - in memory, and on disk so a restart does not ask again.    */

const TTL_LAYOUT = 90 * 24 * 3600 * 1000;
const TTL_LAYOUT_MISS = 6 * 3600 * 1000;
const LAYOUT_DIR = path.join(__dirname, '.cache', 'layouts');
const LAYOUT_KINDS = 'runway|taxiway|apron|terminal|helipad|parking_position|hangar';
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function layoutFile(key) {
  return path.join(LAYOUT_DIR, `${key}.json`);
}

function readLayoutFile(key) {
  try {
    const raw = fs.readFileSync(layoutFile(key), 'utf8');
    const saved = JSON.parse(raw);
    if (nowMs() - saved.at < TTL_LAYOUT) return saved.value;
  } catch {
    /* no cached copy, or an unreadable one - fetch it again */
  }
  return null;
}

function writeLayoutFile(key, value) {
  try {
    fs.mkdirSync(LAYOUT_DIR, { recursive: true });
    fs.writeFileSync(layoutFile(key), JSON.stringify({ at: nowMs(), value }));
  } catch (e) {
    log('warn', `could not cache layout ${key}: ${e.message}`);
  }
}

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS_MIRRORS) {
    try {
      return await gated('overpass', () =>
        fetchJson(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }).toString(),
          // Long enough for a big airport, short enough that a mirror which
          // has stopped answering does not hold the whole request hostage.
          timeout: 25000,
        })
      );
    } catch (e) {
      lastErr = e;
      log('warn', `overpass ${new URL(url).host}: ${e.message}`);
    }
  }
  throw lastErr;
}

/** The concrete at one airport, trimmed to what the map actually draws. */
async function fetchAirportLayout(lat, lon, radiusM) {
  const query =
    `[out:json][timeout:40];` +
    `(way["aeroway"~"^(${LAYOUT_KINDS})$"](around:${radiusM},${lat.toFixed(4)},${lon.toFixed(4)});` +
    `relation["aeroway"~"^(apron|terminal)$"](around:${radiusM},${lat.toFixed(4)},${lon.toFixed(4)}););` +
    `out geom;`;

  const json = await overpass(query);
  const features = [];
  for (const el of json.elements || []) {
    const kind = el.tags && el.tags.aeroway;
    if (!kind) continue;
    // Relations arrive as members with their own geometry; ways as one line.
    const rings = el.geometry
      ? [el.geometry]
      : (el.members || []).filter((m) => m.geometry).map((m) => m.geometry);
    for (const g of rings) {
      if (!g || g.length < 2) continue;
      const f = {
        k: kind,
        g: g.map((pt) => [round(pt.lat, 6), round(pt.lon, 6)]),
      };
      const ref = el.tags.ref || el.tags.name;
      if (ref) f.r = String(ref).slice(0, 24);
      const w = parseFloat(el.tags.width);
      if (Number.isFinite(w)) f.w = Math.round(w);
      if (el.tags.surface) f.s = el.tags.surface;
      features.push(f);
    }
  }
  return { features, count: features.length, fetchedAt: nowMs() };
}

async function getAirportLayout(lat, lon, radiusM) {
  const key = `${lat.toFixed(3)}_${lon.toFixed(3)}_${radiusM}`.replace(/[^0-9a-z_.-]/gi, '');
  const onDisk = readLayoutFile(key);
  if (onDisk) return { ...onDisk, cached: true };

  return cached(`layout:${key}`, TTL_LAYOUT, async () => {
    try {
      const value = await fetchAirportLayout(lat, lon, radiusM);
      writeLayoutFile(key, value);
      return value;
    } catch (e) {
      log('warn', `airport layout ${key}: ${e.message}`);
      // Remember the failure briefly so a broken Overpass is not hammered.
      return { features: [], count: 0, error: e.message, _ttl: TTL_LAYOUT_MISS };
    }
  });
}

/* -------------------------------------------------------------- weather ---
 * Two free, keyless sources. RainViewer publishes an index of global
 * precipitation radar frames, each one a tile set the browser loads straight
 * from their CDN - we only cache the index. NOAA's aviationweather.gov serves
 * METARs, the actual observation at an airport, already parsed.             */

const TTL_RADAR = 120000;          // frames are published every 10 minutes
const TTL_METAR = 5 * 60 * 1000;   // a METAR is issued hourly, amended rarely
const TTL_METAR_MISS = 10 * 60 * 1000;

async function getRadarIndex() {
  return cached('radar:index', TTL_RADAR, async () => {
    const json = await gated('rainviewer', () =>
      fetchJson('https://api.rainviewer.com/public/weather-maps.json')
    );
    const past = (json.radar && json.radar.past) || [];
    const nowcast = (json.radar && json.radar.nowcast) || [];
    return {
      host: json.host,
      generated: json.generated,
      // Oldest first, so the client can step through them as an animation.
      frames: [...past, ...nowcast].map((f) => ({ time: f.time, path: f.path })),
      nowcastFrom: nowcast.length ? nowcast[0].time : null,
    };
  });
}

/** METARs for up to 20 airports at once, by ICAO code. */
async function getMetars(ids) {
  const wanted = ids
    .map((x) => String(x).trim().toUpperCase())
    .filter((x) => /^[A-Z0-9]{4}$/.test(x))
    .slice(0, 20);
  if (!wanted.length) return {};

  const out = {};
  const missing = [];
  for (const id of wanted) {
    const hit = cache.get(`metar:${id}`);
    if (hit && nowMs() - hit.at < (hit.value._ttl || TTL_METAR)) out[id] = hit.value;
    else missing.push(id);
  }
  if (!missing.length) return out;

  let list = [];
  try {
    const json = await gated('metar', () =>
      fetchJson(
        `https://aviationweather.gov/api/data/metar?ids=${missing.join(',')}&format=json`
      )
    );
    list = Array.isArray(json) ? json : [];
  } catch (e) {
    log('warn', `metar ${missing.join(',')}: ${e.message}`);
  }

  for (const m of list) {
    const id = String(m.icaoId || '').toUpperCase();
    if (!id) continue;
    const value = compact({
      id,
      raw: m.rawOb || null,
      obs: m.obsTime || null,
      temp: num(m.temp),
      dewp: num(m.dewp),
      wdir: m.wdir === 'VRB' ? 'VRB' : num(m.wdir),
      wspd: num(m.wspd),
      wgst: num(m.wgst),
      // visib arrives as "10+" or a number of statute miles
      visib: m.visib === undefined || m.visib === null ? null : String(m.visib),
      altim: num(m.altim),
      cat: m.fltCat || null,
      name: m.name || null,
      clouds: Array.isArray(m.clouds)
        ? m.clouds.map((c) => compact({ cover: c.cover || null, base: num(c.base) })).slice(0, 6)
        : null,
    });
    out[id] = value;
    cache.set(`metar:${id}`, { at: nowMs(), value, ttl: TTL_METAR });
  }

  // Airports with no reporting station: remember the gap so we stop asking.
  for (const id of missing) {
    if (out[id]) continue;
    const value = { id, none: true, _ttl: TTL_METAR_MISS };
    out[id] = value;
    cache.set(`metar:${id}`, { at: nowMs(), value, ttl: TTL_METAR_MISS });
  }
  return out;
}

/* ------------------------------------------------------- who is watching ---
 * Which flights the people using *this* instance are looking at right now.
 * Each open tab sends a heartbeat naming the flight it has selected; a flight
 * is "being watched" while at least one heartbeat for it is fresh. Nothing is
 * stored beyond that - no history, no identity, just a hex and a timestamp in
 * memory that expires on its own.                                            */

const VIEW_TTL = 75000;        // a tab heartbeats every 25s; miss three and it is gone
const VIEW_MAX_SESSIONS = 500; // an upper bound so a stuck client cannot grow this

const viewers = new Map();     // sessionId -> { at, hex, label }

function pruneViewers() {
  const cut = nowMs() - VIEW_TTL;
  for (const [id, v] of viewers) if (v.at < cut) viewers.delete(id);
}

function recordView(sessionId, hex, label) {
  pruneViewers();
  if (!viewers.has(sessionId) && viewers.size >= VIEW_MAX_SESSIONS) return;
  viewers.set(sessionId, { at: nowMs(), hex: hex || null, label: label || null });
}

/** Flights ranked by how many tabs currently have them open. */
function popularFlights(limit = 10) {
  pruneViewers();
  const byHex = new Map();
  for (const v of viewers.values()) {
    if (!v.hex) continue;
    const e = byHex.get(v.hex) || { hex: v.hex, viewers: 0, label: null };
    e.viewers++;
    // Any watcher's label will do; they are all looking at the same aircraft.
    if (!e.label && v.label) e.label = v.label;
    byHex.set(v.hex, e);
  }
  return {
    online: viewers.size,
    watching: byHex.size,
    flights: [...byHex.values()].sort((a, b) => b.viewers - a.viewers).slice(0, limit),
  };
}

/* ------------------------------------------------------------- history ---
 * The live feeds only know about aircraft that are transmitting now. OpenSky
 * additionally keeps what has already happened: the legs an airframe has
 * flown, and the actual path of each one. That is what makes it possible to
 * follow a flight that landed hours ago.
 *
 * Two quirks of the upstream shape this code:
 *   - a flights query may not span more than two daily partitions, so a long
 *     window has to be asked for in day-sized pieces;
 *   - the arrival/departure tables are computed in arrears - a query for the
 *     last six hours comes back empty while one for yesterday is full.     */

const TTL_HISTORY = 6 * 3600 * 1000;
const TTL_TRACK = 7 * 24 * 3600 * 1000;  // a flown path never changes again
const HISTORY_LAG_H = 12;                // arrivals/departures are this far behind

async function openskyGet(pathAndQuery) {
  const token = await openskyToken();
  if (!token) {
    const e = new Error('history needs OpenSky credentials - see the README');
    e.status = 401;
    throw e;
  }
  return gated('opensky', () =>
    fetchJson(`https://opensky-network.org/api/${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  );
}

/** OpenSky answers "nothing found" with a 404; that is an empty list, not a fault. */
async function openskyList(pathAndQuery) {
  try {
    const j = await openskyGet(pathAndQuery);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

function tidyFlight(f) {
  return compact({
    hex: f.icao24 || null,
    cs: (f.callsign || '').trim() || null,
    from: f.estDepartureAirport || null,
    to: f.estArrivalAirport || null,
    dep: f.firstSeen || null,
    arr: f.lastSeen || null,
  });
}

/** Legs this airframe has flown recently, newest first. */
async function historyForAircraft(hex, hours) {
  const end = Math.floor(nowMs() / 1000);
  const begin = end - hours * 3600;
  return cached(`hist:${hex}:${hours}`, TTL_HISTORY, async () => {
    // Day-sized pieces, so no single query straddles more than two partitions.
    const spans = [];
    for (let from = begin; from < end; from += 86400) spans.push([from, Math.min(from + 86400, end)]);
    const parts = await mapLimit(spans, 1, ([b, e]) =>
      openskyList(`flights/aircraft?icao24=${hex}&begin=${b}&end=${e}`).catch(() => [])
    );
    // Adjacent day partitions return the same leg twice, a few seconds apart,
    // and often one copy is missing an end. Fold those together, keeping the
    // more complete record.
    const flights = [];
    for (const f of parts.flat().map(tidyFlight)) {
      const twin = flights.find(
        (g) => g.cs === f.cs && Math.abs((g.dep || 0) - (f.dep || 0)) < 180
      );
      if (!twin) {
        flights.push(f);
        continue;
      }
      const score = (x) => (x.from ? 1 : 0) + (x.to ? 1 : 0);
      if (score(f) > score(twin)) flights[flights.indexOf(twin)] = f;
    }
    flights.sort((a, b) => (b.dep || 0) - (a.dep || 0));
    return { hex, hours, flights, count: flights.length };
  });
}

/** The path one flight actually flew: [time, lat, lon, altFt, track]. */
async function trackFor(hex, time) {
  return cached(`track:${hex}:${time}`, TTL_TRACK, async () => {
    const j = await openskyGet(`tracks/all?icao24=${hex}&time=${time}`);
    const path = (j && j.path) || [];
    return {
      hex,
      cs: (j && j.callsign && j.callsign.trim()) || null,
      startTime: (j && j.startTime) || null,
      endTime: (j && j.endTime) || null,
      // [epoch, lat, lon, altitude m -> ft, true track]
      path: path
        .filter((p) => p[1] !== null && p[2] !== null)
        .map((p) => [p[0], round(p[1], 5), round(p[2], 5), p[3] === null ? null : Math.round(p[3] * 3.28084), p[4] === null ? null : Math.round(p[4])]),
      _ttl: path.length ? TTL_TRACK : 10 * 60 * 1000, // an empty answer may fill in later
    };
  });
}

/** Everything that landed at (or left) an airport in a window. */
async function airportHistory(kind, icao, hours) {
  const end = Math.floor(nowMs() / 1000) - HISTORY_LAG_H * 3600;
  const begin = end - hours * 3600;
  return cached(`apt-hist:${kind}:${icao}:${hours}`, TTL_HISTORY, async () => {
    const list = await openskyList(
      `flights/${kind}?airport=${icao}&begin=${begin}&end=${end}`
    );
    const flights = list.map(tidyFlight).sort((a, b) => (b.arr || 0) - (a.arr || 0));
    return { icao, kind, hours, windowEnd: end, lagHours: HISTORY_LAG_H, flights, count: flights.length };
  });
}

/* --------------------------------------------------------- map tiles -----
 * Basemap tiles normally come straight from Esri or OSM to the browser, which
 * means no internet, no map - even with a receiver of your own feeding live
 * positions. Proxying them through here and keeping a copy on disk fixes that:
 * anywhere you have already looked at keeps working offline, and repeat views
 * stop costing the tile servers anything.
 *
 * The client always asks for {z}/{x}/{y}; the order each provider wants is
 * this table's business, not the client's.                                  */

const TILE_DIR = path.join(__dirname, '.cache', 'tiles');
const TILE_CACHE_MB = Number(process.env.TILE_CACHE_MB || 600);
const TILE_SOURCES = {
  dark: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
  'dark-labels': (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/${z}/${y}/${x}`,
  light: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
  'light-labels': (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/${z}/${y}/${x}`,
  satellite: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  streets: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  terrain: (z, x, y) => `https://${'abc'[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`,
};

const tileStats = { hits: 0, misses: 0, written: 0, failed: 0, bytesSinceSweep: 0 };

function tilePath(style, z, x, y) {
  return path.join(TILE_DIR, style, String(z), String(x), `${y}.png`);
}

/** Keep the cache under its cap by dropping the least recently used tiles. */
function sweepTiles() {
  let files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try {
          const st = fs.statSync(full);
          files.push({ full, size: st.size, at: st.atimeMs || st.mtimeMs });
        } catch { /* vanished between readdir and stat */ }
      }
    }
  };
  walk(TILE_DIR);
  const total = files.reduce((a, f) => a + f.size, 0);
  const cap = TILE_CACHE_MB * 1024 * 1024;
  if (total <= cap) return { total, removed: 0 };

  files.sort((a, b) => a.at - b.at); // oldest touched first
  let freed = 0;
  let removed = 0;
  for (const f of files) {
    if (total - freed <= cap * 0.9) break;
    try { fs.unlinkSync(f.full); freed += f.size; removed++; } catch { /* ignore */ }
  }
  log('info', `tile cache swept: removed ${removed} tiles, ${(freed / 1048576).toFixed(0)} MB`);
  return { total: total - freed, removed };
}

async function serveTile(req, res, style, z, x, y) {
  const src = TILE_SOURCES[style];
  if (!src || ![z, x, y].every((v) => Number.isInteger(v) && v >= 0) || z > 20) {
    res.writeHead(404).end('no such tile');
    return;
  }
  if (!TILE_PROXY) {
    res.writeHead(302, { location: src(z, x, y), 'cache-control': 'public, max-age=86400' }).end();
    return;
  }
  const file = tilePath(style, z, x, y);

  // A tile already on disk is the whole point: instant, and it works with the
  // network unplugged.
  try {
    const buf = await fs.promises.readFile(file);
    tileStats.hits++;
    res.writeHead(200, {
      // Esri answers with JPEG, OSM with PNG, and both get stored under the
      // same name - so read the type off the bytes rather than the extension.
      'content-type': buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png',
      'content-length': buf.length,
      'cache-control': 'public, max-age=604800',
      'x-tile': 'disk',
    });
    res.end(buf);
    fs.promises.utimes(file, new Date(), new Date()).catch(() => {}); // mark as used
    return;
  } catch {
    /* not cached yet - fetch it below */
  }

  tileStats.misses++;
  try {
    const upstream = await gated('tiles', () =>
      fetch(src(z, x, y), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) })
    );
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') || 'image/png',
      'content-length': buf.length,
      'cache-control': 'public, max-age=604800',
      'x-tile': 'fetched',
    });
    res.end(buf);

    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, buf);
    tileStats.written++;
    tileStats.bytesSinceSweep += buf.length;
    if (tileStats.bytesSinceSweep > 40 * 1024 * 1024) {
      tileStats.bytesSinceSweep = 0;
      setImmediate(sweepTiles);
    }
  } catch (e) {
    tileStats.failed++;
    // Offline with nothing cached for this square: say so plainly rather than
    // serving a broken image.
    res.writeHead(504, { 'content-type': 'text/plain', 'x-tile': 'unavailable' });
    res.end('tile unavailable offline');
  }
}

/** Timing-safe-ish comparison; these are short strings, not password hashes. */
function sameToken(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(req, parsed, res) {
  if (!ACCESS_TOKEN) return true;
  const given = parsed.searchParams.get('k');
  if (given && sameToken(given, ACCESS_TOKEN)) {
    // Hand back a cookie so the token does not have to ride on every URL.
    res.setHeader(
      'set-cookie',
      `skytrace=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`
    );
    return true;
  }
  const cookie = /(?:^|;\s*)skytrace=([^;]+)/.exec(req.headers.cookie || '');
  return Boolean(cookie && sameToken(decodeURIComponent(cookie[1]), ACCESS_TOKEN));
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = parsed.pathname;

  // Liveness, for a platform's health check. Deliberately says nothing beyond
  // "the process is answering", so it can sit outside the access gate.
  if (p === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('ok');
    return;
  }

  if (!authorised(req, parsed, res)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('This SkyTrace instance is private. Append ?k=<access token> to the URL.\n');
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
    }).end();
    return;
  }

  if (p === '/api/flights') {
    stats.requests++;
    const q = parsed.searchParams;
    const bbox = ['lamin', 'lomin', 'lamax', 'lomax'].map((k) => Number(q.get(k)));
    if (bbox.some((v) => !Number.isFinite(v))) {
      sendJson(req, res, 400, { error: 'lamin, lomin, lamax and lomax are required' });
      return;
    }
    try {
      const [network, local] = await Promise.all([getFlights(bbox), fetchLocalFeed()]);
      const result = mergeLocal(network, local, bbox);
      sendJson(req, res, 200, {
        time: Math.floor(nowMs() / 1000),
        count: result.aircraft.length,
        source: result.source,
        cached: Boolean(result.cached),
        stale: Boolean(result.stale),
        warning: result.warning || null,
        authed: result.authed,
        tiles: result.tiles || 1,
        localCount: result.localCount || 0,
        nextPollMs: nextPollMs(result),
        ageSec: result.fetchedAt ? Math.round((nowMs() - result.fetchedAt) / 1000) : 0,
        quota: result.source === 'opensky' && !(OPENSKY_ID && OPENSKY_SECRET) ? 'anonymous' : null,
        pacingMs: Math.round(pointFeedGap()),
        coverage: result.coverage || null,
        aircraft: result.aircraft,
      });
    } catch (e) {
      stats.errors++;
      log('error', `flights ${e.status || ''} ${e.message} ${e.body || ''}`);
      sendJson(req, res, 502, {
        error: 'upstream unavailable',
        detail: e.message,
        hint:
          e.status === 429
            ? 'Rate limited. Zoom in (uses adsb.lol) or add OpenSky API credentials - see README.'
            : undefined,
      });
    }
    return;
  }

  // Basemap tiles, cached to disk so the map survives losing the internet.
  if (p.startsWith('/tiles/')) {
    const bits = p.slice('/tiles/'.length).split('/');
    if (bits.length === 4) {
      const [style, z, x, y] = bits;
      await serveTile(req, res, style, Number(z), Number(x), Number(y.replace(/\.png$/, '')));
      return;
    }
    res.writeHead(404).end('no such tile');
    return;
  }

  // What an airframe has flown recently, and the path of one of those legs.
  if (p === '/api/history/flights' || p === '/api/history/track' || p === '/api/history/airport') {
    const q = parsed.searchParams;
    try {
      if (p === '/api/history/flights') {
        const hex = String(q.get('hex') || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
        if (hex.length !== 6) { sendJson(req, res, 400, { error: 'hex is required' }); return; }
        const hours = Math.min(48, Math.max(1, Number(q.get('hours')) || 30));
        sendJson(req, res, 200, await historyForAircraft(hex, hours));
        return;
      }
      if (p === '/api/history/track') {
        const hex = String(q.get('hex') || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6);
        const time = Math.max(0, Math.floor(Number(q.get('time')) || 0));
        if (hex.length !== 6) { sendJson(req, res, 400, { error: 'hex is required' }); return; }
        sendJson(req, res, 200, await trackFor(hex, time));
        return;
      }
      const icao = String(q.get('icao') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      const kind = q.get('kind') === 'departure' ? 'departure' : 'arrival';
      if (icao.length !== 4) { sendJson(req, res, 400, { error: 'icao is required' }); return; }
      const hours = Math.min(24, Math.max(1, Number(q.get('hours')) || 12));
      sendJson(req, res, 200, await airportHistory(kind, icao, hours));
    } catch (e) {
      sendJson(req, res, e.status === 401 ? 401 : 502, { error: 'history unavailable', detail: e.message });
    }
    return;
  }

  // A tab saying "I am here, and this is what I have open".
  if (p === '/api/view' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 2000) req.destroy(); // nothing legitimate is this big
    });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const session = String(j.session || '').slice(0, 64);
        if (!session) {
          sendJson(req, res, 400, { error: 'session is required' });
          return;
        }
        const hex = j.hex ? String(j.hex).toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 6) : null;
        const label = j.label ? String(j.label).slice(0, 80) : null;
        recordView(session, hex || null, label);
        sendJson(req, res, 200, { ok: true });
      } catch {
        sendJson(req, res, 400, { error: 'invalid body' });
      }
    });
    return;
  }

  // What everyone on this instance is watching.
  if (p === '/api/popular') {
    sendJson(req, res, 200, { time: Math.floor(nowMs() / 1000), ...popularFlights(10) });
    return;
  }

  // Where the weather is: an index of global radar frames. The tiles
  // themselves are loaded by the browser straight from RainViewer's CDN.
  if (p === '/api/weather/radar') {
    try {
      sendJson(req, res, 200, await getRadarIndex());
    } catch (e) {
      sendJson(req, res, 502, { error: 'radar unavailable', detail: e.message });
    }
    return;
  }

  // What the weather actually is on the ground, per airport.
  if (p === '/api/metar') {
    const ids = (parsed.searchParams.get('ids') || '').split(',').filter(Boolean);
    if (!ids.length) {
      sendJson(req, res, 400, { error: 'ids (comma-separated ICAO codes) is required' });
      return;
    }
    try {
      sendJson(req, res, 200, { time: Math.floor(nowMs() / 1000), stations: await getMetars(ids) });
    } catch (e) {
      sendJson(req, res, 502, { error: 'metar unavailable', detail: e.message });
    }
    return;
  }

  // The concrete under the aircraft: runways, taxiways, aprons and stands.
  if (p === '/api/airport-layout') {
    const q = parsed.searchParams;
    const lat = Number(q.get('lat'));
    const lon = Number(q.get('lon'));
    const radiusM = Math.min(12000, Math.max(1000, Number(q.get('r')) || 6000));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      sendJson(req, res, 400, { error: 'lat and lon are required' });
      return;
    }
    try {
      const r = await getAirportLayout(lat, lon, radiusM);
      sendJson(req, res, 200, r);
    } catch (e) {
      sendJson(req, res, 502, { error: 'layout unavailable', detail: e.message });
    }
    return;
  }

  if (p.startsWith('/api/aircraft/')) {
    try {
      const r = await getAircraft(p.slice('/api/aircraft/'.length));
      sendJson(req, res, 200, { time: Math.floor(nowMs() / 1000), ...r });
    } catch (e) {
      sendJson(req, res, e.status === 400 ? 400 : 502, { error: e.message });
    }
    return;
  }

  // Routes for a batch of callsigns, so the map can label aircraft with their
  // origin and destination without the user clicking each one. Capped and
  // concurrency-limited to stay polite to the upstream databases; anything
  // already cached costs nothing.
  if (p === '/api/routes') {
    const list = [
      ...new Set(
        (parsed.searchParams.get('cs') || '')
          .split(',')
          .map((x) => x.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
          .filter((x) => x.length >= 3)
      ),
    ].slice(0, 30);
    if (!list.length) {
      sendJson(req, res, 400, { error: 'cs (comma-separated callsigns) is required' });
      return;
    }
    const routes = {};
    await mapLimit(list, 2, async (cs) => {
      const r = await cached(`route:${cs}`, TTL_ROUTE, () => fetchRoute(cs));
      routes[cs] = r.route || null;
    });
    sendJson(req, res, 200, { asked: list.length, routes });
    return;
  }

  // Route and operator details for one aircraft - looked up on selection or
  // hover, never for a whole viewport.
  if (p === '/api/details') {
    const hex = parsed.searchParams.get('hex') || '';
    const cs = parsed.searchParams.get('callsign') || '';
    if (!hex && !cs) {
      sendJson(req, res, 400, { error: 'hex or callsign is required' });
      return;
    }
    try {
      const reg = parsed.searchParams.get('reg') || '';
      const [r, a] = await Promise.all([
        cs ? cached(`route:${cs.toUpperCase()}`, TTL_ROUTE, () => fetchRoute(cs)) : { route: null },
        hex ? cached(`acdb:${hex.toLowerCase()}`, TTL_ACDB, () => fetchAircraftDb(hex)) : { info: null },
      ]);
      // The registration from the database is a better photo key than the one
      // the position feed guessed, so look the photo up once we have it.
      const tail = reg || (a.info && a.info.reg) || '';
      const ph =
        hex || tail
          ? await cached(`photo:${hex.toLowerCase()}:${tail}`, TTL_PHOTO, () => fetchPhoto(hex, tail))
          : { photo: null };
      sendJson(req, res, 200, {
        callsign: cs || null,
        hex: hex || null,
        route: r.route || null,
        info: a.info || null,
        photo: ph.photo || null,
        cached: Boolean(r.cached && a.cached),
      });
    } catch (e) {
      stats.errors++;
      sendJson(req, res, 502, { error: 'lookup failed', detail: e.message });
    }
    return;
  }

  if (p === '/api/health') {
    sendJson(req, res, 200, {
      ok: true,
      uptimeSec: Math.round((nowMs() - stats.started) / 1000),
      openskyCredentials: Boolean(OPENSKY_ID && OPENSKY_SECRET),
      localFeed: LOCAL_FEED_URL || null,
    private: Boolean(ACCESS_TOKEN),
    tileProxy: TILE_PROXY,
      cacheEntries: cache.size,
    tiles: { ...tileStats, cacheMb: TILE_CACHE_MB },
      upstreamPacing: gateState(),
      ...stats,
    });
    return;
  }

  serveStatic(req, res, p);
});

// If the port is taken, walk up a few numbers rather than dying - handy on a
// dev box that already has something on the default port.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && server.__tries === undefined) server.__tries = 0;
  if (err.code === 'EADDRINUSE' && server.__tries < 10) {
    const next = PORT + ++server.__tries;
    log('warn', `port ${next - 1} in use, trying ${next}`);
    setTimeout(() => server.listen(next), 120);
    return;
  }
  log('error', err.message);
  process.exit(1);
});

/** This machine's addresses on the networks it is actually attached to. */
function lanUrls(port) {
  const skip = /^(docker|br-|veth|virbr|lo)/;
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  const port = server.address().port;
  log('info', `SkyTrace listening on http://localhost:${port}`);
  if (ACCESS_TOKEN) log('info', 'ACCESS_TOKEN set - this instance is private; open it with ?k=<token>');
  if (!TILE_PROXY) log('info', 'TILE_PROXY=off - tiles redirect to the provider, offline maps are disabled');
  if (HOST === '0.0.0.0') {
    const urls = lanUrls(port);
    if (urls.length) {
      log('info', `on your network: ${urls.join('  ')} - open either from another machine`);
    }
  } else {
    log('info', `bound to ${HOST} only - this machine can reach it, others cannot`);
  }
  if (LOCAL_FEED_URL) log('info', `local receiver feed: ${LOCAL_FEED_URL}`);
  log(
    'info',
    OPENSKY_ID
      ? 'OpenSky credentials detected - wide-area views get the higher quota'
      : 'No OpenSky credentials - worldwide view uses the anonymous quota (zoom in for adsb.lol)'
  );
});
