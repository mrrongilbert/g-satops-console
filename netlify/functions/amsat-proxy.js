// amsat-proxy.js — SatOps Console N0XRG / EL29ot
// Proxies AMSAT Oscar Satellite Status API
// CORRECTED sat names: AMSAT API requires _[FM] suffix format, e.g. "SO-50_[FM]"
// Route: /api/amsat?sat=SO-50_[FM]&hours=24
//        /api/amsat           → batch status for all curated FM birds

const AMSAT_BASE = "https://www.amsat.org/status/api/v1/sat_info.php";

// CORRECTED FM voice satellite names — AMSAT API requires exact _[MODE] suffix
// Verified against https://www.amsat.org/status/ select options (April 2026)
// Voice FM only — RS-38S and RS95S removed April 2026 (no active FM voice on SatNOGS)
const FM_SAT_NAMES = [
  "SO-50_[FM]",
  "AO-91_[FM]",
  "IO-86_[FM]",
  "ISS_[FM]",
  "PO-101_[FM]",
  "AO-123_[FM]",
  "SO-125_[FM]",
];

// Map from display name → AMSAT API name (for single-sat lookups)
const SAT_NAME_MAP = {
  "SO-50":   "SO-50_[FM]",
  "AO-91":   "AO-91_[FM]",
  "IO-86":   "IO-86_[FM]",
  "ISS":     "ISS_[FM]",
  "ISS-FM":  "ISS_[FM]",
  "ISS_FM":  "ISS_[FM]",
  "PO-101":  "PO-101_[FM]",
  "AO-123":  "AO-123_[FM]",
  "SO-125":  "SO-125_[FM]",
};

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=180", // 3-min client cache
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const params = event.queryStringParameters || {};
  const hours = parseInt(params.hours || "24", 10);

  // ─── Single satellite lookup ───────────────────────────────────────────────
  if (params.sat) {
    const apiName = SAT_NAME_MAP[params.sat] || params.sat;
    try {
      const url = `${AMSAT_BASE}?name=${encodeURIComponent(apiName)}&hours=${hours}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "SatOps-N0XRG/1.0 EL29ot" },
        signal: AbortSignal.timeout(12000),
      });

      if (!resp.ok) {
        return {
          statusCode: resp.status,
          headers,
          body: JSON.stringify({ error: `AMSAT returned ${resp.status}`, sat: apiName }),
        };
      }

      const data = await resp.json();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ sat: apiName, reports: data }),
      };
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message, sat: apiName }),
      };
    }
  }

  // ─── Batch mode: all FM birds ──────────────────────────────────────────────
  const results = {};
  const errors = [];

  const fetches = FM_SAT_NAMES.map(async (satName) => {
    try {
      const url = `${AMSAT_BASE}?name=${encodeURIComponent(satName)}&hours=${hours}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "SatOps-N0XRG/1.0 EL29ot" },
        signal: AbortSignal.timeout(15000),
      });

      if (resp.ok) {
        const data = await resp.json();
        // Strip the _[FM] suffix for the result key so it matches FM_SATS in index.html
        const shortName = satName.replace(/_\[FM\]$/, "");
        results[shortName] = {
          reports: data,
          count: data.length,
          lastReport: data.length > 0 ? data[0] : null,
          // health: 1=heard, 0=no signal, null=no data
          health: data.length > 0
            ? (data.some(r => r.report === "Heard") ? 1 : 0)
            : null,
          apiName: satName,
        };
      } else {
        errors.push({ sat: satName, status: resp.status });
        const shortName = satName.replace(/_\[FM\]$/, "");
        results[shortName] = { reports: [], count: 0, lastReport: null, health: null, error: resp.status };
      }
    } catch (err) {
      errors.push({ sat: satName, error: err.message });
      const shortName = satName.replace(/_\[FM\]$/, "");
      results[shortName] = { reports: [], count: 0, lastReport: null, health: null, error: err.message };
    }
  });

  await Promise.all(fetches);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      hours,
      results,
      errors: errors.length > 0 ? errors : undefined,
      totalReports: Object.values(results).reduce((sum, v) => sum + (v.count || 0), 0),
    }),
  };
};
