/**
 * Download a region's map tiles so it still renders with no internet.
 *
 *   node prefetch-tiles.mjs dark 10.5 76.5 11.5 77.5 6 12
 *                           ^style ^lat1 ^lon1 ^lat2 ^lon2 ^zmin ^zmax
 *
 * Tiles are pulled through this instance, so they land in its own disk cache
 * and are served from there afterwards. Zoom 12 over a city is a few thousand
 * tiles; zoom 14 over a country is millions, so keep the box tight.
 */
const [style = 'dark', la1, lo1, la2, lo2, zmin = '6', zmax = '11'] = process.argv.slice(2);
const base = process.env.SKYTRACE || 'http://localhost:8787';

if (!la1 || !lo1 || !la2 || !lo2) {
  console.error('usage: node prefetch-tiles.mjs <style> <lat1> <lon1> <lat2> <lon2> [zmin] [zmax]');
  process.exit(1);
}

const [south, north] = [Math.min(+la1, +la2), Math.max(+la1, +la2)];
const [west, east] = [Math.min(+lo1, +lo2), Math.max(+lo1, +lo2)];

const xOf = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const yOf = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

const jobs = [];
for (let z = +zmin; z <= +zmax; z++) {
  for (let x = xOf(west, z); x <= xOf(east, z); x++) {
    for (let y = yOf(north, z); y <= yOf(south, z); y++) jobs.push([z, x, y]);
  }
}

console.log(`${jobs.length} tiles, ${style}, zoom ${zmin}-${zmax}`);
if (jobs.length > 60000) {
  console.error('That is a very large area. Narrow the box or lower zmax.');
  process.exit(1);
}

let done = 0, fetched = 0, cached = 0, failed = 0;
const CONCURRENCY = 4;

async function worker() {
  while (jobs.length) {
    const [z, x, y] = jobs.pop();
    try {
      const r = await fetch(`${base}/tiles/${style}/${z}/${x}/${y}`);
      if (!r.ok) failed++;
      else if (r.headers.get('x-tile') === 'disk') cached++;
      else fetched++;
      await r.arrayBuffer();
    } catch {
      failed++;
    }
    if (++done % 100 === 0 || !jobs.length) {
      process.stdout.write(`\r  ${done} done · ${fetched} fetched · ${cached} already held · ${failed} failed   `);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`\ndone — ${fetched} new tiles cached, ${failed} failed`);
