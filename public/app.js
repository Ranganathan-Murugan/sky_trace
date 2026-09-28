/* SkyTrace - live flight tracker front end.
 *
 * Aircraft are drawn on a single <canvas> rather than as DOM markers: a
 * whole-world snapshot is 10-20k aircraft and one canvas keeps that at 60fps.
 * Between server polls each aircraft is dead-reckoned from its last reported
 * position, track and ground speed, so the map moves continuously instead of
 * jumping every few seconds. */

'use strict';

const REF = window.REF;

/* ─────────────────────────────── constants ─────────────────────────────── */

/* How often to re-poll, by which feed answered. A tiled sweep takes a few
 * seconds to gather, and OpenSky's anonymous quota cannot survive fast
 * polling of a whole-world view, so both are slowed down. */
const POLL_MS = { 'adsb.lol': 5000, 'adsb.lol-tiled': 10000, opensky: 30000 };
const STALE_DROP_S = 75;          // forget aircraft with no update for this long
const TRAIL_MAX_POINTS = 300;
const TRAIL_MAX_AGE_S = 40 * 60;
const HIT_RADIUS_PX = 15;

/* Altitude -> colour. The stops are deliberately not evenly spaced: most
 * traffic over a busy terminal area sits below 10 000 ft, so the low bands get
 * most of the colour range instead of all rendering as the same red. */
const ALT_STOPS = [
  [0, [255, 45, 85]], [2000, [255, 107, 61]], [5000, [255, 157, 46]],
  [10000, [247, 201, 72]], [20000, [168, 216, 74]], [30000, [61, 220, 132]],
  [40000, [53, 194, 245]], [50000, [125, 92, 255]],
];

const MAP_STYLES = {
  dark: {
    label: 'Dark',
    url: '/tiles/dark/{z}/{x}/{y}',
    labels: '/tiles/dark-labels/{z}/{x}/{y}',
    attribution: 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    bg: '#0b1017',
    maxNativeZoom: 16,
  },
  light: {
    label: 'Light',
    url: '/tiles/light/{z}/{x}/{y}',
    labels: '/tiles/light-labels/{z}/{x}/{y}',
    attribution: 'Basemap &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    bg: '#e8ecf0',
    maxNativeZoom: 16,
  },
  satellite: {
    label: 'Satellite',
    url: '/tiles/satellite/{z}/{x}/{y}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    bg: '#0a0d12',
    maxNativeZoom: 18,
  },
  streets: {
    label: 'Streets',
    url: '/tiles/streets/{z}/{x}/{y}',
    attribution: '&copy; OpenStreetMap contributors',
    bg: '#e9e5dc',
    maxNativeZoom: 19,
  },
  terrain: {
    label: 'Terrain',
    url: '/tiles/terrain/{z}/{x}/{y}',
    attribution: 'Map data &copy; OpenStreetMap, SRTM | Style &copy; OpenTopoMap (CC-BY-SA)',
    bg: '#dfe3d8',
    maxNativeZoom: 16,
  },
};

/* ──────────────────────────────── helpers ─────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function altColor(alt) {
  if (alt === null || alt === undefined) return '#8b98ab';
  const a = clamp(alt, 0, 50000);
  for (let i = 1; i < ALT_STOPS.length; i++) {
    if (a <= ALT_STOPS[i][0]) {
      const [a0, c0] = ALT_STOPS[i - 1];
      const [a1, c1] = ALT_STOPS[i];
      const t = (a - a0) / (a1 - a0);
      return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * t)},${Math.round(
        c0[1] + (c1[1] - c0[1]) * t
      )},${Math.round(c0[2] + (c1[2] - c0[2]) * t)})`;
    }
  }
  return 'rgb(125,92,255)';
}

/* The legend is generated from ALT_STOPS so the two can never drift apart. */
function buildLegend() {
  const n = ALT_STOPS.length - 1;
  const at = (i) => ((i / n) * 100).toFixed(2) + '%';
  document.querySelector('#legend .ramp').style.background =
    `linear-gradient(90deg, ${ALT_STOPS.map((st, i) => `rgb(${st[1].join(',')}) ${at(i)}`).join(', ')})`;
  const ticks = [0, 2, 3, 4, 5, 7]; // thinned so the labels cannot collide
  document.querySelector('#ramp-labels').innerHTML = ticks
    .map((i) => {
      const st = ALT_STOPS[i];
      return `<span style="left:${at(i)}">${st[0] === 0 ? '0' : st[0] / 1000 + 'k'}${i === n ? '+' : ''}</span>`;
    })
    .join('');
}

const nf = new Intl.NumberFormat('en-US');
const fmtNum = (v, unit = '') => (v === null || v === undefined ? '—' : nf.format(Math.round(v)) + unit);

function fmtAlt(a, gnd) {
  if (gnd) return 'ground';
  return a === null || a === undefined ? '—' : nf.format(Math.round(a)) + ' ft';
}

function fmtVs(v) {
  if (v === null || v === undefined) return '—';
  const r = Math.round(v / 10) * 10;
  if (Math.abs(r) < 60) return 'level';
  return (r > 0 ? '+' : '') + nf.format(r) + ' ft/min';
}

function fmtCoord(lat, lon) {
  const f = (v, [p, n]) => `${Math.abs(v).toFixed(4)}° ${v >= 0 ? p : n}`;
  return `${f(lat, 'NS')}, ${f(lon, 'EW')}`;
}

function ago(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 2) return 'just now';
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function bearingName(deg) {
  if (deg === null || deg === undefined) return '';
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Move a lat/lon along a bearing - used for dead reckoning between polls. */
function project(lat, lon, bearingDeg, distanceNm) {
  const R = 3440.065;
  const d = distanceNm / R;
  const br = (bearingDeg * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
  const lo2 =
    lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [(la2 * 180) / Math.PI, (((lo2 * 180) / Math.PI + 540) % 360) - 180];
}

/* Points along the great-circle path between two positions - the shortest
 * track an aircraft would actually fly, not a straight line on the map. */
function geodesic(from, to, steps = 72) {
  const R = Math.PI / 180, D = 180 / Math.PI;
  const f1 = from[0] * R, l1 = from[1] * R, f2 = to[0] * R, l2 = to[1] * R;
  const d =
    2 *
    Math.asin(
      Math.min(1, Math.sqrt(Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin((l2 - l1) / 2) ** 2))
    );
  if (!Number.isFinite(d) || d < 1e-9) return [from, to];
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const A = Math.sin((1 - t) * d) / Math.sin(d);
    const B = Math.sin(t * d) / Math.sin(d);
    const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2);
    const y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2);
    const z = A * Math.sin(f1) + B * Math.sin(f2);
    pts.push([Math.atan2(z, Math.hypot(x, y)) * D, Math.atan2(y, x) * D]);
  }
  return pts;
}

/* Keep longitudes continuous so a path crossing the antimeridian is drawn
 * across it instead of wrapping back around the world. */
function unwrapLons(pts) {
  const out = [pts[0]];
  let prev = pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    let lon = pts[i][1];
    while (lon - prev > 180) lon -= 360;
    while (prev - lon > 180) lon += 360;
    out.push([pts[i][0], lon]);
    prev = lon;
  }
  return out;
}

const kmBetween = (a, b) => L.latLng(a[0], a[1]).distanceTo(L.latLng(b[0], b[1])) / 1000;

function fmtDuration(mins) {
  if (mins === null || !Number.isFinite(mins) || mins < 0) return null;
  if (mins < 1) return 'less than a minute';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} m` : `${m} min`;
}

/* "AIRBUS A-320" -> "Airbus A-320". The feeds shout; the UI should not. */
function tidyModel(text) {
  return text.replace(/[A-Z][A-Z'-]{3,}/g, (w) => w[0] + w.slice(1).toLowerCase());
}

/**
 * Manufacturer and model for an aircraft. Our own type table is tidier where
 * it has an entry; the feed's own description covers everything else, which
 * matters for business jets and light aircraft.
 */
function modelOf(a) {
  return REF.typeName(a.typ) || (a.desc ? tidyModel(a.desc) : null) || a.typ || null;
}

/** Tail number and model, e.g. "N637JB · Airbus A-320". */
function identityOf(a) {
  const model = modelOf(a);
  return [a.reg, model].filter(Boolean).join(' · ') || null;
}

/* ──────────────────────────── airline logos ──────────────────────────── */

/* Real airline logos, by IATA code, from two free keyless CDNs: a square mark
 * for lists and map labels, and a wide white version for the dark detail card.
 * Both are plain <img> loads - nothing is proxied through the server. */
/* Two sources, tried in order: kiwi's square marks are the sharpest, and
 * daisycon covers the carriers kiwi is missing (cargo airlines, mostly). */
const LOGO_SOURCES = [
  (iata) => `https://images.kiwi.com/airlines/64x64/${iata}.png`,
  (iata) => `https://images.daisycon.io/airline/?width=64&height=64&iata=${iata}`,
];
const logoWide = (iata) => `https://images.daisycon.io/airline/?width=320&height=110&color=ffffff&iata=${iata}`;

/** An <img> that walks the source list and removes itself if none work. */
function logoImgHtml(iata, cls) {
  if (!iata) return '';
  const fallback = LOGO_SOURCES[1](iata);
  return `<img class="${cls}" src="${esc(LOGO_SOURCES[0](iata))}" data-fb="${esc(fallback)}" alt="" ` +
    `referrerpolicy="no-referrer" loading="lazy" ` +
    `onerror="if(this.dataset.fb){this.src=this.dataset.fb;this.dataset.fb='';}else{this.remove();}">`;
}

/** The airline's IATA code, from the resolved route or the local table. */
function airlineIata(a) {
  if (a.route && a.route.airline && a.route.airline.iata) return a.route.airline.iata;
  const air = REF.decodeCallsign(a.cs);
  return (air && air.iata) || null;
}

/* Logos drawn on the canvas need decoded images, so they are cached and the
 * map is redrawn once each one arrives. A failed load is remembered as null so
 * it is never requested twice. */
const logoImages = new Map();

function logoImage(iata) {
  if (!iata) return null;
  if (logoImages.has(iata)) return logoImages.get(iata);
  if (logoImages.size > 400) logoImages.clear();

  const img = new Image();
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  let source = 0;
  img.onload = () => draw();
  img.onerror = () => {
    source++;
    if (source < LOGO_SOURCES.length) img.src = LOGO_SOURCES[source](iata);
    else logoImages.set(iata, null);
  };
  img.src = LOGO_SOURCES[0](iata);
  logoImages.set(iata, img);
  return img;
}

const logoReady = (img) => img && img.complete && img.naturalWidth > 0;

/* ──────────────────────────────── the store ───────────────────────────── */

/** id -> aircraft record. `lat`/`lon` are the last *reported* position;
 *  `dlat`/`dlon` are the interpolated position currently on screen. */
const fleet = new Map();

const state = {
  facets: { airlines: new Set(), types: new Set(), classes: new Set(), airports: new Set() },
  selected: null,
  airport: null,
  follow: false,
  hover: null,
  style: localStorage.getItem('st.style') || 'dark',
  radar: localStorage.getItem('st.radar') === '1',
  history: null,      // a past flight's path, drawn on the map
  routeQuery: null,   // parsed "DEL → BOM" search, if the box holds one
  routeOnly: false,   // and whether the map is narrowed to it
  matches: new Set(), // everything the current search matched, highlit on the map
  colorByAlt: true,
  lastSource: null,
  filters: {
    altMin: 0, altMax: 60000, spdMin: 0,
    ground: true, mil: false, emg: false, labels: false, trails: true, smooth: true, route: true, airports: true, idline: true, logos: true, layout: true,
  },
};

/* On the ground, speed is the whole story: an airliner doing 60 kt is on its
 * take-off roll or braking after landing, one doing 12 kt is taxiing, and one
 * at rest is on a stand. Colouring those apart is what turns a grey blob over
 * an airport into a readable picture of the field. */
function groundColor(a) {
  if (a.nt) return '#8794a5'; // a tower or obstacle, not a flight
  const gs = a.gs ?? 0;
  if (gs >= 40) return '#ffd166'; // on a runway
  if (gs >= 3) return '#9fb3c8';  // taxiing
  return '#6d7d92';               // stopped
}

const TAXI_KT = 3;   // below this an aircraft is stopped, not moving
const RUNWAY_KT = 40; // above this it is on a take-off roll or landing rollout

function groundStatus(a) {
  const gs = a.gs ?? 0;
  if (gs >= RUNWAY_KT) return `on the runway \u00b7 ${Math.round(gs)} kt`;
  if (gs >= TAXI_KT) return `taxiing \u00b7 ${Math.round(gs)} kt`;
  return 'standing';
}

function isSpecialSquawk(sq) {
  return sq === '7500' || sq === '7600' || sq === '7700' || sq === '7777';
}

function passesFilter(a) {
  if (state.routeOnly && state.routeQuery && !matchesRoute(a, state.routeQuery)) return false;
  return passesBaseFilter(a) && passesFacets(a);
}

function passesBaseFilter(a) {
  const f = state.filters;
  if (!f.ground && a.gnd) return false;
  if (f.mil && !a.mil) return false;
  if (f.emg && !a.emg && !isSpecialSquawk(a.sqk)) return false;
  if (!a.gnd) {
    const alt = a.alt ?? 0;
    if (alt < f.altMin || alt > f.altMax) return false;
  }
  if (f.spdMin > 0 && (a.gs ?? 0) < f.spdMin) return false;
  return true;
}

/* ───────────────────────────────── the map ────────────────────────────── */

const map = L.map('map', {
  center: [25, 10],
  zoom: 3,
  minZoom: 2,
  maxZoom: 18,
  worldCopyJump: true,
  zoomControl: false,
  preferCanvas: true,
  attributionControl: true,
});
L.control.zoom({ position: 'bottomright' }).addTo(map);

let baseLayer = null;
let labelLayer = null;

function applyStyle(name) {
  const s = MAP_STYLES[name] || MAP_STYLES.dark;
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
  const tileOpts = {
    maxZoom: map.getMaxZoom(),
    maxNativeZoom: s.maxNativeZoom || 18,
    subdomains: s.url.includes('{s}') ? 'abc' : [],
    crossOrigin: true,
  };
  baseLayer = L.tileLayer(s.url, {
    ...tileOpts,
    attribution:
      s.attribution +
      ' | ADS-B: adsb.lol &amp; OpenSky Network' +
      ' | Airport layout: &copy; OpenStreetMap contributors (ODbL)',
  }).addTo(map);
  if (s.labels) {
    labelLayer = L.tileLayer(s.labels, { ...tileOpts, pane: 'shadowPane' }).addTo(map);
  }
  document.getElementById('map').style.background = s.bg;
  state.style = name;
  localStorage.setItem('st.style', name);
  document.querySelectorAll('.style-opt').forEach((el) => el.classList.toggle('on', el.dataset.style === name));
}

/* ───────────────────────── canvas aircraft layer ──────────────────────── */

const canvas = document.createElement('canvas');
canvas.id = 'aircraft-canvas';
Object.assign(canvas.style, {
  position: 'absolute', inset: '0', zIndex: '420', pointerEvents: 'none',
  transformOrigin: '0 0', willChange: 'transform',
});
map.getContainer().appendChild(canvas);
const ctx = canvas.getContext('2d');

let dpr = window.devicePixelRatio || 1;
let vw = 0, vh = 0;

