// health-check.js — SatOps Console N0XRG / EL29ot
// Server-side health probe for all upstream data sources.
// Called by the client watchdog every 10 minutes.
// Route: GET /api/health
//
// Checks:
//   1. AMSAT TLE file   — reachable, contains >5 TLEs, freshness (epoch within 7 days)
//   2. SatNOGS TLE API  — reachable, returns valid JSON with tle0/tle1/tle2 fields
//   3. AMSAT Status API — reachable, returns parseable JSON array
//   4. SatNOGS DB API   — reachable, returns valid transmitter JSON
//
// Response shape:
// {
//   timestamp, overall: "ok"|"degraded"|"down",
//   sources: {
//     amsat_tle:    { status, latency_ms, detail },
//     satnogs_tle:  { status, latency_ms, detail },
//     amsat_status: { status, latency_ms, detail },
//     satnogs_db:   { status, latency_ms, detail },
//   },
//   warnings: [...string]
// }

const CHECKS = [
  {
    id: 'amsat_tle',
    label: 'AMSAT TLE File',
    url: 'https://www.amsat.org/tle/current/nasabare.txt',
    timeout: 12000,
    validate: async (resp) => {
      const text = await resp.text();
      // Count TLE line1 entries (start with "1 ")
      const tleCount = (text.match(/^1 \d{5}/gm) || []).length;
      if (tleCount < 5) return { ok: false, detail: `Only ${tleCount} TLEs found (expected ≥5)` };

      // Check freshness: find the most recent epoch from line1
      const epochs = (text.match(/^1 \d{5}.\s+(\d{2})(\d{3}\.\d+)/gm) || []).map(l => {
        const m = l.match(/\d \d{5}.\s+(\d{2})(\d{3}\.\d+)/);
        if (!m) return null;
        const yr = parseInt(m[1]) + (parseInt(m[1]) < 57 ? 2000 : 1900);
        const doy = parseFloat(m[2]);
        const d = new Date(yr, 0, 1);
        d.setDate(d.getDate() + Math.floor(doy) - 1);
        d.setHours(0, 0, 0, 0);
        d.setTime(d.getTime() + (doy % 1) * 86400000);
        return d;
      }).filter(Boolean);

      if (epochs.length > 0) {
        const newest = new Date(Math.max(...epochs.map(d => d.getTime())));
        const ageHours = (Date.now() - newest.getTime()) / 3600000;
        if (ageHours > 168) { // 7 days
          return { ok: false, detail: `TLEs are ${Math.round(ageHours / 24)}d old — may be stale` };
        }
        return { ok: true, detail: `${tleCount} TLEs, newest epoch ${Math.round(ageHours)}h ago` };
      }
      return { ok: true, detail: `${tleCount} TLEs found` };
    },
  },
  {
    id: 'satnogs_tle',
    label: 'SatNOGS TLE API',
    url: 'https://db.satnogs.org/api/tle/?norad_cat_id=27607', // SO-50 as canary
    timeout: 10000,
    validate: async (resp) => {
      const data = await resp.json();
      const arr = Array.isArray(data) ? data : [];
      if (arr.length === 0) return { ok: false, detail: 'Returned empty array for SO-50 (NORAD 27607)' };
      const entry = arr[0];
      if (!entry.tle0 || !entry.tle1 || !entry.tle2) {
        return { ok: false, detail: 'Missing tle0/tle1/tle2 fields' };
      }
      return { ok: true, detail: `SO-50 TLE present: ${entry.tle0}` };
    },
  },
  {
    id: 'amsat_status',
    label: 'AMSAT Status API',
    url: 'https://www.amsat.org/status/api/v1/sat_info.php?name=SO-50_%5BFM%5D&hours=168',
    timeout: 12000,
    validate: async (resp) => {
      const data = await resp.json();
      if (!Array.isArray(data)) return { ok: false, detail: 'Response is not a JSON array' };
      // It's OK if array is empty — satellite may just have no recent reports
      return {
        ok: true,
        detail: `${data.length} report(s) for SO-50 in last 7 days`,
        warning: data.length === 0 ? 'No SO-50 reports in 7 days — API may be silent or sat down' : null,
      };
    },
  },
  {
    id: 'satnogs_db',
    label: 'SatNOGS DB Transmitters',
    url: 'https://db.satnogs.org/api/transmitters/?format=json&satellite__norad_cat_id=27607',
    timeout: 12000,
    validate: async (resp) => {
      const data = await resp.json();
      const arr = data.results || (Array.isArray(data) ? data : []);
      if (arr.length === 0) return { ok: false, detail: 'No transmitters returned for SO-50' };
      const activeFM = arr.filter(t => t.mode === 'FM' && (t.status === 'active' || t.alive));
      return {
        ok: true,
        detail: `${arr.length} transmitter(s), ${activeFM.length} active FM`,
      };
    },
  },
];

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const results = {};
  const warnings = [];

  await Promise.all(CHECKS.map(async (check) => {
    const t0 = Date.now();
    try {
      const resp = await fetch(check.url, {
        headers: { 'User-Agent': 'SatOps-HealthCheck-N0XRG/1.0' },
        signal: AbortSignal.timeout(check.timeout),
      });

      const latency = Date.now() - t0;

      if (!resp.ok) {
        results[check.id] = { status: 'down', latency_ms: latency, detail: `HTTP ${resp.status}`, label: check.label };
        warnings.push(`${check.label}: HTTP ${resp.status}`);
        return;
      }

      const validation = await check.validate(resp);
      if (validation.warning) warnings.push(`${check.label}: ${validation.warning}`);

      results[check.id] = {
        status: validation.ok ? 'ok' : 'degraded',
        latency_ms: latency,
        detail: validation.detail,
        label: check.label,
      };

      if (!validation.ok) warnings.push(`${check.label}: ${validation.detail}`);

    } catch (err) {
      const latency = Date.now() - t0;
      const isTimeout = err.name === 'TimeoutError' || err.message.includes('timeout');
      results[check.id] = {
        status: 'down',
        latency_ms: latency,
        detail: isTimeout ? `Timed out after ${check.timeout / 1000}s` : err.message,
        label: check.label,
      };
      warnings.push(`${check.label}: ${results[check.id].detail}`);
    }
  }));

  // Overall status: ok / degraded / down
  const statuses = Object.values(results).map(r => r.status);
  const overall = statuses.every(s => s === 'ok') ? 'ok'
    : statuses.some(s => s === 'down') ? 'down'
    : 'degraded';

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      overall,
      sources: results,
      warnings: warnings.length > 0 ? warnings : undefined,
    }),
  };
};