function resizeCanvas() {
  const size = map.getSize();
  dpr = window.devicePixelRatio || 1;
  vw = size.x;
  vh = size.y;
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  canvas.style.width = vw + 'px';
  canvas.style.height = vh + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resizeCanvas();

/* A jet silhouette pointing "up" (north) in a 20x20 box centred on 0,0. */
const PLANE = new Path2D(
  'M0,-11.4 C0.9,-11.4 1.5,-9.9 1.6,-7.4 L1.7,-2.6 L10.6,2.5 L10.6,4.1 ' +
  'L1.7,1.4 L1.7,6.7 L4.3,9.1 L4.3,10.4 L0,9.1 L-4.3,10.4 L-4.3,9.1 ' +
  'L-1.7,6.7 L-1.7,1.4 L-10.6,4.1 L-10.6,2.5 L-1.7,-2.6 L-1.6,-7.4 ' +
  'C-1.5,-9.9 -0.9,-11.4 0,-11.4 Z'
);
const DOT = new Path2D('M0,-3 L3,0 L0,3 L-3,0 Z');
const VEHICLE = new Path2D('M-4,-3.4 h8 a1.4,1.4 0 0 1 1.4,1.4 v4 a1.4,1.4 0 0 1 -1.4,1.4 h-8 a1.4,1.4 0 0 1 -1.4,-1.4 v-4 a1.4,1.4 0 0 1 1.4,-1.4 Z');

/* Rotorcraft: rotor disc blades, a body and a tail boom. Drawn imperatively
 * because the blades are stroked while the body is filled. */
function drawHeli(color, sc) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3 / sc;
  ctx.beginPath();
  ctx.moveTo(-8.6, -8.6); ctx.lineTo(8.6, 8.6);
  ctx.moveTo(8.6, -8.6); ctx.lineTo(-8.6, 8.6);
  ctx.moveTo(0, 0); ctx.lineTo(0, 9);
  ctx.moveTo(-2.6, 9); ctx.lineTo(2.6, 9);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0.6, 3.1, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

const ROTOR_TYPES = new Set(['R44', 'R66', 'EC35', 'EC45', 'EC30', 'AS50', 'A139', 'A169', 'A189',
  'B06', 'B407', 'B412', 'B429', 'S76', 'S92', 'H60', 'A109', 'EC20', 'EC55', 'GAZL', 'H500']);

let hitList = [];   // {x, y, id} rebuilt each draw, for hover/click tests
let placedBoxes = []; // label rectangles already occupied this frame

function fits(box) {
  for (const q of placedBoxes) {
    if (box.x < q.x + q.w + 1 && box.x + box.w + 1 > q.x && box.y < q.y + q.h + 1 && box.y + box.h + 1 > q.y) {
      return false;
    }
  }
  placedBoxes.push(box);
  return true;
}
let zoomAnimating = false;

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  if (zoomAnimating) return;

  const zoom = map.getZoom();
  const forceLabels = state.filters.labels;
  // Zoomed in on a single field rather than looking at a region.
  const closeUp = zoom >= 11;
  const scale = clamp(0.36 + zoom * 0.062, 0.44, 1.28);
  // A search puts everything it did not match into the background, so the
  // handful you asked for is the only thing your eye lands on.
  const highlighting = state.matches.size > 0;
  const many = fleet.size > 2500;
  hitList = [];
  placedBoxes = [];
  const labels = [];

  // The concrete first, so aircraft sit on top of their own taxiways.
  drawAirportLayout();
  drawHistoryTrack();

  const sel = state.selected ? fleet.get(state.selected) : null;

  // Trail of the selected (and hovered) aircraft, drawn beneath the icons.
  if (state.filters.trails) {
    for (const a of [sel, state.hover && state.hover !== state.selected ? fleet.get(state.hover) : null]) {
      if (a && a.trail && a.trail.length > 1) drawTrail(a, a === sel);
    }
  }

  drawAirports();

  const bounds = map.getBounds().pad(0.08);

  for (const a of fleet.values()) {
    if (!passesFilter(a)) continue;
    const lat = a.dlat ?? a.lat;
    const lon = a.dlon ?? a.lon;
    if (lat < bounds.getSouth() || lat > bounds.getNorth()) continue;

    const p = map.latLngToContainerPoint([lat, lon]);
    if (p.x < -30 || p.x > vw + 30 || p.y < -30 || p.y > vh + 30) continue;

    const isSel = a.id === state.selected;
    const isHov = a.id === state.hover;
    const isMatch = highlighting && state.matches.has(a.id);
    const faded = highlighting && !isMatch && !isSel && !isHov;
    const special = a.emg || isSpecialSquawk(a.sqk);
    const color = special
      ? '#ff4d5e'
      : a.gnd
        ? groundColor(a)
        : a.mil
          ? '#3ddc84'
          : state.colorByAlt
            ? altColor(a.alt)
            : '#f2f6fc';

    hitList.push({ x: p.x, y: p.y, id: a.id });

    ctx.save();
    ctx.translate(p.x, p.y);
    if (faded) ctx.globalAlpha = 0.26;

    if (isMatch && !isSel) {
      ctx.beginPath();
      ctx.arc(0, 0, 13, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(53,194,245,.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(53,194,245,.9)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    if (isSel || isHov) {
      ctx.beginPath();
      ctx.arc(0, 0, isSel ? 19 : 15, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? 'rgba(247,201,72,.16)' : 'rgba(255,255,255,.1)';
      ctx.fill();
      ctx.strokeStyle = isSel ? 'rgba(247,201,72,.85)' : 'rgba(255,255,255,.35)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    if (special && !a.gnd) {
      const pulse = 0.4 + 0.35 * Math.sin(performance.now() / 260);
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,77,94,${pulse.toFixed(2)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.rotate(((a.trk ?? 0) * Math.PI) / 180);
    // In dot mode keep a floor on the size so targets stay visible at world zoom.
    const dotMode = many && !isSel && !isHov;
    const s = dotMode
      ? Math.max(scale, 0.62)
      : (isSel ? scale * 1.25 : scale) *
        (a.cat === 'A5' ? 1.2 : 1) *
        // Aircraft on a stand are parked wingtip to wingtip; drawn at full
        // size they merge into one shape, so give the apron some air.
        (a.gnd && !isSel && !isHov ? 0.82 : 1);
    ctx.scale(s, s);

    ctx.fillStyle = color;
    if (a.cat === 'A7' || (a.typ && ROTOR_TYPES.has(a.typ))) {
      drawHeli(color, s);
    } else if ((a.cat && a.cat[0] === 'C') || a.nt) {
      // Airport service vehicles / fixed obstructions broadcast on the same
      // frequencies - show them as boxes so they read as "not an aircraft".
      ctx.fillStyle = '#9aa7b8';
      ctx.fill(VEHICLE);
    } else if (dotMode) {
      ctx.fill(DOT);
    } else {
      ctx.fill(PLANE);
      ctx.strokeStyle = isSel ? 'rgba(0,0,0,.6)' : 'rgba(0,0,0,.42)';
      ctx.lineWidth = (isSel ? 1 : 0.7) / s;
      ctx.stroke(PLANE);
    }
    ctx.restore();

    // Drawn, but not labelled - it is not what was asked for. (The canvas
    // state was already restored above; do not pop it a second time.)
    if (faded) continue;

    if (!many || isSel || isHov || isMatch) {
      // Aircraft parked on a stand sit a few pixels apart. A three-line label
      // for each would leave room for about four of them, so they get a single
      // small chip instead and the whole apron stays identifiable.
      const chip = closeUp && a.gnd && (a.gs ?? 0) < TAXI_KT && !isSel && !isHov;
      labels.push({
        chip,
        x: p.x, y: p.y, isSel, isHov,
        txt: a.cs || a.reg || a.id.toUpperCase(),
        // Second line: where this flight started and where it ends.
        route: chip
          ? null
          : a.route
            ? `${a.route.origin.iata || a.route.origin.icao} \u2192 ${
                a.route.destination.iata || a.route.destination.icao
              }`
            : // A taxiing aircraft usually has no route yet, so the second line
              // says what it is doing on the field instead.
              closeUp && a.gnd
              ? groundStatus(a)
              : null,
        gnd: a.gnd,
        // Third line: the airframe itself - tail number, make and model.
        ident: !chip && state.filters.idline && (zoom >= 8 || isSel || isHov) ? identityOf(a) : null,
        logo: !chip && state.filters.logos && (zoom >= 8 || isSel || isHov) ? airlineIata(a) : null,
        // Zoomed into a field, what is standing on it is the subject of the
        // view - so ground traffic outranks the airliners crossing overhead,
        // and whatever is moving outranks whatever is parked. Otherwise a busy
        // apron ends up as a row of unlabelled shapes.
        rank:
          (isSel ? 1e9 : 0) +
          (isHov ? 1e8 : 0) +
          (isMatch ? 8e7 : 0) +
          (closeUp && a.gnd ? 5e7 + Math.min(a.gs ?? 0, 400) * 1e4 : 0) +
          (a.route ? 3e7 : 0) +
          (a.alt ?? 0),
      });
    }
  }

  drawLabels(labels, forceLabels);
}

/* Place callsign labels, dropping any that would overlap one already drawn.
 * Selected and hovered aircraft win, then the highest traffic. */
function drawLabels(labels, force) {
  labels.sort((a, b) => b.rank - a.rank);
  ctx.textBaseline = 'alphabetic';

  // In a quiet view everything gets a label. In a busy one, label the flights
  // whose route is known - a callsign with "AGP -> EXT" under it is worth the
  // pixels, a bare registration is not - and cap how many are placed so a
  // terminal area does not become a wall of text. Overlaps are dropped below.
  const dense = !force && labels.length > 220;
  const budget = force ? labels.length : dense ? 150 : labels.length;
  let drawn = 0;

  for (const l of labels) {
    const pinned = l.isSel || l.isHov;
    if (!pinned && dense && !l.route && !l.chip) continue;
    if (!pinned && drawn >= budget) continue;
    ctx.font = `${l.isSel ? '600 12px' : l.chip ? '10px' : '11px'} ui-monospace, ui-sans-serif, monospace`;
    const widths = [ctx.measureText(l.txt).width];
    ctx.font = '10px ui-monospace, ui-sans-serif, monospace';
    if (l.route) widths.push(ctx.measureText(l.route).width);
    if (l.ident) widths.push(ctx.measureText(l.ident).width);

    const lines = 1 + (l.route ? 1 : 0) + (l.ident ? 1 : 0);
    const img = l.logo ? logoImage(l.logo) : null;
    const logoW = logoReady(img) ? 20 : 0;
    const w = Math.max(...widths) + (l.chip ? 6 : 8) + logoW;
    const h = l.chip ? 13 : 3 + lines * 12;
    const box = { x: l.x + (l.chip ? 8 : 11), y: l.y - h / 2, w, h };

    if (pinned) placedBoxes.push(box);
    else if (!fits(box)) continue;
    drawn++;

    ctx.fillStyle = l.isSel ? 'rgba(9,13,19,.92)' : l.chip ? 'rgba(9,13,19,.66)' : 'rgba(9,13,19,.74)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    if (l.isSel) {
      ctx.strokeStyle = 'rgba(247,201,72,.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    }
    if (logoW) {
      const side = Math.min(16, h - 4);
      ctx.drawImage(img, box.x + 3, box.y + (h - side) / 2, side, side);
    }

    const tx = box.x + (l.chip ? 3 : 4) + logoW;
    let y = box.y + (l.chip ? 10 : 11);
    ctx.font = `${l.isSel ? '600 12px' : l.chip ? '10px' : '11px'} ui-monospace, ui-sans-serif, monospace`;
    ctx.fillStyle = l.isSel
      ? '#f7c948'
      : l.isHov
        ? '#fff'
        : l.chip
          ? 'rgba(198,210,226,.82)'
          : 'rgba(232,237,245,.9)';
    ctx.fillText(l.txt, tx, y);

    ctx.font = '10px ui-monospace, ui-sans-serif, monospace';
    if (l.route) {
      y += 12;
      ctx.fillStyle = l.isSel
        ? 'rgba(255,233,163,.95)'
        : l.gnd
          ? 'rgba(168,184,203,.9)'
          : 'rgba(53,194,245,.92)';
      ctx.fillText(l.route, tx, y);
    }
    if (l.ident) {
      y += 12;
      ctx.fillStyle = l.isSel ? 'rgba(255,255,255,.85)' : 'rgba(168,184,203,.85)';
      ctx.fillText(l.ident, tx, y);
    }
  }
}

function drawTrail(a, isSelected) {
  const pts = a.trail;
  ctx.save();
  ctx.lineWidth = isSelected ? 2.4 : 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const p0 = map.latLngToContainerPoint([pts[i - 1][0], pts[i - 1][1]]);
    const p1 = map.latLngToContainerPoint([pts[i][0], pts[i][1]]);
    if (Math.abs(p1.x - p0.x) > vw * 0.6) continue; // antimeridian jump
    const fade = 0.18 + 0.72 * (i / pts.length);
    ctx.beginPath();
    ctx.strokeStyle = state.colorByAlt
      ? altColor(pts[i][2]).replace('rgb(', 'rgba(').replace(')', `,${fade.toFixed(2)})`)
      : `rgba(247,201,72,${fade.toFixed(2)})`;
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
  // leading edge to the aircraft's current interpolated position
  if (a.dlat !== undefined) {
    const last = pts[pts.length - 1];
    const p0 = map.latLngToContainerPoint([last[0], last[1]]);
    const p1 = map.latLngToContainerPoint([a.dlat, a.dlon]);
    if (Math.abs(p1.x - p0.x) < vw * 0.6) {
      ctx.beginPath();
      ctx.strokeStyle = isSelected ? 'rgba(247,201,72,.95)' : 'rgba(255,255,255,.5)';
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* Zoom animation: transform the whole canvas so icons zoom with the tiles,
 * then redraw once at the new zoom level. Uses only public Leaflet APIs. */
function onZoomAnim(e) {
  const size = map.getSize();
  const scale = map.getZoomScale(e.zoom, map.getZoom());
  const newOrigin = map.project(e.center, e.zoom).subtract(size.divideBy(2));
  const topLeftLatLng = map.containerPointToLatLng([0, 0]);
  const n0 = map.project(topLeftLatLng, e.zoom).subtract(newOrigin);
  canvas.style.transform = `translate(${n0.x}px,${n0.y}px) scale(${scale})`;
}

map.on('move', draw);
map.on('zoomanim', onZoomAnim);
map.on('zoomstart', () => { zoomAnimating = true; });
map.on('zoomend', () => {
  zoomAnimating = false;
  canvas.style.transform = '';
  draw();
});
map.on('resize', () => { resizeCanvas(); draw(); });
map.on('moveend', () => { schedulePoll(0); syncHash(); });

/* ─────────────────────────────── airports ─────────────────────────────── */




/* ──────────────────────── what everyone is watching ────────────────────
 * A live board of the flights the people using this instance have open. It
 * counts *these* viewers - you, and whoever else has the page open on your
 * network - not the world. Each tab sends a heartbeat naming the flight it
 * has selected; the server keeps nothing but a hex and a timestamp, and
 * forgets a tab that stops reporting. */

const HEARTBEAT_MS = 25000;
const POPULAR_MS = 15000;

/* One identity per tab, so two windows count as two viewers and closing the
 * tab forgets it. sessionStorage can throw in a locked-down browser. */
const viewerId = (() => {
  try {
    let id = sessionStorage.getItem('st.viewer');
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('st.viewer', id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2);
  }
})();

function heartbeat() {
  const a = state.selected ? fleet.get(state.selected) : null;
  const body = JSON.stringify({
    session: viewerId,
    hex: a ? a.id : null,
    label: a ? [a.cs || a.reg || a.id.toUpperCase(), modelOf(a)].filter(Boolean).join(' \u00b7 ') : null,
  });
  fetch('/api/view', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {
    /* the board is a nicety - never let it surface as an error */
  });
}

let popularData = null;

async function refreshPopular() {
  try {
    const r = await fetch('/api/popular');
    if (!r.ok) return;
    popularData = await r.json();
  } catch {
    return;
  }
  renderPopular();
}

function renderPopular() {
  const body = $('#watch-body');
  if (!body || !popularData) return;
  const { online, flights } = popularData;

  const head = `<div class="wl-head">
    <b>${online}</b> ${online === 1 ? 'person has' : 'people have'} this open right now
  </div>`;

  if (!flights.length) {
    body.innerHTML =
      head +
      `<div class="wl-empty">Nobody has a flight selected. Pick one on the map and it
       appears here — for everyone else looking too.</div>`;
    return;
  }

  const top = flights[0].viewers;
  body.innerHTML =
    head +
    flights
      .map((f, i) => {
        const a = fleet.get(f.hex);
        // Identity on its own line - it is what you are looking for, and it
        // must not be the thing that gets truncated.
        const label = a
          ? a.cs || a.reg || f.hex.toUpperCase()
          : (f.label || f.hex.toUpperCase()).split(' \u00b7 ')[0];
        const iata = a ? airlineIata(a) : null;
        const leg =
          a && a.route
            ? `${a.route.origin.iata || a.route.origin.icao} \u2192 ${a.route.destination.iata || a.route.destination.icao}`
            : null;
        const model = a ? modelOf(a) : (f.label || '').split(' \u00b7 ')[1] || null;
        const route = [leg, model].filter(Boolean).join(' \u00b7 ') || null;
        return `<div class="wl-row${a ? '' : ' gone'}" data-id="${esc(f.hex)}" role="button" tabindex="0">
          <span class="wl-rank">${i + 1}</span>
          ${iata ? logoImgHtml(iata, 'wl-logo') : '<span class="wl-logo"></span>'}
          <span class="wl-main">
            <span class="wl-name">${esc(label)}</span>
            ${route ? `<span class="wl-route">${esc(route)}</span>` : ''}
            ${a ? '' : '<span class="wl-route">not in this view</span>'}
          </span>
          <span class="wl-count" title="${f.viewers} watching">
            <i style="width:${Math.round((f.viewers / top) * 100)}%"></i>
            <b>${f.viewers}</b>
          </span>
        </div>`;
      })
      .join('');

  body.querySelectorAll('.wl-row').forEach((row) => {
    row.onclick = () => {
      const a = fleet.get(row.dataset.id);
      if (!a) {
        note('That flight is not in the area you are looking at — pan to it or zoom out.');
        return;
      }
      map.setView([a.dlat ?? a.lat, a.dlon ?? a.lon], Math.max(map.getZoom(), 8));
      select(a.id);
    };
  });
}

/* ────────────────────────── precipitation radar ───────────────────────
 * RainViewer publishes global radar as tile sets, one per ten-minute frame.
 * The server caches the index of frames; the tiles themselves come straight
 * from their CDN. Drawn under the aircraft, over the basemap.             */

const RADAR_COLOUR = 4;       // RainViewer's palette 4 - green / yellow / red
const RADAR_REFRESH_MS = 300000;
let radarIndex = null;
let radarLayer = null;
let radarTimer = null;

function radarUrl(frame) {
  // {host}{path}/{tileSize}/{z}/{x}/{y}/{colour}/{smooth}_{snow}.png
  return `${radarIndex.host}${frame.path}/256/{z}/{x}/{y}/${RADAR_COLOUR}/1_1.png`;
}

/** The most recent observed frame - never a forecast one, which would be a
 *  different claim than "this is where the rain is". */
function latestObserved() {
  if (!radarIndex || !radarIndex.frames.length) return null;
  const cut = radarIndex.nowcastFrom;
  const observed = cut ? radarIndex.frames.filter((f) => f.time < cut) : radarIndex.frames;
  return (observed.length ? observed : radarIndex.frames).at(-1);
}

async function refreshRadar() {
  try {
    const r = await fetch('/api/weather/radar');
    if (!r.ok) throw new Error(r.statusText);
    radarIndex = await r.json();
  } catch (e) {
    console.warn('radar index:', e.message);
    return null;
  }
  return latestObserved();
}

function radarStamp(frame) {
  if (!frame) return '';
  const d = new Date(frame.time * 1000);
  const mins = Math.max(0, Math.round((Date.now() - frame.time * 1000) / 60000));
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return mins < 1 ? `${t} · just now` : `${t} · ${mins} min ago`;
}

function paintRadar(frame) {
  if (!frame) return;
  if (radarLayer) map.removeLayer(radarLayer);
  radarLayer = L.tileLayer(radarUrl(frame), {
    opacity: 0.62,
    maxZoom: map.getMaxZoom(),
    // RainViewer's free tiles stop at zoom 7 - and above it they serve a
    // "Zoom Level Not Supported" placeholder rather than a 404, so Leaflet
    // cannot detect the gap by itself. Upscale the last real level instead,
    // which is honest anyway: radar resolution is about a kilometre.
    maxNativeZoom: 7,
    zIndex: 300,                // over the basemap, under the aircraft canvas
    attribution: 'Radar &copy; <a href="https://www.rainviewer.com/">RainViewer</a>',
  }).addTo(map);
  const el = $('#radar-time');
  if (el) el.textContent = radarStamp(frame);
}

async function setRadar(on) {
  state.radar = on;
  localStorage.setItem('st.radar', on ? '1' : '0');
  const box = $('#f-radar');
  if (box) box.checked = on;
  $('#radar-meta').hidden = !on;

  clearInterval(radarTimer);
  radarTimer = null;

  if (!on) {
    if (radarLayer) map.removeLayer(radarLayer);
    radarLayer = null;
    return;
  }

  $('#radar-time').textContent = 'loading…';
  paintRadar(await refreshRadar());
  radarTimer = setInterval(async () => {
    if (!state.radar) return;
    paintRadar(await refreshRadar());
  }, RADAR_REFRESH_MS);
}

/* ─────────────────────────── airport weather ──────────────────────────
 * A METAR is the actual observation at the field: wind, visibility, cloud
 * base, temperature and pressure, plus the flight category those add up to. */

const metars = new Map(); // ICAO -> station record
const FLIGHT_CATS = {
  VFR: ['#3ddc84', 'Clear enough to fly visually'],
  MVFR: ['#35c2f5', 'Marginal — cloud or visibility reduced'],
  IFR: ['#ff9f45', 'Instrument conditions'],
  LIFR: ['#ff4d5e', 'Low instrument conditions'],
};

async function fetchMetar(icao) {
  if (!icao || metars.has(icao)) return metars.get(icao);
  metars.set(icao, 'loading');
  try {
    const r = await fetch(`/api/metar?ids=${icao}`);
    const j = await r.json();
    metars.set(icao, (j.stations && j.stations[icao]) || { id: icao, none: true });
  } catch {
    metars.set(icao, { id: icao, none: true });
  }
  if (state.airport && state.airport.icao === icao) renderAirport();
  return metars.get(icao);
}

/** Statute miles as reported, in the units a European pilot would read. */
function fmtVisibility(v) {
  if (v === null || v === undefined) return null;
  const plus = String(v).includes('+');
  const sm = parseFloat(String(v));
  if (!Number.isFinite(sm)) return String(v);
  const km = sm * 1.609;
  // NOAA caps its reports at "6+" statute miles, which is the METAR's 9999 -
  // ten kilometres or more. Rounding that to 9.7 would read as a measurement.
  if (plus) return `${Math.ceil(km)} km+`;
  return `${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} km`;
}

function fmtWind(m) {
  if (m.wspd === null || m.wspd === undefined) return null;
  if (m.wspd === 0) return 'calm';
  const gust = m.wgst ? ` gusting ${m.wgst}` : '';
  if (m.wdir === 'VRB' || m.wdir === null || m.wdir === undefined) {
    return `variable ${m.wspd}${gust} kt`;
  }
  return `${String(m.wdir).padStart(3, '0')}° ${bearingName(m.wdir)} ${m.wspd}${gust} kt`;
}

const CLOUD_WORDS = { SKC: 'clear', CLR: 'clear', FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast' };

function fmtClouds(m) {
  if (!m.clouds || !m.clouds.length) return null;
  const parts = m.clouds
    .filter((c) => c.cover)
    .map((c) => {
      const word = CLOUD_WORDS[c.cover] || c.cover.toLowerCase();
      return c.base ? `${word} at ${nf.format(c.base)} ft` : word;
    });
  return parts.length ? parts.join(', ') : null;
}

function weatherBlock(ap) {
  if (!ap.icao) return '';
  const m = metars.get(ap.icao);
  if (m === undefined) {
    fetchMetar(ap.icao);
    return '<div class="wx wx-wait">Fetching the weather at this airport…</div>';
  }
  if (m === 'loading') return '<div class="wx wx-wait">Fetching the weather at this airport…</div>';
  if (m.none) {
    return '<div class="wx wx-wait">No weather station reporting for this airport.</div>';
  }

  const [colour, meaning] = FLIGHT_CATS[m.cat] || ['#8b98ab', 'Conditions not classified'];
  const rows = [
    ['Wind', fmtWind(m)],
    ['Visibility', fmtVisibility(m.visib)],
    ['Cloud', fmtClouds(m)],
    [
      'Temperature',
      m.temp === null || m.temp === undefined
        ? null
        : `${Math.round(m.temp)}°C${m.dewp !== null && m.dewp !== undefined ? ` · dew point ${Math.round(m.dewp)}°C` : ''}`,
    ],
    ['Pressure', m.altim ? `${Math.round(m.altim)} hPa` : null],
  ].filter((r) => r[1]);

  const age = m.obs ? ago((Date.now() - m.obs * 1000) / 1000) : null;

  return `<div class="wx">
    <div class="wx-head">
      ${m.cat ? `<span class="wx-cat" style="--cat:${colour}">${esc(m.cat)}</span>` : ''}
      <span class="wx-meaning">${esc(meaning)}</span>
      ${age ? `<span class="wx-age">${esc(age)}</span>` : ''}
    </div>
    <div class="wx-grid">
      ${rows.map(([k, v]) => `<div><label>${k}</label><b>${esc(v)}</b></div>`).join('')}
    </div>
    ${m.raw ? `<div class="wx-raw">${esc(m.raw)}</div>` : ''}
  </div>`;
}

/* ─────────────────────── the airport on the ground ─────────────────────
 * Zoomed in on a field, the basemap shows a grey blank where the airport is.
 * These are its actual runways, taxiways, aprons, terminals and stands, from
 * OpenStreetMap, so an aircraft you can see taxiing is on a taxiway you can
 * see too. The server fetches each layout once and keeps it; the client keeps
 * the pixel projection until the zoom changes, so redrawing costs an add. */

const LAYOUT_ZOOM = 12;          // below this an airport is a dot, not a place
const LAYOUT_RADIUS_M = 6000;
const layouts = new Map();       // airport key -> { features } | 'loading' | 'none'

function layoutKeyOf(ap) {
  return ap.icao || ap.iata || `${ap.lat.toFixed(3)},${ap.lon.toFixed(3)}`;
}

/** The airport whose ground we are looking at, if we are looking at one.
 *  Memoised on the map centre: this runs from the draw loop, and scanning
 *  4,573 airports sixty times a second would be the most expensive thing on
 *  the frame. Distance is compared in squared degrees - no square roots, no
 *  LatLng objects - which is exact enough to pick a nearest airport. */
let nearestCache = { key: '', ap: null };
const LAYOUT_NEAR_DEG = 9 / 111.32; // ~9 km, the reach of a big field

function airportInView() {
  if (map.getZoom() < LAYOUT_ZOOM) return null;
  const c = map.getCenter();
  const key = `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
  if (nearestCache.key === key) return nearestCache.ap;

  const kx = Math.cos((c.lat * Math.PI) / 180);
  let best = null;
  let bestD2 = LAYOUT_NEAR_DEG * LAYOUT_NEAR_DEG;
  for (const ap of AIRPORTS) {
    const dy = ap.lat - c.lat;
    if (dy > LAYOUT_NEAR_DEG || dy < -LAYOUT_NEAR_DEG) continue;
    const dx = (ap.lon - c.lng) * kx;
    const d2 = dy * dy + dx * dx;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = ap;
    }
  }
  nearestCache = { key, ap: best };
  return best;
}

function requestLayout(ap) {
  const key = layoutKeyOf(ap);
  if (layouts.has(key)) return layouts.get(key);
  layouts.set(key, 'loading');

  fetch(`/api/airport-layout?lat=${ap.lat}&lon=${ap.lon}&r=${LAYOUT_RADIUS_M}`)
    .then((r) => r.json())
    .then((j) => {
      layouts.set(key, j.features && j.features.length ? { ap, features: j.features } : 'none');
      draw();
    })
    .catch(() => layouts.set(key, 'none'));
  return 'loading';
}

/* Project a layout's coordinates to world pixels once per zoom level. Panning
 * then only shifts them, which is what keeps this off the animation budget. */
function projectLayout(lay, zoom) {
  if (lay.zoom === zoom) return;
  for (const f of lay.features) {
    const pts = new Float64Array(f.g.length * 2);
    for (let i = 0; i < f.g.length; i++) {
      const w = map.project([f.g[i][0], f.g[i][1]], zoom);
      pts[i * 2] = w.x;
      pts[i * 2 + 1] = w.y;
    }
    f.p = pts;
  }
  lay.zoom = zoom;
}

const LAYOUT_ORDER = { apron: 0, hangar: 1, terminal: 2, taxiway: 3, runway: 4, helipad: 5, parking_position: 6 };

function drawAirportLayout() {
  if (!state.filters.layout) return;
  const zoom = map.getZoom();
  if (zoom < LAYOUT_ZOOM) return;

  const ap = airportInView();
  if (!ap) return;
  const lay = requestLayout(ap);
  if (!lay || typeof lay === 'string') return;

  projectLayout(lay, zoom);

  // World pixels -> container pixels, via one reference point per frame.
  const refC = map.latLngToContainerPoint([ap.lat, ap.lon]);
  const refP = map.project([ap.lat, ap.lon], zoom);
  const dx = refC.x - refP.x;
  const dy = refC.y - refP.y;

  // Metres per pixel here, so a 50 m runway is drawn 50 m wide.
  const pxPerM =
    map.latLngToContainerPoint([ap.lat, ap.lon + 0.01]).x - refC.x
      ? Math.abs(map.latLngToContainerPoint([ap.lat, ap.lon + 0.01]).x - refC.x) /
        kmBetween([ap.lat, ap.lon], [ap.lat, ap.lon + 0.01]) /
        1000
      : 0;

  const dark = state.style !== 'light' && state.style !== 'streets' && state.style !== 'terrain';
  const C = dark
    ? {
        apron: 'rgba(120,140,168,.12)',
        hangar: 'rgba(120,140,168,.20)',
        terminal: 'rgba(96,124,158,.22)',
        terminalEdge: 'rgba(150,180,214,.30)',
        taxi: 'rgba(150,176,206,.34)',
        runway: 'rgba(226,236,247,.30)',
        runwayEdge: 'rgba(226,236,247,.5)',
        centreline: 'rgba(255,255,255,.5)',
        stand: 'rgba(150,176,206,.4)',
        text: 'rgba(226,236,247,.85)',
      }
    : {
        apron: 'rgba(40,60,90,.10)',
        hangar: 'rgba(40,60,90,.18)',
        terminal: 'rgba(40,60,90,.24)',
        terminalEdge: 'rgba(30,50,80,.35)',
        taxi: 'rgba(40,60,90,.35)',
        runway: 'rgba(30,44,64,.35)',
        runwayEdge: 'rgba(20,32,48,.5)',
        centreline: 'rgba(255,255,255,.7)',
        stand: 'rgba(40,60,90,.4)',
        text: 'rgba(18,28,42,.85)',
      };

  const path = (f) => {
    ctx.beginPath();
    ctx.moveTo(f.p[0] + dx, f.p[1] + dy);
    for (let i = 1; i < f.p.length / 2; i++) ctx.lineTo(f.p[i * 2] + dx, f.p[i * 2 + 1] + dy);
  };

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const sorted = [...lay.features].sort((a, b) => (LAYOUT_ORDER[a.k] ?? 9) - (LAYOUT_ORDER[b.k] ?? 9));
  const runways = [];

  for (const f of sorted) {
    if (f.k === 'apron' || f.k === 'terminal' || f.k === 'hangar') {
      path(f);
      ctx.closePath();
      ctx.fillStyle = f.k === 'terminal' ? C.terminal : f.k === 'hangar' ? C.hangar : C.apron;
      ctx.fill();
      if (f.k === 'terminal') {
        ctx.strokeStyle = C.terminalEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    } else if (f.k === 'taxiway') {
      path(f);
      ctx.strokeStyle = C.taxi;
      // Taxiways are ~23 m wide; never thinner than a hairline, never a slab.
      ctx.lineWidth = clamp((f.w || 23) * pxPerM, 1, 26);
      ctx.stroke();
    } else if (f.k === 'runway' || f.k === 'helipad') {
      runways.push(f);
    } else if (f.k === 'parking_position' && zoom >= 16) {
      path(f);
      ctx.strokeStyle = C.stand;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  // Runways last and on top - they are the thing you are looking for.
  for (const f of runways) {
    const w = clamp((f.w || 45) * pxPerM, 2, 40);
    path(f);
    ctx.strokeStyle = C.runway;
    ctx.lineWidth = w;
    ctx.stroke();
    if (w > 5) {
      path(f);
      ctx.strokeStyle = C.runwayEdge;
      ctx.lineWidth = 1;
      ctx.stroke();
      path(f);
      ctx.strokeStyle = C.centreline;
      ctx.lineWidth = 1;
      ctx.setLineDash([9, 11]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Runway designators, written along the strip at each end.
  if (zoom >= 13) {
    ctx.font = '600 10px ui-monospace, ui-sans-serif, monospace';
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of runways) {
      if (!f.r || f.k === 'helipad') continue;
      const ends = f.r.split('/');
      const n = f.p.length / 2;
      const a = { x: f.p[0] + dx, y: f.p[1] + dy };
      const b = { x: f.p[(n - 1) * 2] + dx, y: f.p[(n - 1) * 2 + 1] + dy };
      let angle = Math.atan2(b.y - a.y, b.x - a.x);
      if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;

      // A runway number is the heading you fly when you leave that threshold,
      // so work out which end is which from the geometry - OSM ways are drawn
      // in either direction and "09R/27L" says nothing about which is first.
      let [first, second] = ends;
      if (ends.length === 2) {
        const bearing = ((Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI + 360) % 360;
        const heading = (t) => (parseInt(String(t).replace(/[^0-9]/g, ''), 10) || 0) * 10;
        const off = (h) => {
          const d = Math.abs(h - bearing) % 360;
          return d > 180 ? 360 - d : d;
        };
        if (off(heading(ends[0])) > off(heading(ends[1]))) [first, second] = [ends[1], ends[0]];
      }

      const label = (pt, text) => {
        if (!text) return;
        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(angle);
        ctx.fillText(text.trim(), 0, 0);
        ctx.restore();
      };
      label(a, first);
      label(b, second);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // Stand numbers, once they would not be a wall of text.
  if (zoom >= 17) {
    ctx.font = '9px ui-monospace, ui-sans-serif, monospace';
    ctx.fillStyle = C.text;
    for (const f of lay.features) {
      if (f.k !== 'parking_position' || !f.r) continue;
      ctx.fillText(f.r, f.p[0] + dx + 3, f.p[1] + dy - 2);
    }
  }

  ctx.restore();
}

/* Drawn on the same canvas as the aircraft, from the bundled OurAirports
 * extract - no API and no rate limit. Large airports appear first, medium ones
 * once you are close enough for them not to be clutter. */
const AIRPORTS = (window.AIRPORTS || []).map((a) => ({
  iata: a[0], icao: a[1], name: a[2], lat: a[3], lon: a[4],
  city: a[5], country: a[6], size: a[7], elev: a[8],
}));

let airportHits = [];

/* A control tower, drawn to stand on the airport's position: base column,
 * glazed cab, roof and the mast with its ball on top. Recognisable as an
 * airport at a glance, and unmistakably not an aircraft. */
function drawTowerMark(x, y, scale, major) {
  const ink = 'rgba(5,12,20,.92)';
  const body = major ? '#e9f3fb' : '#c2cdd9';
  const glass = major ? '#35c2f5' : '#8da1b4';

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;

  // base column - its foot sits on the coordinate
  ctx.beginPath();
  ctx.rect(-3, -9, 6, 9);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.stroke();

  // cab, slightly wider at the top like the real thing
  ctx.beginPath();
  ctx.moveTo(-5.6, -15);
  ctx.lineTo(5.6, -15);
  ctx.lineTo(4.3, -9.4);
  ctx.lineTo(-4.3, -9.4);
  ctx.closePath();
  ctx.fillStyle = glass;
  ctx.fill();
  ctx.stroke();

  // window mullions, once there are pixels to spare
  if (scale >= 0.68) {
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (const dx of [-1.9, 1.9]) {
      ctx.moveTo(dx, -14.6);
      ctx.lineTo(dx * 0.78, -9.8);
    }
    ctx.stroke();
    ctx.lineWidth = 1.5;
  }

  // roof
  ctx.beginPath();
  ctx.rect(-6.6, -16.8, 13.2, 1.9);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.stroke();

  // mast and beacon
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(0, -16.8);
  ctx.lineTo(0, -19.3);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -20.4, 1.35, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function drawAirports() {
  airportHits = [];
  if (!state.filters.airports || !AIRPORTS.length) return;

  const zoom = map.getZoom();
  if (zoom < 5) return;
  const showMedium = zoom >= 7;
  const showCode = zoom >= 6;
  const showName = zoom >= 9;

  const b = map.getBounds();
  const south = b.getSouth(), north = b.getNorth(), west = b.getWest(), east = b.getEast();
  const towerScale = zoom >= 11 ? 0.9 : zoom >= 9 ? 0.78 : zoom >= 7 ? 0.66 : 0.55;
  ctx.textBaseline = 'alphabetic';
  for (const ap of AIRPORTS) {
    if (ap.size === 2 && !showMedium) continue;
    if (ap.lat < south || ap.lat > north || ap.lon < west || ap.lon > east) continue;

    const p = map.latLngToContainerPoint([ap.lat, ap.lon]);
    if (p.x < -40 || p.x > vw + 40 || p.y < -40 || p.y > vh + 40) continue;

    const major = ap.size === 1;
    const hit = {
      x: p.x,
      y: p.y,
      // the drawn tower: half-width either side of the foot, rising above it
      hw: zoom >= 6 ? 7.4 * towerScale : 4,
      hh: zoom >= 6 ? 22 * towerScale : 4,
      label: null,
      ap,
    };
    airportHits.push(hit);

    const isOpen = state.airport && state.airport.icao === ap.icao && state.airport.iata === ap.iata;
    if (isOpen) {
      ctx.beginPath();
      ctx.arc(p.x, p.y - 8, 21, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(53,194,245,.12)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(53,194,245,.8)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (zoom >= 6) {
      drawTowerMark(p.x, p.y, towerScale, major);
    } else {
      // too small for a tower to read - a plain mark keeps the map legible
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = major ? '#35c2f5' : 'rgba(163,180,201,.9)';
      ctx.fill();
    }

    if (!showCode || (!major && zoom < 8)) continue;

    const label = ap.iata || ap.icao;
    ctx.font = major ? '600 10px ui-monospace, monospace' : '9.5px ui-monospace, monospace';
    const w = ctx.measureText(label).width;
    const box = { x: p.x - w / 2 - 3, y: p.y + 3, w: w + 6, h: 13 };

    if (!fits(box)) continue;

    ctx.fillStyle = 'rgba(9,13,19,.7)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = major ? 'rgba(53,194,245,.95)' : 'rgba(168,184,203,.9)';
    ctx.fillText(label, box.x + 3, box.y + 10);
    // the code chip is the easiest thing to aim at, so make it clickable
    hit.label = box;

    if (showName && major) {
      ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
      const nw = ctx.measureText(ap.name).width;
      ctx.fillStyle = 'rgba(9,13,19,.6)';
      ctx.fillRect(p.x - nw / 2 - 3, box.y + 13, nw + 6, 12);
      ctx.fillStyle = 'rgba(200,214,230,.85)';
      ctx.fillText(ap.name, p.x - nw / 2, box.y + 22);
      placedBoxes.push({ x: p.x - nw / 2 - 3, y: box.y + 13, w: nw + 6, h: 12 });
    }
  }
}

/** The airport whose drawn tower contains this screen point. */
function airportAt(x, y) {
  for (const h of airportHits) {
    const onTower = x >= h.x - h.hw && x <= h.x + h.hw && y >= h.y - h.hh && y <= h.y + 3;
    const l = h.label;
    const onLabel = l && x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h;
    if (onTower || onLabel) return h.ap;
  }
  return null;
}

/**
 * What is under the pointer. An aircraft directly under it wins, because it is
 * drawn on top; otherwise a tower it lands on; otherwise a nearby aircraft.
 * Without this, every tower at a busy airport is unclickable - parked aircraft
 * sit right on it.
 */
function pickAt(x, y) {
  const exact = hitTest(x, y, 6);
  if (exact) return { type: 'aircraft', id: exact.id };
  const ap = airportAt(x, y);
  if (ap) return { type: 'airport', ap };
  const near = hitTest(x, y, HIT_RADIUS_PX);
  return near ? { type: 'aircraft', id: near.id } : null;
}


/* ───────────────────────── hover / click interaction ──────────────────── */

const hoverCard = document.createElement('div');
hoverCard.id = 'hovercard';
hoverCard.hidden = true;
map.getContainer().appendChild(hoverCard);

function hitTest(x, y, radius = HIT_RADIUS_PX) {
  let best = null;
  let bestD = radius * radius;
  for (const h of hitList) {
    const dx = h.x - x;
    const dy = h.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

const container = map.getContainer();

container.addEventListener('mousemove', (ev) => {
  const r = container.getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  lastHoverXY = [x, y];
  const picked = pickAt(x, y);
  const id = picked && picked.type === 'aircraft' ? picked.id : null;

  if (!id) {
    const ap = picked && picked.ap;
    if (ap) {
      if (state.hover) { state.hover = null; draw(); }
      container.style.cursor = 'help';
      hoverCard.innerHTML =
        `<b>${esc(ap.iata || ap.icao)}</b><i>${esc(ap.name)}</i><i>${esc(
          [ap.city, ap.country].filter(Boolean).join(', ')
        )}${ap.icao ? ' · ' + esc(ap.icao) : ''}${ap.elev != null ? ' · ' + nf.format(ap.elev) + ' ft' : ''}</i>`;
      hoverCard.hidden = false;
      hoverCard.style.left = x + 'px';
      hoverCard.style.top = y + 'px';
      return;
    }
  }

  if (id !== state.hover) {
    state.hover = id;
    container.style.cursor = id ? 'pointer' : '';
    draw();
  }
  if (id) {
    renderHoverCard(fleet.get(id), x, y);
    // Resolve the route after a short dwell, so a mouse sweeping across the
    // map does not fire a lookup for every aircraft it passes over.
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const a = fleet.get(id);
      if (!a || a.detailsDone || !a.cs) return;
      loadDetails(a).then(() => {
        if (state.hover === id) renderHoverCard(a, lastHoverXY[0], lastHoverXY[1]);
      });
    }, 320);
  } else {
    clearTimeout(hoverTimer);
    hoverCard.hidden = true;
  }
});

let hoverTimer = null;
let lastHoverXY = [0, 0];

function renderHoverCard(a, x, y) {
  if (!a) return;
  lastHoverXY = [x, y];
  const air = REF.decodeCallsign(a.cs);
  const r = a.route || (a.cs && routeByCallsign.get(a.cs)) || null;
  const name = (r && r.airline && r.airline.name) || (a.info && a.info.owner) || (air && air.name);
  const iata = airlineIata(a);
  hoverCard.innerHTML =
    logoImgHtml(iata, 'hc-logo') +
    `<b>${esc(a.cs || a.reg || a.id.toUpperCase())}</b>` +
    (r
      ? `<u>${esc(r.origin.iata || r.origin.icao)} <span>&rarr;</span> ${esc(
          r.destination.iata || r.destination.icao
        )}</u><i>${esc(
          [r.origin.city, r.destination.city].filter(Boolean).join(' to ')
        )}</i>`
      : '') +
    `<i>${esc(
      [name, identityOf(a), fmtAlt(a.alt, a.gnd), a.gs != null ? Math.round(a.gs) + ' kt' : null]
        .filter(Boolean)
        .join(' · ')
    )}</i>`;
  hoverCard.hidden = false;
  hoverCard.style.left = x + 'px';
  hoverCard.style.top = y + 'px';
}

container.addEventListener('mouseleave', () => {
  if (state.hover) { state.hover = null; draw(); }
  hoverCard.hidden = true;
});

map.on('click', (e) => {
  const picked = pickAt(e.containerPoint.x, e.containerPoint.y);
  if (picked && picked.type === 'aircraft') select(picked.id);
  else if (picked) selectAirport(picked.ap);
  else if (state.selected) select(null);
  else if (state.airport) selectAirport(null);
});

/* ───────────────────────────── data polling ──────────────────────────── */

let pollTimer = null;
let polling = false;
let lastPollAt = 0;

function currentBBox() {
  const b = map.getBounds().pad(0.18);
  // Snap the request outwards to a grid so that nudging the map re-uses the
  // server's cached snapshot instead of starting a fresh sweep for a bbox
  // that differs by a fraction of a degree. Coarser when zoomed out, where a
  // sweep is expensive.
  const z = map.getZoom();
  const step = z >= 10 ? 0.25 : z >= 8 ? 0.5 : z >= 6 ? 1 : 2;
  const down = (v) => Math.floor(v / step) * step;
  const up = (v) => Math.ceil(v / step) * step;
  let lomin = b.getWest();
  let lomax = b.getEast();
  if (lomax - lomin >= 360) { lomin = -180; lomax = 180; }
  else {
    lomin = ((lomin + 540) % 360) - 180;
    lomax = ((lomax + 540) % 360) - 180;
    if (lomax < lomin) { lomin = -180; lomax = 180; } // crosses the antimeridian
  }
  return {
    lamin: clamp(down(b.getSouth()), -89.9, 89.9).toFixed(4),
    lomin: Math.max(-180, down(lomin)).toFixed(4),
    lamax: clamp(up(b.getNorth()), -89.9, 89.9).toFixed(4),
    lomax: Math.min(180, up(lomax)).toFixed(4),
  };
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  const wait = delay === 0 ? Math.max(0, 900 - (Date.now() - lastPollAt)) : delay;
  pollTimer = setTimeout(poll, wait);
}

async function poll() {
  if (polling || document.hidden) { schedulePoll(2000); return; }
  polling = true;
  lastPollAt = Date.now();
  try {
    const qs = new URLSearchParams(currentBBox());
    const res = await fetch(`/api/flights?${qs}`, { cache: 'no-store' });
    const json = await res.json();
    if (!res.ok) throw new Error(json.hint || json.detail || json.error || res.statusText);

    ingest(json);
    state.lastSource = json.source;
    const isOpenSky = json.source === 'opensky';
    const tiled = !isOpenSky && json.tiles > 1;
    const age = json.ageSec || 0;
    if (json.coverage) {
      setLive('warn', 'partial coverage');
      note(`Wide-area feed unavailable — showing ${json.coverage}. Zoom in for full coverage.`);
    } else if (isOpenSky && json.quota === 'anonymous') {
      // The world view is a periodic snapshot on the free anonymous quota.
      setLive(age > 75 ? 'warn' : 'ok', age < 60 ? 'world snapshot' : `snapshot ${Math.round(age / 60)} min old`);
      note(
        'Whole-world view refreshes every few minutes on OpenSky’s free anonymous quota. ' +
          'Zoom in for a live regional feed, or add OpenSky credentials for a live world view.',
        600000
      );
    } else {
      // A wide sweep refreshes more slowly than a regional view, so say so
      // rather than claiming everything is equally live.
      const secs = Math.round((json.nextPollMs || 0) / 1000);
      // Name the feed that actually answered - there are three of them now,
      // and an airport view is served by two at once.
      const feed = json.source.includes('+') ? 'both feeds' : json.source;
      setLive(
        json.stale ? 'warn' : 'ok',
        isOpenSky
          ? 'OpenSky live'
          : tiled
            ? `${feed} · wide ${secs}s`
            : `${feed} live`
      );
    }
    if (json.warning) console.warn('feed warning:', json.warning);
    if (!fleet.size) {
      note(
        json.count === 0
          ? 'No aircraft are being reported in this view. Pan towards a busier region, or zoom in — ADS-B coverage is thin over oceans and deserts.'
          : 'No aircraft to show yet — waiting for the first snapshot.',
        60000
      );
    }
    // The server knows what the view costs to gather, so let it set the pace.
    schedulePoll(json.nextPollMs || POLL_MS[tiled ? 'adsb.lol-tiled' : json.source] || 8000);
    prefetchRoutes();
  } catch (err) {
    // Losing the network is not a fault in the feed, and saying "feed error"
    // when the cable is out sends people looking in the wrong place.
    if (!navigator.onLine) {
      setLive('warn', 'offline');
      note(
        'No network. The map keeps working from tiles already cached on the server, ' +
          'and anything in view stays on screen — but no new positions can arrive ' +
          'unless you have a receiver of your own feeding this instance.',
        60000
      );
      schedulePoll(8000);
      return;
    }
    const limited = /rate limit|429|too many/i.test(String(err.message || err));
    setLive(limited ? 'warn' : 'err', limited ? 'feed busy' : 'feed error');
    console.error('poll failed:', err);
    if (limited) {
      note(
        'The whole-world feed (OpenSky) has used up its free anonymous quota. ' +
          'Zoom in — regional and continental views use a different feed with no such ' +
          'limit — or add OpenSky API credentials for a live world view (see the README).',
        300000
      );
    } else if (!fleet.size) {
      toast(String(err.message || err), 4500);
    }
    schedulePoll(limited ? 25000 : 8000);
  } finally {
    polling = false;
    updateStats();
  }
}

function ingest(json, partial = false) {
  const now = Date.now();
  const seenIds = new Set();

  for (const a of json.aircraft) {
    if (!a.id) continue;
    seenIds.add(a.id);
    const prev = fleet.get(a.id);
    const moved = !prev || prev.lat !== a.lat || prev.lon !== a.lon;

    const rec = prev || { id: a.id, trail: [] };
    // Keep richer fields from adsb.lol when a coarse OpenSky update arrives.
    rec.cs = a.cs || rec.cs || null;
    rec.reg = a.reg || rec.reg || null;
    rec.typ = a.typ || rec.typ || null;
    rec.cat = a.cat || rec.cat || null;
    rec.desc = a.desc || rec.desc || null;
    rec.op = a.op || rec.op || null;
    rec.yr = a.yr || rec.yr || null;
    rec.ctry = a.ctry || rec.ctry || null;
    rec.mil = a.mil || rec.mil || false;
    rec.lat = a.lat;
    rec.lon = a.lon;
    rec.alt = a.alt;
    rec.galt = a.galt ?? rec.galt ?? null;
    rec.gs = a.gs;
    rec.trk = a.trk ?? rec.trk;
    rec.vs = a.vs;
    rec.sqk = a.sqk || rec.sqk;
    rec.gnd = a.gnd;
    rec.nt = a.nt || rec.nt || false;
    rec.emg = a.emg;
    rec.seen = a.seen;
    rec.src = a.src;
    // Distance to the stated destination at the previous update, so the panel
    // can tell closing from drawing away rather than inferring it.
    if (rec.route && rec.route.destination && rec.route.destination.lat !== undefined) {
      const prevKm = kmBetween([rec.lat, rec.lon], [rec.route.destination.lat, rec.route.destination.lon]);
      if (rec.destKm !== undefined) rec.destKmPrev = rec.destKm;
      rec.destKm = prevKm;
    }
    rec.at = now;                       // when we received this update
    rec.posAt = now - (a.seen || 0) * 1000; // when the position was measured

    if (moved) {
      const t = rec.trail;
      const last = t[t.length - 1];
      if (!last || Math.abs(last[0] - a.lat) > 1e-5 || Math.abs(last[1] - a.lon) > 1e-5) {
        t.push([a.lat, a.lon, a.alt, now]);
        const cutoff = now - TRAIL_MAX_AGE_S * 1000;
        while (t.length > TRAIL_MAX_POINTS || (t.length > 2 && t[0][3] < cutoff)) t.shift();
      }
    }
    if (!prev) { rec.dlat = a.lat; rec.dlon = a.lon; }
    attachKnownRoute(rec);
    fleet.set(a.id, rec);
  }

  // Drop aircraft we have not heard about for a while. The selected one is
  // kept so its panel does not vanish while it is being followed. A partial
  // response (one aircraft) says nothing about the others, so skip the sweep.
  for (const [id, a] of fleet) {
    if (partial) break;
    if (seenIds.has(id)) continue;
    if (id === state.selected) continue;
    if (now - a.at > STALE_DROP_S * 1000) fleet.delete(id);
  }

  if (state.selected) {
    const sel = fleet.get(state.selected);
    if (sel && !seenIds.has(state.selected) && now - sel.at > 20000) refreshSelected();
    renderDetail();
    if (sel) drawRouteLayer(sel);
  }
  draw();
}

/* Follow a selected aircraft even after it leaves the viewport. */
async function refreshSelected() {
  const id = state.selected;
  if (!id) return;
  try {
    const res = await fetch(`/api/aircraft/${id}`, { cache: 'no-store' });
    const json = await res.json();
    if (res.ok && json.aircraft && json.aircraft.length) ingest({ aircraft: json.aircraft }, true);
  } catch { /* the next viewport poll will pick it up again */ }
}

/* ───────────────────── dead reckoning + render loop ──────────────────── */

let lastFrame = 0;

function frameInterval() {
  const n = fleet.size;
  if (n > 4000) return 100;   // 10 fps
  if (n > 1500) return 50;    // 20 fps
  return 0;                   // every frame
}

function tick(ts) {
  const wait = frameInterval();
  if (wait && ts - lastFrame < wait) { requestAnimationFrame(tick); return; }
  lastFrame = ts || 0;

  const now = Date.now();
  if (state.filters.smooth) {
    for (const a of fleet.values()) {
      if (a.gnd || !a.gs || a.gs < 25 || a.trk === null || a.trk === undefined) {
        a.dlat = a.lat; a.dlon = a.lon;
        continue;
      }
      const dtH = (now - a.posAt) / 3600000;
      if (dtH <= 0 || dtH > 0.05) { a.dlat = a.lat; a.dlon = a.lon; continue; }
      const [la, lo] = project(a.lat, a.lon, a.trk, a.gs * dtH);
      a.dlat = la; a.dlon = lo;
    }
  } else {
    for (const a of fleet.values()) { a.dlat = a.lat; a.dlon = a.lon; }
  }

  if (state.follow && state.selected) {
    const a = fleet.get(state.selected);
    if (a) map.panTo([a.dlat ?? a.lat, a.dlon ?? a.lon], { animate: false });
  }

  draw();
  requestAnimationFrame(tick);
}

/* ───────────────────────── route lookup + drawing ─────────────────────── */

/* Positions come from the ADS-B feeds; where a flight started and where it is
 * heading does not. The server resolves that from the callsign (adsbdb.com,
 * with hexdb.io as fallback) and it is looked up per aircraft, on demand. */
const detailsCache = new Map(); // "hex|callsign" -> { route, info }
const routeLayer = L.layerGroup().addTo(map);

/* Routes keyed by callsign, shared by every aircraft flying it. Filled in
 * ahead of any click so the map labels can show where each flight started and
 * where it ends. */
const routeByCallsign = new Map(); // "RYR47HY" -> route | null
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d/;
let prefetching = false;

function attachKnownRoute(a) {
  if (!a.route && a.cs && routeByCallsign.get(a.cs)) a.route = routeByCallsign.get(a.cs);
}

/**
 * Ask the server for the routes of the airline flights currently on screen,
 * in one batched request. Unknown callsigns are remembered as "no route" so
 * they are never asked for twice.
 */
let lastPrefetch = 0;

async function prefetchRoutes() {
  if (prefetching) return;
  // A route search or an airport filter is answered by route data, so resolve
  // harder while one is open - otherwise the answer depends on which twelve
  // happened to be looked up next.
  const hunting = Boolean(state.routeQuery) || state.facets.airports.size > 0;
  if (!hunting && map.getZoom() < 6 && !state.airport) return;
  if (Date.now() - lastPrefetch < (hunting ? 2500 : 7000)) return;
  const bounds = map.getBounds();
  const ap = state.airport;
  const want = [];
  for (const a of fleet.values()) {
    if (want.length >= (hunting ? 24 : 12)) break;
    if (!a.cs || a.route || routeByCallsign.has(a.cs)) continue;
    if (!AIRLINE_CALLSIGN.test(a.cs)) continue; // registrations have no route
    // Deliberately the *base* filter, not the full one: the facets are built
    // out of route data, so gating route lookups on them would deadlock - an
    // airport filter would exclude every aircraft whose route is the thing we
    // still need to look up.
    if (!passesBaseFilter(a)) continue;
    const pos = [a.dlat ?? a.lat, a.dlon ?? a.lon];
    // Anything on screen, plus anything near an open airport - its inbound and
    // departing lists are built from route data, so those need resolving too.
    const relevant =
      hunting || bounds.contains(pos) || (ap && kmBetween(pos, [ap.lat, ap.lon]) < 600);
    if (!relevant) continue;
    want.push(a.cs);
  }
  if (!want.length) return;

  prefetching = true;
  lastPrefetch = Date.now();
  try {
    const res = await fetch(`/api/routes?cs=${want.join(',')}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { routes } = await res.json();
    for (const cs of want) routeByCallsign.set(cs, routes[cs] || null);
    if (routeByCallsign.size > 4000) routeByCallsign.clear();
    for (const a of fleet.values()) attachKnownRoute(a);
    if (state.selected) renderDetail();
    if (state.routeQuery && !resultsEl.hidden) runSearch();
    if (state.facets.airports.size && !$('#filters').hidden) renderFacets();
    updateStats();
    draw();
  } catch {
    /* the next poll tries again */
  } finally {
    prefetching = false;
  }
}

async function loadDetails(a) {
  if (!a) return;
  const key = `${a.id}|${a.cs || ''}`;
  if (detailsCache.has(key)) {
    Object.assign(a, detailsCache.get(key), { detailsDone: true });
    return;
  }
  const qs = new URLSearchParams({ hex: a.id });
  if (a.cs) qs.set('callsign', a.cs);
  if (a.reg) qs.set('reg', a.reg);
  try {
    const res = await fetch(`/api/details?${qs}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    const json = await res.json();
    const value = { route: json.route || null, info: json.info || null, photo: json.photo || null };
    detailsCache.set(key, value);
    if (a.cs) routeByCallsign.set(a.cs, json.route || null);
    if (detailsCache.size > 600) detailsCache.delete(detailsCache.keys().next().value);
    Object.assign(a, value, { detailsDone: true });
  } catch {
    a.detailsDone = true; // do not spin on a failed lookup
  }
}

/** Where the flight is along its route, from its current position. */


/* ─────────────────────── flights that already landed ───────────────────
 * The live feeds only know what is transmitting now. OpenSky also keeps what
 * has happened, so an airframe's earlier legs can be listed and the path of
 * any one of them drawn on the map exactly as it was flown. */

const historyCache = new Map();  // hex -> { flights } | 'loading'

async function loadHistory(hex) {
  if (historyCache.has(hex)) return historyCache.get(hex);
  historyCache.set(hex, 'loading');
  try {
    const r = await fetch(`/api/history/flights?hex=${hex}&hours=30`);
    const j = await r.json();
    historyCache.set(hex, r.ok ? j : { flights: [], error: j.detail || j.error });
  } catch (e) {
    historyCache.set(hex, { flights: [], error: e.message });
  }
  if (state.selected === hex) renderDetail();
  return historyCache.get(hex);
}

/** Draw one past leg on the map, coloured by altitude like a live trail. */
async function showHistoryTrack(hex, time, label) {
  state.history = { hex, loading: true, label };
  draw();
  try {
    const r = await fetch(`/api/history/track?hex=${hex}&time=${time}`);
    const j = await r.json();
    if (!r.ok || !j.path || !j.path.length) {
      note('No recorded path for that leg — OpenSky did not see enough of it.');
      state.history = null;
      draw();
      return;
    }
    // [epoch, lat, lon, altFt, trk] -> the [lat, lon, alt, time] a trail uses.
    const pts = j.path.map((p) => [p[1], p[2], p[3], p[0] * 1000]);
    state.history = { hex, label, cs: j.cs, pts, startTime: j.startTime, endTime: j.endTime };
    map.fitBounds(L.latLngBounds(pts.map((p) => [p[0], p[1]])), { padding: [70, 70], animate: false });
    renderDetail();
    draw();
  } catch (e) {
    note('Could not load that flight path: ' + e.message);
    state.history = null;
    draw();
  }
}

function clearHistoryTrack() {
  if (!state.history) return;
  state.history = null;
  renderDetail();
  draw();
}

function drawHistoryTrack() {
  const h = state.history;
  if (!h || !h.pts || h.pts.length < 2) return;

  ctx.save();
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let first = null;
  let last = null;
  for (let i = 1; i < h.pts.length; i++) {
    const p0 = map.latLngToContainerPoint([h.pts[i - 1][0], h.pts[i - 1][1]]);
    const p1 = map.latLngToContainerPoint([h.pts[i][0], h.pts[i][1]]);
    if (Math.abs(p1.x - p0.x) > vw * 0.6) continue; // antimeridian
    if (!first) first = p0;
    last = p1;
    ctx.beginPath();
    ctx.strokeStyle = state.colorByAlt
      ? altColor(h.pts[i][2]).replace('rgb(', 'rgba(').replace(')', ',.92)')
      : 'rgba(247,201,72,.92)';
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
  // Where it started and where it stopped.
  const cap = (p, fill) => {
    if (!p) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(5,12,20,.85)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  };
  cap(first, '#3ddc84');
  cap(last, '#ff4d5e');
  ctx.restore();
}

const fmtClock = (epoch) =>
  new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const fmtDay = (epoch) => {
  const d = new Date(epoch * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? 'today' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

const airportHistoryCache = new Map(); // ICAO -> { flights, lagHours } | 'loading'

async function loadAirportHistory(icao) {
  if (airportHistoryCache.has(icao)) return airportHistoryCache.get(icao);
  airportHistoryCache.set(icao, 'loading');
  try {
    const r = await fetch(`/api/history/airport?icao=${icao}&kind=arrival&hours=12`);
    const j = await r.json();
    airportHistoryCache.set(icao, r.ok ? j : { flights: [], error: j.detail || j.error });
  } catch (e) {
    airportHistoryCache.set(icao, { flights: [], error: e.message });
  }
  if (state.airport && state.airport.icao === icao) renderAirport();
  return airportHistoryCache.get(icao);
}

/** What has already landed here — necessarily a while ago, see the note. */
function landedBlock(ap) {
  if (!ap.icao) return '';
  const h = airportHistoryCache.get(ap.icao);
  if (h === undefined) {
    loadAirportHistory(ap.icao);
    return '<div class="ap-sec"><h4>Landed earlier</h4><div class="ap-empty">Looking up…</div></div>';
  }
  if (h === 'loading') return '<div class="ap-sec"><h4>Landed earlier</h4><div class="ap-empty">Looking up…</div></div>';

  const window = h.windowEnd
    ? `${new Date((h.windowEnd - h.hours * 3600) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(h.windowEnd * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';

  if (h.error || !h.flights.length) {
    return `<div class="ap-sec"><h4>Landed earlier</h4>
      <div class="ap-empty">${
        h.error
          ? esc(h.error)
          : `Nothing recorded for ${esc(window)}. OpenSky works this out from its own
             receivers, and does not manage it everywhere.`
      }</div></div>`;
  }

  const rows = h.flights
    .slice(0, 10)
    .map(
      (f) => `<div class="ap-row hist-arr" data-hex="${esc(f.hex || '')}" data-time="${Math.floor(
        ((f.dep || 0) + (f.arr || 0)) / 2
      )}" role="button" tabindex="0">
        <span class="ap-row-logo"></span>
        <span class="ap-row-cs">${esc(f.cs || (f.hex || '').toUpperCase())}</span>
        <span class="ap-row-meta">from ${esc(f.from || 'unknown')}</span>
        <span class="ap-row-right">${esc(fmtClock(f.arr))}</span>
      </div>`
    )
    .join('');

  return `<div class="ap-sec">
    <h4>Landed earlier <b>${h.flights.length}</b></h4>
    ${rows}
    ${h.flights.length > 10 ? `<div class="ap-more">+ ${h.flights.length - 10} more</div>` : ''}
    <div class="ap-foot" style="padding:8px 0 0">Arrivals for ${esc(window)} — this table is
      built in arrears, so it runs about ${h.lagHours} hours behind. Click one to draw the
      path it flew.</div>
  </div>`;
}

/** The "where has this aircraft been" block in the detail panel. */
function historyBlock(a) {
  const h = historyCache.get(a.id);
  if (h === undefined) {
    loadHistory(a.id);
    return '<div class="hist"><h4>Earlier flights</h4><div class="hist-wait">Looking up where this aircraft has been…</div></div>';
  }
  if (h === 'loading') {
    return '<div class="hist"><h4>Earlier flights</h4><div class="hist-wait">Looking up where this aircraft has been…</div></div>';
  }
  if (h.error) {
    return `<div class="hist"><h4>Earlier flights</h4><div class="hist-wait">${esc(h.error)}</div></div>`;
  }
  if (!h.flights.length) {
    return `<div class="hist"><h4>Earlier flights</h4>
      <div class="hist-wait">Nothing recorded in the last 30 hours. OpenSky builds this
      from its own receiver network, which is thin in some parts of the world.</div></div>`;
  }

  const shown = state.history && state.history.pts ? state.history.label : null;
  const rows = h.flights
    .slice(0, 10)
    .map((f) => {
      const mid = Math.floor(((f.dep || 0) + (f.arr || 0)) / 2);
      const key = `${f.cs || ''}@${f.dep}`;
      const mins = f.dep && f.arr ? Math.round((f.arr - f.dep) / 60) : null;
      return `<div class="hist-row${shown === key ? ' on' : ''}" data-hex="${esc(a.id)}"
          data-time="${mid}" data-key="${esc(key)}" role="button" tabindex="0">
        <span class="hist-leg">${esc(f.from || '????')} <em>&rarr;</em> ${esc(f.to || '????')}</span>
        <span class="hist-when">${esc(fmtDay(f.dep))} ${esc(fmtClock(f.dep))}–${esc(fmtClock(f.arr))}</span>
        <span class="hist-dur">${mins !== null ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : ''}</span>
      </div>`;
    })
    .join('');

  return `<div class="hist">
    <h4>Earlier flights <b>${h.flights.length}</b>
      ${shown ? '<button class="hist-clear" id="hist-clear">Clear path</button>' : ''}</h4>
    ${rows}
    <div class="hist-foot">Airport codes are OpenSky's estimate from where each
      flight began and ended. Click a leg to draw the path it actually flew —
      green where it started, red where it stopped.</div>
  </div>`;
}

/* ───────────────────── is it flying where it should be? ─────────────────
 * ADS-B carries position, not intent - no aircraft broadcasts *why* it turned.
 * What can be established is what it is doing: whether it is still closing on
 * the destination its callsign implies, whether it has gone past it, and
 * whether it is going round in circles. Each of those has a small number of
 * ordinary explanations, and naming them is more use than guessing one.     */

const OFF_TRACK_DEG = 70;      // airways and arrivals bend; only call it off past this
const NEAR_FIELD_KM = 45;      // inside this, manoeuvring for an approach is normal
const HOLD_TURN_DEG = 300;     // a full circle's worth of turning in the trail

/** Initial great-circle bearing from one position to another, in degrees. */
function bearingTo(from, to) {
  const R = Math.PI / 180;
  const f1 = from[0] * R, f2 = to[0] * R, dl = (to[1] - from[1]) * R;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

const angleGap = (a, b) => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
};

/** Total turning and net travel over the aircraft's recent trail. */
function trailShape(a) {
  const t = a.trail;
  if (!t || t.length < 4) return null;
  let turn = 0;
  let prev = null;
  for (let i = 1; i < t.length; i++) {
    const br = bearingTo([t[i - 1][0], t[i - 1][1]], [t[i][0], t[i][1]]);
    if (prev !== null) {
      const d = ((br - prev + 540) % 360) - 180; // signed, -180..180
      turn += Math.abs(d);
    }
    prev = br;
  }
  const spanMin = (t[t.length - 1][3] - t[0][3]) / 60000;
  const net = kmBetween([t[0][0], t[0][1]], [t[t.length - 1][0], t[t.length - 1][1]]);
  let path = 0;
  for (let i = 1; i < t.length; i++) path += kmBetween([t[i - 1][0], t[i - 1][1]], [t[i][0], t[i][1]]);
  return { turn, spanMin, net, path };
}

/**
 * What the numbers say about this flight's path, and the ordinary reasons for
 * it. Returns null when there is nothing worth remarking on.
 */
function analysePath(a) {
  const pr = routeProgress(a);
  const shape = trailShape(a);
  const notes = [];

  // Going round in circles: a hold, a delay, or a survey/training flight.
  if (shape && shape.turn > HOLD_TURN_DEG && shape.spanMin > 2 && shape.net < shape.path * 0.4) {
    notes.push({
      kind: 'hold',
      what: (() => {
        const turns = Math.max(1, Math.round(shape.turn / 360));
        return `Circling — about ${turns} turn${turns === 1 ? '' : 's'} in the last ${Math.round(
          shape.spanMin
        )} min.`;
      })(),
      why: [
        'Held by air traffic control until an approach slot opens',
        'Burning fuel down to landing weight, or waiting out weather at the field',
        'A survey, training or pleasure flight, which circles by design',
      ],
    });
  }

  if (pr && !a.gnd) {
    const brg = (bearingTo(pr.pos, pr.d) + 360) % 360;
    const brgOrigin = (bearingTo(pr.pos, pr.o) + 360) % 360;
    const off = a.trk === null || a.trk === undefined ? null : angleGap(a.trk, brg);
    const offOrigin = a.trk === null || a.trk === undefined ? null : angleGap(a.trk, brgOrigin);
    const dest = esc(a.route.destination.iata || a.route.destination.icao);
    const origin = esc(a.route.origin.iata || a.route.origin.icao);

    // Past the destination and still going.
    const opening = a.destKmPrev !== undefined && pr.remaining > a.destKmPrev + 2;

    // Heading back the way it came is the commonest of these by far, and it
    // almost always means the label is the earlier leg rather than this one.
    if (off !== null && off > OFF_TRACK_DEG && offOrigin < 55 && pr.remaining > NEAR_FIELD_KM) {
      notes.push({
        kind: 'reverse',
        what: `Flying towards ${origin}, not ${dest} — heading ${Math.round(
          a.trk
        )}°, which is the way back.`,
        why: [
          `This is almost certainly the return leg: an airline reuses a callsign for the trip back, and the route database gives whichever leg it knows — so the label reads ${origin} → ${dest} while the aircraft flies ${dest} → ${origin}`,
          'Less often, a turn-back — a technical problem, a sick passenger, or the destination closing',
        ],
      });
    } else if (pr.flown > pr.total * 0.9 && opening && pr.remaining > NEAR_FIELD_KM) {
      notes.push({
        kind: 'past',
        what: `Past ${dest} and drawing away — ${nf.format(
          pr.remaining
        )} km beyond it, and the gap is growing.`,
        why: [
          'The route shown is taken from the callsign, and may be a scheduled or earlier leg rather than the one being flown now',
          'A diversion to another airport — weather, a medical case, or a closed runway',
          'A go-around or a missed approach, which flies past the field before coming back',
        ],
      });
    } else if (off !== null && off > OFF_TRACK_DEG && pr.remaining > NEAR_FIELD_KM) {
      notes.push({
        kind: 'off',
        what: `Not pointing at ${dest} — heading ${Math.round(
          a.trk
        )}°, the airport lies ${Math.round(brg)}° away (${Math.round(off)}° off).`,
        why: [
          'Following an airway or a controller’s heading, which rarely runs straight to the field',
          'Steering around weather — switch the precipitation radar on to see if there is any in the way',
          'Being sequenced onto an approach, or vectored for traffic',
        ],
      });
    }
  }

  if (a.emg || isSpecialSquawk(a.sqk)) {
    notes.push({
      kind: 'emg',
      what: `Squawking ${esc(a.sqk || a.emg)} — ${esc(
        (REF.SQUAWKS && REF.SQUAWKS[a.sqk]) || 'an emergency code'
      )}.`,
      why: ['The crew has declared a situation to air traffic control; a diversion to the nearest suitable airport is usual'],
    });
  }

  return notes.length ? notes : null;
}

function pathBlock(a) {
  const notes = analysePath(a);
  if (!notes) return '';
  return notes
    .map(
      (n) => `<div class="pathnote pn-${n.kind}">
        <b>${n.what}</b>
        <span>Why this happens — the feed cannot say which:</span>
        <ul>${n.why.map((w) => `<li>${w}</li>`).join('')}</ul>
      </div>`
    )
    .join('');
}

function routeProgress(a) {
  const r = a.route;
  if (!r || !r.origin || !r.destination || r.origin.lat === undefined || r.destination.lat === undefined) return null;
  const pos = [a.dlat ?? a.lat, a.dlon ?? a.lon];
  const o = [r.origin.lat, r.origin.lon];
  const d = [r.destination.lat, r.destination.lon];
  const flown = kmBetween(o, pos);
  const remaining = kmBetween(pos, d);
  const total = r.distanceKm || flown + remaining;
  return {
    o, d, pos, flown: Math.round(flown), remaining: Math.round(remaining), total: Math.round(total),
    pct: clamp((flown / Math.max(1, flown + remaining)) * 100, 0, 100),
    minutesLeft: a.gs && a.gs > 40 && !a.gnd ? (remaining / (a.gs * 1.852)) * 60 : null,
  };
}

const AIRPORT_PIN = (ap, kind) =>
  L.divIcon({
    className: '',
    html: `<div class="ap-pin ${kind}"><span class="ap-dot"></span><b>${esc(
      ap.iata || ap.icao || ''
    )}</b><span class="ap-city">${esc(ap.city || ap.name || '')}</span><span class="ap-kind">${
      kind === 'from' ? 'departed' : 'arriving'
    }</span></div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });

/** Draw the great circle: solid for the distance already flown, dashed ahead. */
function drawRouteLayer(a) {
  routeLayer.clearLayers();
  if (!a || !state.filters.route) return;
  const pr = routeProgress(a);
  if (!pr) return;

  L.polyline(unwrapLons(geodesic(pr.o, pr.pos)), {
    color: '#f7c948', weight: 2.2, opacity: 0.9, interactive: false,
  }).addTo(routeLayer);
  L.polyline(unwrapLons(geodesic(pr.pos, pr.d)), {
    color: '#f7c948', weight: 1.8, opacity: 0.45, dashArray: '7 8', interactive: false,
  }).addTo(routeLayer);

  for (const [ap, ll, kind] of [
    [a.route.origin, pr.o, 'from'],
    [a.route.destination, pr.d, 'to'],
  ]) {
    L.marker(ll, { icon: AIRPORT_PIN(ap, kind), interactive: true, keyboard: false })
      .addTo(routeLayer)
      .bindTooltip(
        `<b>${esc(ap.iata || ap.icao || '')}</b> ${esc(ap.name || '')}<br>${esc(
          [ap.city, ap.country].filter(Boolean).join(', ')
        )}`,
        { direction: 'top', className: 'ap-tip' }
      );
  }
}

/* ───────────────────────── live airport view ─────────────────────────── */

/* Clicking a tower opens the airport: what is on its apron right now, what is
 * inbound and what has just left. Everything comes from aircraft we are
 * already tracking, plus a dedicated poll of the airport's own airspace so the
 * view stays live even when the map is looking somewhere else. */

const GROUND_RADIUS_KM = 9;      // apron / taxiway / runway
const DEPARTED_RADIUS_KM = 500;  // still counts as "just left"

function sameAirport(x, ap) {
  if (!x) return false;
  return (x.iata && x.iata === ap.iata) || (x.icao && x.icao === ap.icao);
}

function airportTraffic(ap) {
  const ground = [];
  const arriving = [];
  const departing = [];

  for (const a of fleet.values()) {
    if (a.lat === undefined) continue;
    const km = kmBetween([a.dlat ?? a.lat, a.dlon ?? a.lon], [ap.lat, ap.lon]);
    if (km > 4000) continue;

    if (a.nt || (a.cat && a.cat[0] === 'C')) continue; // towers, vehicles, obstacles
    if (a.gnd && km <= GROUND_RADIUS_KM) {
      ground.push({ a, km });
      continue;
    }
    // A jet that has just lifted off is still the airport's traffic, but it is
    // no longer "on the ground" - it falls through to the departed list below.
    const r = a.route;
    if (!r) continue;
    if (sameAirport(r.destination, ap)) arriving.push({ a, km });
    else if (sameAirport(r.origin, ap) && km <= DEPARTED_RADIUS_KM) departing.push({ a, km });
  }

  const byDistance = (x, y) => x.km - y.km;
  arriving.sort(byDistance);
  departing.sort(byDistance);

  // Split the field itself into what is rolling and what is standing still -
  // an aircraft on a runway is the interesting one, a parked airframe is not.
  const moving = ground
    .filter((e) => (e.a.gs ?? 0) >= TAXI_KT)
    .sort((x, y) => (y.a.gs ?? 0) - (x.a.gs ?? 0));
  const parked = ground.filter((e) => (e.a.gs ?? 0) < TAXI_KT).sort(byDistance);

  return { ground, moving, parked, arriving, departing };
}

function etaMinutes(entry) {
  const { a, km } = entry;
  if (!a.gs || a.gs < 60) return null;
  return (km / (a.gs * 1.852)) * 60;
}

function trafficRow(entry, kind) {
  const { a, km } = entry;
  const iata = airlineIata(a);
  const eta = kind === 'arriving' ? etaMinutes(entry) : null;
  const right =
    kind === 'ground'
      ? groundStatus(a)
      : eta !== null
        ? fmtDuration(eta)
        : `${nf.format(Math.round(km))} km`;
  // A parked aircraft often broadcasts no callsign, in which case the row is
  // headed by its registration - so do not print that registration twice.
  const title = a.cs || a.reg || a.id.toUpperCase();
  return `<div class="ap-row" data-id="${a.id}" role="button" tabindex="0">
    ${iata ? logoImgHtml(iata, 'ap-row-logo') : '<span class="ap-row-logo"></span>'}
    <span class="ap-row-cs">${esc(title)}</span>
    <span class="ap-row-meta">${esc(modelOf(a) || a.typ || 'unknown type')}${
      a.reg && a.reg !== title ? ' · ' + esc(a.reg) : ''
    }</span>
    <span class="ap-row-right${
      kind === 'ground' && (a.gs ?? 0) >= 40 ? ' rolling' : ''
    }">${esc(right)}</span>
  </div>`;
}

function renderAirport() {
  const ap = state.airport;
  if (!ap) return;
  const t = airportTraffic(ap);
  const flag = REF.flagOf(ap.country);

  const section = (title, list, kind, empty, cap = 12) => `
    <div class="ap-sec">
      <h4>${title} <b>${list.length}</b></h4>
      ${
        list.length
          ? list.slice(0, cap).map((e) => trafficRow(e, kind)).join('') +
            (list.length > cap ? `<div class="ap-more">+ ${list.length - cap} more</div>` : '')
          : `<div class="ap-empty">${empty}</div>`
      }
    </div>`;

  $('#airport-body').innerHTML = `
    <div class="ap-head">
      <div class="ap-code">${esc(ap.iata || ap.icao)}</div>
      <div class="ap-name">${esc(ap.name)}</div>
      <div class="ap-where">${flag} ${esc([ap.city, ap.country].filter(Boolean).join(', '))}${
        ap.icao ? ' · ' + esc(ap.icao) : ''
      }${ap.elev != null ? ' · ' + nf.format(ap.elev) + ' ft' : ''}</div>
    </div>
    ${weatherBlock(ap)}
    <div class="ap-stats">
      <div><b>${t.ground.length}</b><span>on ground</span></div>
      <div><b>${t.arriving.length}</b><span>inbound</span></div>
      <div><b>${t.departing.length}</b><span>departed</span></div>
    </div>
    ${section('Inbound', t.arriving, 'arriving', 'No inbound flights are being tracked right now.')}
    ${section(
      'On a runway or taxiway',
      t.moving,
      'ground',
      'Nothing is moving on the field right now.'
    )}
    ${section(
      'Standing at the airport',
      t.parked,
      'ground',
      'No parked aircraft are being heard — ground receivers do not cover every airport.'
    )}
    ${section('Just departed', t.departing, 'departing', 'No recent departures being tracked.')}
    ${landedBlock(ap)}
    <div class="ap-foot">Built from aircraft currently being tracked, not from an airline schedule — so it shows what is flying, not what is timetabled.</div>`;

  $('#airport-body').querySelectorAll('.hist-arr').forEach((row) => {
    row.onclick = (e) => {
      e.stopPropagation();
      if (row.dataset.hex) showHistoryTrack(row.dataset.hex, Number(row.dataset.time), null);
    };
  });

  $('#airport-body').querySelectorAll('.ap-row:not(.hist-arr)').forEach((row) => {
    row.onclick = () => {
      const a = fleet.get(row.dataset.id);
      if (!a) return;
      map.setView([a.dlat ?? a.lat, a.dlon ?? a.lon], Math.max(map.getZoom(), 9));
      select(a.id);
    };
  });
}

function selectAirport(ap) {
  state.airport = ap;
  if (!ap) {
    $('#airport').hidden = true;
    draw();
    return;
  }
  select(null); // an aircraft and an airport should not both own the panel
  renderAirport();
  $('#airport').hidden = false;
  pollAirport();
  draw();
}

/* Poll the selected airport's own airspace, so its traffic keeps updating even
 * if the map has been panned somewhere else entirely. */
let airportTimer = null;

async function pollAirport() {
  clearTimeout(airportTimer);
  const ap = state.airport;
  if (!ap) return;

  const dLat = 1.6;
  const dLon = 1.6 / Math.max(0.2, Math.cos((ap.lat * Math.PI) / 180));
  const qs = new URLSearchParams({
    lamin: (ap.lat - dLat).toFixed(4),
    lomin: (ap.lon - dLon).toFixed(4),
    lamax: (ap.lat + dLat).toFixed(4),
    lomax: (ap.lon + dLon).toFixed(4),
  });
  try {
    const res = await fetch(`/api/flights?${qs}`, { cache: 'no-store' });
    const json = await res.json();
    if (res.ok) {
      ingest(json, true); // partial: must not evict the rest of the map
      renderAirport();
    }
  } catch {
    /* the next tick tries again */
  }
  airportTimer = setTimeout(pollAirport, 12000);
}

$('#airport-close').onclick = () => selectAirport(null);

/* ─────────────────────────── selection + detail ───────────────────────── */

function select(id) {
  if (id && state.airport) { state.airport = null; $('#airport').hidden = true; clearTimeout(airportTimer); }
  state.selected = id;
  if (!id) {
    state.follow = false;
    $('#detail').hidden = true;
    routeLayer.clearLayers();
  } else {
    renderDetail();
    $('#detail').hidden = false;
    refreshSelected();
    const a = fleet.get(id);
    if (a && !a.detailsDone) {
      loadDetails(a).then(() => {
        if (state.selected === id) { renderDetail(); drawRouteLayer(a); }
      });
    } else {
      drawRouteLayer(a);
    }
  }
  syncHash();
  heartbeat();
  draw();
}

/* The origin -> destination strip: airport names, where the flight is along
 * the way, how far is left and roughly when it arrives. */
function routeStripHtml(a) {
  if (!a.route) {
    if (!a.detailsDone) return '<div class="d-route pending">Looking up route&hellip;</div>';
    return `<div class="d-route pending">No published route for ${
      a.cs ? 'callsign ' + esc(a.cs) : 'this aircraft'
    } &mdash; private or non-scheduled flight</div>`;
  }
  const r = a.route;
  const pr = routeProgress(a);
  const ap = (x, side) => `
    <div class="rt-ap ${side}">
      <b>${esc(x.iata || x.icao || '??')}</b>
      <span class="rt-city">${esc(x.city || x.name || '')}</span>
      <span class="rt-ctry">${REF.flagOf(x.iso)} ${esc(x.icao || '')}</span>
    </div>`;

  const left = pr && pr.minutesLeft !== null ? fmtDuration(pr.minutesLeft) : null;
  const eta =
    pr && pr.minutesLeft !== null
      ? new Date(Date.now() + pr.minutesLeft * 60000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null;

  return `
    <div class="d-route">
      <div class="rt-row">
        ${ap(r.origin, 'from')}
        <div class="rt-mid">
          <div class="rt-bar"><i style="width:${pr ? pr.pct.toFixed(1) : 0}%"></i>
            <svg class="rt-plane" style="left:${pr ? pr.pct.toFixed(1) : 0}%" viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>
          </div>
          <div class="rt-meta">${
            pr
              ? `${nf.format(pr.remaining)} km to go${left ? ' &middot; ' + left : ''}`
              : r.distanceKm
                ? nf.format(r.distanceKm) + ' km'
                : ''
          }</div>
        </div>
        ${ap(r.destination, 'to')}
      </div>
      <div class="rt-names">
        <span title="${esc(r.origin.name || '')}">${esc(r.origin.name || r.origin.icao)}</span>
        <em>&rarr;</em>
        <span title="${esc(r.destination.name || '')}">${esc(r.destination.name || r.destination.icao)}</span>
      </div>
      ${r.via && r.via.length ? `<div class="rt-via">via ${r.via.map((v) => esc(v.iata || v.icao)).join(', ')}</div>` : ''}
      ${eta ? `<div class="rt-eta">Arriving about <b>${eta}</b> &middot; your local time</div>` : ''}
    </div>`;
}

function renderDetail() {
  const a = fleet.get(state.selected);
  if (!a) return;
  const air = REF.decodeCallsign(a.cs);
  const country = REF.lookupCountry(a.id);
  const info = a.info || null;
  // The route lookup carries a canonical airline name and operator; prefer
  // those over the local tables when they arrive.
  const airlineName =
    (a.route && a.route.airline && a.route.airline.name) || (info && info.owner) || (air && air.name) || null;
  const airlineIso = (a.route && a.route.airline && a.route.airline.iso) || (info && info.ownerIso) || (air && air.iso) || null;
  const flag = REF.flagOf(airlineIso || (country && country.iso));
  const model =
    modelOf(a) || (info && [info.manufacturer, info.model].filter(Boolean).join(' ')) || null;
  const operator = (info && info.owner) || (a.op ? tidyModel(a.op) : null);
  const sqMeaning = a.sqk && REF.SQUAWKS[a.sqk];
  const special = a.emg || isSpecialSquawk(a.sqk);
  const center = map.getCenter();
  const distKm = center.distanceTo(L.latLng(a.dlat ?? a.lat, a.dlon ?? a.lon)) / 1000;
  const vsCls = (a.vs ?? 0) > 60 ? 'vs-up' : (a.vs ?? 0) < -60 ? 'vs-dn' : '';
  const iata = airlineIata(a);
  // A real photograph of this airframe when one exists, else the database's.
  const photoSrc = (a.photo && (a.photo.large || a.photo.thumb)) || (info && info.photo) || null;

  const rows = [
    ['Registration', a.reg || (info && info.reg) || '—'],
    ...(operator ? [['Operator', `${REF.flagOf(info && info.ownerIso)} ${operator}`.trim()]] : []),
    ...(a.yr ? [['Built', a.yr]] : []),
    ...(a.route && a.route.airline && a.route.airline.radio
      ? [['Radio callsign', a.route.airline.radio]]
      : []),
    ...(a.route && a.route.distanceKm ? [['Route distance', nf.format(a.route.distanceKm) + ' km']] : []),
    ['Aircraft type', a.typ ? `${a.typ}${model ? ' · ' + model : ''}` : model || '—'],
    ['ICAO 24-bit', a.id.toUpperCase()],
    ['Registered in', country ? `${REF.flagOf(country.iso)} ${country.name}` : a.ctry || '—'],
    ['Squawk', a.sqk ? `${a.sqk}${sqMeaning ? ' · ' + sqMeaning : ''}` : '—'],
    ['Category', (a.cat && REF.CATEGORIES[a.cat]) || a.cat || '—'],
    ['Geometric alt.', a.galt != null ? nf.format(a.galt) + ' ft' : '—'],
    ['Position', fmtCoord(a.lat, a.lon)],
    ['From map centre', `${nf.format(Math.round(distKm))} km`],
    ['Signal age', ago(a.seen)],
    ['Feed', a.src === 'adsb.lol' ? 'adsb.lol (ADS-B)' : 'OpenSky Network'],
    ...(a.route ? [['Route data', a.route.source]] : []),
  ];

  $('#detail-body').innerHTML = `
    <div class="d-head">
      ${photoSrc ? `<div class="d-shot"><img id="d-photo" src="${esc(photoSrc)}" alt="Photograph of ${esc(
        a.reg || a.id
      )}" referrerpolicy="no-referrer" loading="lazy">${
        a.photo && a.photo.photographer
          ? `<a class="d-credit" href="${esc(a.photo.link || '#')}" target="_blank" rel="noopener noreferrer">© ${esc(
              a.photo.photographer
            )} · planespotters.net</a>`
          : ''
      }</div>` : ''}
      ${iata ? `<img class="d-logo" src="${esc(logoWide(iata))}" alt="${esc(airlineName || iata)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : ''}
      <div class="d-cs">${flag ? `<span class="d-flag">${flag}</span>` : ''}${esc(a.cs || a.reg || a.id.toUpperCase())}</div>
      ${airlineName ? `<div class="d-airline">${esc(airlineName)}${
        a.route && a.route.iata ? ' · flight ' + esc(a.route.iata) : air && air.number ? ' · flight ' + esc(air.number) : ''
      }</div>` : ''}
      <div class="d-model">${esc(model || (a.typ ? a.typ : 'Aircraft type unknown'))}${
        a.reg || (info && info.reg) ? ' · ' + esc(a.reg || info.reg) : ''
      }</div>
      ${a.route ? `<div class="d-od">${esc(a.route.origin.city || a.route.origin.name || a.route.origin.iata)} <em>&rarr;</em> ${esc(
        a.route.destination.city || a.route.destination.name || a.route.destination.iata
      )}</div>` : ''}
      <div class="d-tags">
        ${special ? `<span class="tag emg">${esc(a.emg || REF.SQUAWKS[a.sqk] || 'emergency')}</span>` : ''}
        ${a.mil ? '<span class="tag mil">military</span>' : ''}
        ${a.gnd ? '<span class="tag gnd">on ground</span>' : '<span class="tag live">airborne</span>'}
        <span class="tag">${esc(a.src)}</span>
      </div>
    </div>
    ${a.cs || a.route ? routeStripHtml(a) : ''}
    ${pathBlock(a)}
    ${historyBlock(a)}
    <div class="d-grid">
      <div class="d-cell"><label>Altitude</label><b>${a.gnd ? 'ground' : fmtNum(a.alt)}${a.gnd ? '' : '<small>ft</small>'}</b></div>
      <div class="d-cell"><label>Ground speed</label><b>${fmtNum(a.gs)}<small>kt</small></b></div>
      <div class="d-cell"><label>Vertical rate</label><b class="${vsCls}">${fmtVs(a.vs)}</b></div>
      <div class="d-cell"><label>Track</label><b>${a.trk != null ? Math.round(a.trk) + '°' : '—'}<small>${bearingName(a.trk)}</small></b></div>
    </div>
    <div class="d-rows">
      ${rows.map(([k, v]) => `<div class="d-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
    </div>
    <div class="d-actions">
      <button id="btn-follow" class="${state.follow ? 'on' : ''}">${state.follow ? 'Following' : 'Follow'}</button>
      <button id="btn-center">Centre</button>
      <button id="btn-copy">Copy</button>
    </div>`;

  const photo = document.getElementById('d-photo');
  if (photo) photo.addEventListener('error', () => photo.remove());

  $('#btn-follow').onclick = () => {
    state.follow = !state.follow;
    if (state.follow) map.setView([a.dlat ?? a.lat, a.dlon ?? a.lon], Math.max(map.getZoom(), 7));
    renderDetail();
  };
  $('#btn-center').onclick = () => map.setView([a.dlat ?? a.lat, a.dlon ?? a.lon], Math.max(map.getZoom(), 8));

  $('#detail-body').querySelectorAll('.hist-row').forEach((row) => {
    row.onclick = () =>
      showHistoryTrack(row.dataset.hex, Number(row.dataset.time), row.dataset.key);
  });
  const hc = $('#hist-clear');
  if (hc) hc.onclick = (e) => { e.stopPropagation(); clearHistoryTrack(); };
  $('#btn-copy').onclick = () => {
    const pr = routeProgress(a);
    const text = [
      `${a.cs || a.id.toUpperCase()}${airlineName ? ' (' + airlineName + ')' : ''}`,
      ...(a.route
        ? [
            `From: ${a.route.origin.name || ''} (${a.route.origin.iata || a.route.origin.icao}), ${
              [a.route.origin.city, a.route.origin.country].filter(Boolean).join(', ')
            }`,
            `To: ${a.route.destination.name || ''} (${a.route.destination.iata || a.route.destination.icao}), ${
              [a.route.destination.city, a.route.destination.country].filter(Boolean).join(', ')
            }`,
            ...(pr ? [`Remaining: ${nf.format(pr.remaining)} km of ${nf.format(pr.total)} km`] : []),
          ]
        : []),
      ...rows.map(([k, v]) => `${k}: ${v}`),
      `Altitude: ${fmtAlt(a.alt, a.gnd)}`,
      `Ground speed: ${fmtNum(a.gs, ' kt')}`,
    ].join('\n');
    navigator.clipboard?.writeText(text).then(() => toast('Flight details copied'), () => toast('Copy failed'));
  };
}

$('#detail-close').onclick = () => select(null);

/* ──────────────────────────── route queries ───────────────────────────
 * "DEL-BOM", "LHR > JFK", "from DEL", "to BOM", "London to New York". The
 * left and right sides each resolve to a set of airports - a code matches one,
 * a city name matches all of that city's fields - and a flight matches when
 * its origin and destination both fall in the right sets.                   */

const AP_BY_CODE = new Map();
for (const ap of AIRPORTS) {
  if (ap.iata) AP_BY_CODE.set(ap.iata.toUpperCase(), ap);
  if (ap.icao) AP_BY_CODE.set(ap.icao.toUpperCase(), ap);
}

/** Airports a search term could mean, best first. Codes win outright, then a
 *  city or airport name that starts with the term, then one that contains it;
 *  large airports before small ones at equal footing. */
function matchAirports(term, limit = 12) {
  const t = term.trim().toUpperCase();
  if (!t) return null;

  const exact = AP_BY_CODE.get(t);
  if (exact) return [exact];
  if (t.length < 3) return null; // two letters matches half the world

  const hits = [];
  for (const ap of AIRPORTS) {
    const city = (ap.city || '').toUpperCase();
    const name = (ap.name || '').toUpperCase();
    let rank;
    if (city === t) rank = 0;
    else if (city.startsWith(t) || name.startsWith(t)) rank = 1;
    else if (city.includes(t) || name.includes(t)) rank = 2;
    else continue;
    hits.push({ ap, rank });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.rank - b.rank || a.ap.size - b.ap.size);
  return hits.slice(0, limit).map((h) => h.ap);
}

const ROUTE_ARROW = /^(.*?)\s*(?:->|-->|→|=>|>|\/|\bTO\b|-|–|—)\s*(.*)$/;

/** Read a query as an origin/destination pair, or return null. */
function parseRouteQuery(raw) {
  const q = raw.trim().toUpperCase();
  if (!q) return null;

  let fromTerm = null;
  let toTerm = null;

  let m = /^FROM\s+(.+)$/.exec(q);
  if (m) fromTerm = m[1];
  else if ((m = /^TO\s+(.+)$/.exec(q))) toTerm = m[1];
  else if ((m = ROUTE_ARROW.exec(q))) {
    fromTerm = m[1] || null;
    toTerm = m[2] || null;
    // "A320-200" and "B737-800" are types, not routes.
    if (fromTerm && toTerm && /^\d+$/.test(toTerm)) return null;
  } else {
    // Two bare words are a route only if both are recognisable airports,
    // so "AIR INDIA" stays an ordinary search.
    const parts = q.split(/\s+/);
    if (parts.length === 2 && AP_BY_CODE.has(parts[0]) && AP_BY_CODE.has(parts[1])) {
      fromTerm = parts[0];
      toTerm = parts[1];
    }
  }

  if (!fromTerm && !toTerm) return null;

  const from = fromTerm ? matchAirports(fromTerm) : null;
  const to = toTerm ? matchAirports(toTerm) : null;
  if (fromTerm && !from) return null;
  if (toTerm && !to) return null;
  if (!from && !to) return null;

  return { from, to, fromTerm, toTerm };
}

function endMatches(end, airports) {
  if (!airports) return true; // that side was not specified
  if (!end) return false;
  return airports.some(
    (ap) => (ap.iata && ap.iata === end.iata) || (ap.icao && ap.icao === end.icao)
  );
}

function matchesRoute(a, rq) {
  if (!a.route) return false;
  return endMatches(a.route.origin, rq.from) && endMatches(a.route.destination, rq.to);
}

/** How the query is echoed back to the user, e.g. "DEL → any". */
function routeLabel(rq) {
  const side = (list, term) => {
    if (!list) return 'anywhere';
    if (list.length === 1) return list[0].iata || list[0].icao;
    return `${term} (${list.length} airports)`;
  };
  return `${side(rq.from, rq.fromTerm)} → ${side(rq.to, rq.toTerm)}`;
}

/* ──────────────────────────────── search ─────────────────────────────── */

const searchEl = $('#search');
const resultsEl = $('#results');
let resultIdx = -1;
let currentResults = [];

function runSearch() {
  const q = searchEl.value.trim().toUpperCase();
  if (q.length < 2) { resultsEl.hidden = true; setMatches([]); clearRouteFilter(); return; }

  const rq = parseRouteQuery(q);
  // Emptying or rewriting the box must not leave the map narrowed to a leg
  // that is no longer on screen anywhere.
  if (!rq) clearRouteFilter();
  state.routeQuery = rq;
  if (rq) return runRouteSearch(rq, q);

  // Airports come first: "Coimbatore" is a place you want to go to, and it is
  // answerable from the bundled table whether or not any of its traffic is
  // currently loaded.
  const airports = matchAirports(q, 6) || [];

  const scored = [];
  for (const a of fleet.values()) {
    const air = REF.decodeCallsign(a.cs);
    const hay = [a.cs, a.reg, a.id, a.typ, air && air.name, REF.typeName(a.typ)].filter(Boolean).join(' ').toUpperCase();
    const i = hay.indexOf(q);
    if (i !== -1) {
      const exact = (a.cs || '').toUpperCase() === q || (a.reg || '').toUpperCase() === q;
      scored.push({ a, score: (exact ? -100 : 0) + i });
      continue;
    }
    // A flight into or out of a matched airport is also an answer to the query.
    if (airports.length && a.route) {
      const aps = routeAirports(a) || [];
      if (aps.some((code) => airports.some((ap) => ap.iata === code || ap.icao === code))) {
        scored.push({ a, score: 500 });
      }
    }
  }
  scored.sort((x, y) => x.score - y.score);

  const acItems = scored.slice(0, 40).map((x) => ({ kind: 'ac', a: x.a }));
  currentResults = [...airports.map((ap) => ({ kind: 'ap', ap })), ...acItems];
  resultIdx = currentResults.length ? 0 : -1;
  // Everything that matched is highlit, even past the forty that are listed.
  setMatches(scored.map((x) => x.a.id));

  const rows = currentResults
    .map((item, i) => {
      if (item.kind === 'ap') return airportResultRow(item.ap, i, i === 0);
      const a = item.a;
      const air = REF.decodeCallsign(a.cs);
      const leg =
        a.route && scored.find((x) => x.a === a && x.score === 500)
          ? `${a.route.origin.iata || a.route.origin.icao} \u2192 ${
              a.route.destination.iata || a.route.destination.icao
            } · `
          : '';
      const meta = leg + [air && air.name, modelOf(a), a.reg].filter(Boolean).join(' · ');
      const li = airlineIata(a);
      return `<div class="res${i === resultIdx ? ' on' : ''}" data-i="${i}" role="option">
        ${li ? logoImgHtml(li, 'res-logo') : '<span class="res-logo"></span>'}
        <span class="cs">${esc(a.cs || a.reg || a.id.toUpperCase())}</span>
        <span class="meta">${esc(meta || 'unknown aircraft')}</span>
        <span class="alt">${esc(fmtAlt(a.alt, a.gnd))}</span></div>`;
    })
    .join('');

  resultsEl.innerHTML =
    rows ||
    `<div class="res-empty">Nothing matching \u201c${esc(q)}\u201d — no airport of that
     name, and no aircraft in view.<br>Airport names and IATA/ICAO codes work
     here too, e.g. <b>Coimbatore</b> or <b>CJB</b>.</div>`;
  resultsEl.hidden = false;
}

resultsEl.addEventListener('click', (e) => {
  const row = e.target.closest('.res');
  if (!row) return;
  pickResult(currentResults[Number(row.dataset.i)]);
});

/** A result is either an aircraft or an airport; both are things you can go to. */
function pickResult(item) {
  if (!item) return;
  resultsEl.hidden = true;
  searchEl.blur();
  if (item.kind === 'ap') {
    const ap = item.ap;
    map.setView([ap.lat, ap.lon], Math.max(map.getZoom(), 11), { animate: false });
    selectAirport(ap);
    return;
  }
  const a = item.a;
  map.setView([a.dlat ?? a.lat, a.dlon ?? a.lon], Math.max(map.getZoom(), 8));
  select(a.id);
}

/** One row for an airport: where it is, and what we can already see there. */
function airportResultRow(ap, i, active) {
  const t = fleet.size ? airportTraffic(ap) : { ground: [], arriving: [], departing: [] };
  const here = t.ground.length + t.arriving.length;
  return `<div class="res res-ap${active ? ' on' : ''}" data-i="${i}" role="option">
    <span class="res-apcode">${esc(ap.iata || ap.icao)}</span>
    <span class="meta"><span class="res-apname">${esc(ap.name)}</span>
      ${REF.flagOf(ap.country)} ${esc([ap.city, ap.country].filter(Boolean).join(', '))}</span>
    <span class="alt">${here ? `${here} here` : 'airport'}</span></div>`;
}

/** Highlight a set of aircraft on the map; an empty list clears it. */
function setMatches(ids) {
  const next = new Set(ids);
  if (next.size === state.matches.size && [...next].every((id) => state.matches.has(id))) return;
  state.matches = next;
  draw();
}

function clearRouteFilter() {
  state.routeQuery = null;
  if (!state.routeOnly) return;
  state.routeOnly = false;
  const only = $('#route-only');
  if (only) { only.classList.remove('on'); only.textContent = 'Show only these'; }
  draw();
}

/* Everything that can currently keep an aircraft off the map, or push it into
 * the background, in the words a person would use. */
function activeRestrictions() {
  const f = state.filters;
  const out = [];
  if (state.routeOnly && state.routeQuery) out.push(`only ${routeLabel(state.routeQuery)}`);
  const fc = state.facets;
  if (fc.airlines.size) out.push(`${fc.airlines.size} airline${fc.airlines.size > 1 ? 's' : ''}`);
  if (fc.types.size) out.push(`${fc.types.size} model${fc.types.size > 1 ? 's' : ''}`);
  if (fc.classes.size) out.push(`${fc.classes.size} class${fc.classes.size > 1 ? 'es' : ''}`);
  if (fc.airports.size) out.push(`${fc.airports.size} airport${fc.airports.size > 1 ? 's' : ''}`);
  if (!f.ground) out.push('ground traffic hidden');
  if (f.mil) out.push('military only');
  if (f.emg) out.push('emergencies only');
  if (f.altMin > 0 || f.altMax < 60000) out.push(`${nf.format(f.altMin)}–${nf.format(f.altMax)} ft`);
  if (f.spdMin > 0) out.push(`over ${f.spdMin} kt`);
  return out;
}

let lastChipText = null;

function updateViewChip(shown, total) {
  const reasons = activeRestrictions();
  const chip = $('#view-chip');
  // A search dims rather than hides, so it is counted separately - claiming
  // "showing 526 of 527" while eight aircraft stand out would be a lie.
  const hl = state.matches.size ? `search \u201c${searchEl.value.trim()}\u201d` : null;
  if (!reasons.length && !hl) {
    if (lastChipText !== null) { chip.hidden = true; lastChipText = null; }
    return;
  }

  const parts = [];
  if (reasons.length) parts.push(`Showing ${nf.format(shown)} of ${nf.format(total)}`, ...reasons);
  if (hl) {
    parts.push(
      reasons.length
        ? `${nf.format(state.matches.size)} highlighted \u00b7 ${hl}`
        : `Highlighting ${nf.format(state.matches.size)} of ${nf.format(total)}`,
      ...(reasons.length ? [] : [hl])
    );
  }
  const text = parts.join(' \u00b7 ');
  if (text !== lastChipText) {
    $('#view-chip-text').textContent = text;
    chip.hidden = false;
    lastChipText = text;
  }
}

/** One click back to every aircraft the feed is giving us. */
function showEverything() {
  searchEl.value = '';
  resultsEl.hidden = true;
  state.matches = new Set();
  state.routeQuery = null;
  state.routeOnly = false;
  const only = $('#route-only');
  if (only) { only.classList.remove('on'); only.textContent = 'Show only these'; }
  $('#f-reset').onclick();   // facets, altitude, speed and the checkboxes
  draw();
}

$('#view-chip-clear').onclick = showEverything;

// Come back to life the moment the network does, rather than waiting out the
// current backoff.
window.addEventListener('online', () => {
  setLive('ok', 'reconnecting');
  poll();
});
window.addEventListener('offline', () => setLive('warn', 'offline'));

searchEl.addEventListener('input', runSearch);
searchEl.addEventListener('focus', runSearch);
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    resultsEl.hidden = true;
    searchEl.value = '';
    setMatches([]);
    clearRouteFilter();
    searchEl.blur();
    return;
  }
  if (!currentResults.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    resultIdx = clamp(resultIdx + (e.key === 'ArrowDown' ? 1 : -1), 0, currentResults.length - 1);
    resultsEl.querySelectorAll('.res').forEach((el, i) => el.classList.toggle('on', i === resultIdx));
    resultsEl.children[resultIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    pickResult(currentResults[Math.max(0, resultIdx)]);
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchwrap')) resultsEl.hidden = true;
});

/* Flights on this leg, and an honest note about the ones we cannot answer for
 * yet: a route is a separate lookup per callsign, resolved a few at a time for
 * what is on screen, so a wide view has plenty of aircraft still unlabelled. */
function runRouteSearch(rq, q) {
  const matches = [];
  let known = 0;
  let pending = 0;
  for (const a of fleet.values()) {
    if (!a.cs) continue;
    if (a.route) {
      known++;
      if (matchesRoute(a, rq)) matches.push(a);
    } else if (AIRLINE_CALLSIGN.test(a.cs)) {
      pending++;
    }
  }

  matches.sort((x, y) => (x.cs || '').localeCompare(y.cs || ''));
  currentResults = matches.slice(0, 40).map((a) => ({ kind: 'ac', a }));
  resultIdx = currentResults.length ? 0 : -1;
  setMatches(matches.map((a) => a.id));

  const head = `<div class="res-head">
      <b>${matches.length}</b> ${matches.length === 1 ? 'flight' : 'flights'} ${esc(routeLabel(rq))}
      ${matches.length ? `<button class="res-only${state.routeOnly ? ' on' : ''}" id="route-only">${state.routeOnly ? 'Showing only these' : 'Show only these'}</button>` : ''}
    </div>`;

  const foot = pending
    ? `<div class="res-note">Searched ${known} flights whose route is known.
       ${pending} more in this view are still being looked up — results fill in as they arrive.</div>`
    : '';

  resultsEl.innerHTML =
    head +
    (currentResults.length
      ? currentResults
          .map(({ a }, i) => {
            const air = REF.decodeCallsign(a.cs);
            const li = airlineIata(a);
            const leg = `${a.route.origin.iata || a.route.origin.icao} \u2192 ${
              a.route.destination.iata || a.route.destination.icao
            }`;
            return `<div class="res${i === 0 ? ' on' : ''}" data-i="${i}" role="option">
              ${li ? logoImgHtml(li, 'res-logo') : '<span class="res-logo"></span>'}
              <span class="cs">${esc(a.cs || a.id.toUpperCase())}</span>
              <span class="meta"><span class="res-leg">${esc(leg)}</span> ${esc(
                [air && air.name, modelOf(a)].filter(Boolean).join(' \u00b7 ')
              )}</span>
              <span class="alt">${esc(fmtAlt(a.alt, a.gnd))}</span></div>`;
          })
          .join('')
      : `<div class="res-empty">No tracked flight is currently flying ${esc(routeLabel(rq))}.<br>
         It may not be airborne right now, or not yet in the area you are looking at.</div>`) +
    foot;

  const only = $('#route-only');
  if (only) {
    only.onclick = (e) => {
      e.stopPropagation();
      state.routeOnly = !state.routeOnly;
      only.classList.toggle('on', state.routeOnly);
      only.textContent = state.routeOnly ? 'Showing only these' : 'Show only these';
      draw(); // the chip updates itself from the draw pass
    };
  }
  resultsEl.hidden = false;
  // A route query is worth resolving faster than the idle trickle.
  prefetchRoutes();
}

/* ──────────────────────────── panels & filters ───────────────────────── */

const PANELS = ['filters', 'layers', 'watch'];

function togglePanel(id) {
  const el = document.getElementById(id);
  for (const other of PANELS) {
    if (other === id) continue;
    document.getElementById(other).hidden = true;
    $(`#btn-${other}`).classList.remove('on');
  }
  el.hidden = !el.hidden;
  $(`#btn-${id}`).classList.toggle('on', !el.hidden);
  if (id === 'filters' && !el.hidden) renderFacets();
  if (id === 'watch' && !el.hidden) refreshPopular();
}
$('#btn-filters').onclick = () => togglePanel('filters');
$('#btn-layers').onclick = () => togglePanel('layers');
$('#btn-watch').onclick = () => togglePanel('watch');

heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(() => {
  // Only poll the board while it is actually on screen.
  if (!$('#watch').hidden) refreshPopular();
}, POPULAR_MS);

// A route search or airport filter needs route data faster than the poll
// delivers it, so top it up between polls for as long as one is open.
setInterval(() => {
  if (state.routeQuery || state.facets.airports.size) prefetchRoutes();
}, 3000);
document.querySelectorAll('[data-close]').forEach((b) => {
  b.onclick = () => {
    document.getElementById(b.dataset.close).hidden = true;
    $(`#btn-${b.dataset.close}`).classList.remove('on');
  };
});

$('#style-list').innerHTML = Object.entries(MAP_STYLES)
  .map(([k, v]) => `<div class="style-opt" data-style="${k}">${v.label}</div>`)
  .join('');
$('#style-list').addEventListener('click', (e) => {
  const o = e.target.closest('.style-opt');
  if (o) applyStyle(o.dataset.style);
});

$('#f-radar').addEventListener('change', (e) => setRadar(e.target.checked));
if (state.radar) setRadar(true);

const altMin = $('#alt-min'), altMax = $('#alt-max'), spdMin = $('#spd-min');

function syncFilters() {
  let lo = Number(altMin.value), hi = Number(altMax.value);
  if (lo > hi) { [lo, hi] = [hi, lo]; altMin.value = lo; altMax.value = hi; }
  state.filters.altMin = lo;
  state.filters.altMax = hi;
  state.filters.spdMin = Number(spdMin.value);
  $('#alt-label').textContent = `${nf.format(lo)} – ${nf.format(hi)} ft`;
  $('#spd-label').textContent = `${spdMin.value} kt`;
  state.filters.ground = $('#f-ground').checked;
  state.filters.layout = $('#f-layout').checked;
  state.filters.mil = $('#f-mil').checked;
  state.filters.emg = $('#f-emg').checked;
  state.filters.labels = $('#f-labels').checked;
  state.filters.trails = $('#f-trails').checked;
  state.filters.route = $('#f-route').checked;
  state.filters.airports = $('#f-airports').checked;
  state.filters.idline = $('#f-idline').checked;
  state.filters.logos = $('#f-logos').checked;
  state.filters.smooth = $('#f-smooth').checked;
  state.colorByAlt = $('#f-color-alt').checked;
  persistFilters();
  renderFacets();
  updateStats();
  draw();
}

function persistFilters() {
  localStorage.setItem(
    'st.filters',
    JSON.stringify({
      ...state.filters,
      colorByAlt: state.colorByAlt,
      facets: {
        airlines: [...state.facets.airlines],
        types: [...state.facets.types],
        classes: [...state.facets.classes],
        airports: [...state.facets.airports],
      },
    })
  );
}

['alt-min', 'alt-max', 'spd-min', 'f-ground', 'f-mil', 'f-emg', 'f-labels', 'f-trails', 'f-smooth', 'f-route', 'f-airports', 'f-layout', 'f-idline', 'f-logos', 'f-color-alt']
  .forEach((id) => document.getElementById(id).addEventListener('input', syncFilters));

wireFacet('fc-airlines', state.facets.airlines);
wireFacet('fc-types', state.facets.types);
wireFacet('fc-classes', state.facets.classes);
wireFacet('fc-airports', state.facets.airports);

$('#f-reset').onclick = () => {
  state.facets.airlines.clear();
  state.facets.types.clear();
  state.facets.classes.clear();
  state.facets.airports.clear();
  altMin.value = 0; altMax.value = 60000; spdMin.value = 0;
  $('#f-ground').checked = true;
  $('#f-layout').checked = true;
  ['f-mil', 'f-emg', 'f-labels'].forEach((id) => { $(`#${id}`).checked = false; });
  ['f-trails', 'f-smooth', 'f-route', 'f-airports', 'f-idline', 'f-logos', 'f-color-alt'].forEach((id) => { $(`#${id}`).checked = true; });
  syncFilters();
};

// Restore saved filters
try {
  const saved = JSON.parse(localStorage.getItem('st.filters') || 'null');
  if (saved) {
    altMin.value = saved.altMin ?? 0;
    altMax.value = saved.altMax ?? 60000;
    spdMin.value = saved.spdMin ?? 0;
    $('#f-ground').checked = saved.ground !== false;
    $('#f-layout').checked = saved.layout !== false;
    $('#f-mil').checked = !!saved.mil;
    $('#f-emg').checked = !!saved.emg;
    $('#f-labels').checked = !!saved.labels;
    $('#f-trails').checked = saved.trails !== false;
    $('#f-route').checked = saved.route !== false;
    $('#f-airports').checked = saved.airports !== false;
    $('#f-idline').checked = saved.idline !== false;
    $('#f-logos').checked = saved.logos !== false;
    $('#f-smooth').checked = saved.smooth !== false;
    $('#f-color-alt').checked = saved.colorByAlt !== false;
    if (saved.facets) {
      state.facets.airlines = new Set(saved.facets.airlines || []);
      state.facets.types = new Set(saved.facets.types || []);
      state.facets.classes = new Set(saved.facets.classes || []);
      state.facets.airports = new Set(saved.facets.airports || []);
    }
  }
} catch { /* ignore malformed storage */ }

/* ──────────────────── filter by airline, model, class ────────────────── */

/* The chip lists are built from whatever is actually in view, so they always
 * offer real choices rather than a fixed menu of airlines you cannot see. */

const CLASSES = [
  { key: 'heavy', label: 'Heavy', test: (a) => a.cat === 'A5' || a.cat === 'A4' },
  { key: 'large', label: 'Airliner', test: (a) => a.cat === 'A3' },
  { key: 'small', label: 'Small / regional', test: (a) => a.cat === 'A2' },
  { key: 'light', label: 'Light aircraft', test: (a) => a.cat === 'A1' },
  { key: 'heli', label: 'Helicopter', test: (a) => a.cat === 'A7' || (a.typ && ROTOR_TYPES.has(a.typ)) },
  { key: 'mil', label: 'Military', test: (a) => a.mil },
  { key: 'ground', label: 'Ground vehicle', test: (a) => a.cat && a.cat[0] === 'C' },
];

function classOf(a) {
  for (const c of CLASSES) if (c.test(a)) return c.key;
  return null;
}

/** Does this aircraft survive the airline / model / class chips? */
function passesFacets(a) {
  const f = state.facets;
  if (f.airlines.size) {
    const air = REF.decodeCallsign(a.cs);
    const name = (a.route && a.route.airline && a.route.airline.name) || (air && air.name) || null;
    if (!name || !f.airlines.has(name)) return false;
  }
  if (f.types.size) {
    const t = a.typ || null;
    if (!t || !f.types.has(t)) return false;
  }
  if (f.classes.size && !f.classes.has(classOf(a))) return false;
  if (f.airports.size) {
    const aps = routeAirports(a);
    if (!aps || !aps.some((code) => f.airports.has(code))) return false;
  }
  return true;
}

/** Count the airlines / models / classes present, ignoring their own facet. */
/** The airports a flight touches, as the codes the chips are keyed by. */
function routeAirports(a) {
  if (!a.route) return null;
  const code = (e) => (e && (e.iata || e.icao)) || null;
  const o = code(a.route.origin);
  const d = code(a.route.destination);
  return o || d ? [o, d].filter(Boolean) : null;
}

function facetCounts() {
  const airlines = new Map();
  const types = new Map();
  const classes = new Map();
  const airports = new Map();

  for (const a of fleet.values()) {
    if (!passesBaseFilter(a)) continue;
    const air = REF.decodeCallsign(a.cs);
    const name = (a.route && a.route.airline && a.route.airline.name) || (air && air.name) || null;
    if (name) airlines.set(name, (airlines.get(name) || 0) + 1);
    if (a.typ) types.set(a.typ, (types.get(a.typ) || 0) + 1);
    const c = classOf(a);
    if (c) classes.set(c, (classes.get(c) || 0) + 1);
    // Both ends count: a flight is "at" LHR whether it is leaving or arriving.
    const aps = routeAirports(a);
    if (aps) for (const code of new Set(aps)) airports.set(code, (airports.get(code) || 0) + 1);
  }
  return { airlines, types, classes, airports };
}

const byCountDesc = (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]));

function renderFacets() {
  const { airlines, types, classes, airports } = facetCounts();
  const f = state.facets;

  const chips = (entries, selected, labelOf, limit) => {
    const chosen = entries.filter(([k]) => selected.has(k));
    const rest = entries.filter(([k]) => !selected.has(k)).slice(0, limit);
    return [...chosen, ...rest]
      .map(
        ([k, n]) =>
          `<button class="chip${selected.has(k) ? ' on' : ''}" data-v="${esc(k)}">${esc(
            labelOf(k)
          )}<i>${n}</i></button>`
      )
      .join('') || '<span class="chip-empty">nothing in view</span>';
  };

  $('#fc-airlines').innerHTML = chips([...airlines].sort(byCountDesc), f.airlines, (k) => k, 10);
  $('#fc-types').innerHTML = chips(
    [...types].sort(byCountDesc),
    f.types,
    (k) => REF.typeName(k) || k,
    10
  );
  $('#fc-classes').innerHTML = chips(
    CLASSES.filter((c) => classes.has(c.key)).map((c) => [c.key, classes.get(c.key)]),
    f.classes,
    (k) => (CLASSES.find((c) => c.key === k) || {}).label || k,
    CLASSES.length
  );

  $('#fc-airports').innerHTML = chips([...airports].sort(byCountDesc), f.airports, (k) => k, 12);

  $('#fc-airline-n').textContent = f.airlines.size ? `${f.airlines.size} selected` : '';
  $('#fc-type-n').textContent = f.types.size ? `${f.types.size} selected` : '';
  $('#fc-airport-n').textContent = f.airports.size ? `${f.airports.size} selected` : '';
}

function wireFacet(containerId, set) {
  document.getElementById(containerId).addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const v = chip.dataset.v;
    if (set.has(v)) set.delete(v);
    else set.add(v);
    persistFilters();
    renderFacets();
    updateStats();
    draw();
  });
}

/* ─────────────────────────── status + stats UI ───────────────────────── */

function setLive(kind, text) {
  const el = $('#live-badge');
  el.className = 'live' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
  $('#live-text').textContent = text;
}

function updateStats() {
  let visible = 0, air = 0, ground = 0, spdSum = 0, spdN = 0;
  for (const a of fleet.values()) {
    if (!passesFilter(a)) continue;
    visible++;
    if (a.gnd) ground++;
    else {
      air++;
      if (a.gs) { spdSum += a.gs; spdN++; }
    }
  }
  updateViewChip(visible, fleet.size);
  $('#stat-visible').textContent = nf.format(visible);
  $('#stat-air').textContent = nf.format(air);
  $('#stat-ground').textContent = nf.format(ground);
  $('#stat-speed').textContent = spdN ? nf.format(Math.round(spdSum / spdN)) + ' kt' : '—';
}

const noted = new Map();
/** Show an explanatory message at most once every couple of minutes. */
function note(msg, everyMs = 120000) {
  if (Date.now() - (noted.get(msg) || 0) < everyMs) return;
  noted.set(msg, Date.now());
  toast(msg, 9000);
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ────────────────────────── geolocation button ───────────────────────── */

$('#btn-locate').onclick = () => {
  if (!navigator.geolocation) return toast('Geolocation is not available in this browser');
  toast('Locating…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 9);
      L.circleMarker([pos.coords.latitude, pos.coords.longitude], {
        radius: 6, color: '#35c2f5', weight: 2, fillColor: '#35c2f5', fillOpacity: 0.4,
      })
        .addTo(map)
        .bindTooltip('You are here');
      toast('Showing traffic overhead');
    },
    (err) => toast('Location unavailable: ' + err.message, 3500),
    { timeout: 9000, maximumAge: 60000 }
  );
};

/* ────────────────────────────── URL state ───────────────────────────── */

let hashTimer = null;
function syncHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = map.getCenter();
    const parts = [c.lat.toFixed(4), c.lng.toFixed(4), map.getZoom()];
    if (state.selected) parts.push(state.selected);
    history.replaceState(null, '', '#' + parts.join('/'));
  }, 400);
}

function restoreHash() {
  const m = /^#(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(\d+)(?:\/([0-9a-f]{6}))?/.exec(location.hash);
  if (!m) return false;
  // animate:false so the view is in place before the first poll reads the
  // bounds - an animated setView leaves getBounds() on the previous view.
  map.setView([Number(m[1]), Number(m[2])], Number(m[3]), { animate: false });
  if (m[4]) setTimeout(() => select(m[4]), 1500);
  return true;
}

/* ──────────────────────────── keyboard shortcuts ─────────────────────── */

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.key !== 'Escape') return;
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); searchEl.select(); }
  else if (e.key === 'Escape') { select(null); resultsEl.hidden = true; }
  else if (e.key.toLowerCase() === 'f' && state.selected) { $('#btn-follow')?.click(); }
  else if (e.key.toLowerCase() === 'l') { $('#f-labels').checked = !$('#f-labels').checked; syncFilters(); }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0); });

/* ──────────────────────────── opening view ───────────────────────────── */

/* Where to start when there is no position in the URL. The old default was a
 * continent-wide view, which is too wide for the live feeds to cover - it fell
 * back to the credit-limited whole-world feed and could come up empty. So open
 * on a busy hub near the viewer instead, at a zoom the live feeds serve well.
 * The browser's time zone gives us that without asking for permission. */
const HOME_BY_ZONE = {
  'Asia/Kolkata': [28.58, 77.1], 'Asia/Calcutta': [28.58, 77.1],
  'Asia/Colombo': [7.18, 79.88], 'Asia/Karachi': [24.9, 67.16], 'Asia/Dhaka': [23.84, 90.4],
  'Asia/Dubai': [25.25, 55.36], 'Asia/Qatar': [25.27, 51.61], 'Asia/Riyadh': [24.96, 46.7],
  'Asia/Singapore': [1.36, 103.99], 'Asia/Kuala_Lumpur': [2.75, 101.71], 'Asia/Bangkok': [13.69, 100.75],
  'Asia/Jakarta': [-6.13, 106.66], 'Asia/Manila': [14.51, 121.02], 'Asia/Ho_Chi_Minh': [10.82, 106.66],
  'Asia/Hong_Kong': [22.31, 113.91], 'Asia/Shanghai': [31.14, 121.8], 'Asia/Taipei': [25.08, 121.23],
  'Asia/Tokyo': [35.55, 139.78], 'Asia/Seoul': [37.46, 126.44], 'Asia/Istanbul': [41.26, 28.74],
  'Asia/Tel_Aviv': [32.0, 34.87], 'Asia/Jerusalem': [32.0, 34.87],
  'Europe/London': [51.47, -0.45], 'Europe/Dublin': [53.42, -6.27], 'Europe/Paris': [49.01, 2.55],
  'Europe/Amsterdam': [52.31, 4.76], 'Europe/Brussels': [50.9, 4.48], 'Europe/Berlin': [52.36, 13.5],
  'Europe/Frankfurt': [50.03, 8.56], 'Europe/Madrid': [40.47, -3.56], 'Europe/Lisbon': [38.77, -9.13],
  'Europe/Rome': [41.8, 12.25], 'Europe/Zurich': [47.46, 8.55], 'Europe/Vienna': [48.11, 16.57],
  'Europe/Warsaw': [52.17, 20.97], 'Europe/Stockholm': [59.65, 17.92], 'Europe/Oslo': [60.19, 11.1],
  'Europe/Copenhagen': [55.62, 12.65], 'Europe/Helsinki': [60.32, 24.96], 'Europe/Moscow': [55.41, 37.9],
  'Europe/Athens': [37.94, 23.94], 'Europe/Prague': [50.1, 14.26], 'Europe/Budapest': [47.44, 19.26],
  'America/New_York': [40.71, -73.9], 'America/Toronto': [43.68, -79.63], 'America/Chicago': [41.98, -87.9],
  'America/Denver': [39.86, -104.67], 'America/Los_Angeles': [33.94, -118.41], 'America/Phoenix': [33.43, -112.01],
  'America/Vancouver': [49.19, -123.18], 'America/Mexico_City': [19.44, -99.07], 'America/Sao_Paulo': [-23.43, -46.47],
  'America/Bogota': [4.7, -74.15], 'America/Lima': [-12.02, -77.11], 'America/Argentina/Buenos_Aires': [-34.82, -58.54],
  'Australia/Sydney': [-33.94, 151.18], 'Australia/Melbourne': [-37.67, 144.84], 'Australia/Brisbane': [-27.38, 153.12],
  'Australia/Perth': [-31.94, 115.97], 'Pacific/Auckland': [-37.01, 174.79],
  'Africa/Johannesburg': [-26.14, 28.25], 'Africa/Cairo': [30.11, 31.4], 'Africa/Lagos': [6.58, 3.32],
  'Africa/Nairobi': [-1.32, 36.93], 'Africa/Casablanca': [33.37, -7.59],
};

const HOME_BY_REGION = {
  Asia: [25.25, 55.36], Europe: [51.47, -0.45], America: [40.71, -73.9],
  Australia: [-33.94, 151.18], Pacific: [-33.94, 151.18], Africa: [30.11, 31.4],
  Atlantic: [51.47, -0.45], Indian: [25.25, 55.36], US: [40.71, -73.9],
};

function openingView() {
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch { /* older browsers */ }
  const here = HOME_BY_ZONE[zone] || HOME_BY_REGION[zone.split('/')[0]] || [51.47, -0.45];
  return { center: here, zoom: 8 };
}

/* ─────────────────────────────── bootstrap ──────────────────────────── */

buildLegend();
applyStyle(state.style);
syncFilters();
if (!restoreHash()) {
  const { center, zoom } = openingView();
  map.setView(center, zoom, { animate: false });
}
setLive('ok', 'connecting');
poll();
requestAnimationFrame(tick);

setInterval(() => {
  updateStats();
  if (!$('#filters').hidden) renderFacets();
}, 2000);

console.info(
  '%cSkyTrace%c live flight tracker — data from adsb.lol and the OpenSky Network.\nShortcuts: / search · Esc deselect · F follow · L labels',
  'font-weight:700;color:#f7c948', 'color:#8b98ab'
);
