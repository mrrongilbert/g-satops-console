// amsat-proxy.js
// Proxies AMSAT Oscar Satellite Status API
// All FM voice satellites relevant to IC-9700 + M2 LEO Pack setup
// Route: /api/amsat?sat=SO-50&hours=24
//        /api/amsat (returns batch status for all curated FM birds)

const AMSAT_BASE = "https://www.amsat.org/status/api/v1/sat_info.php";

// All FM voice satellite names tracked in the SatOps console
const ALL_FM_SATS = [
  "SO-50", "AO-91", "IO-86", "ISS-FM",
  "PO-101[FM]", "AO-123", "SO-125",
  "AO-7[A]", "AO-7[B]", "FO-29", "RS-44",
  "JO-97", "QO-100_NB"
];

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=180", // 3-min client cache
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const params = event.queryStringParameters || {};
  const hours = parseInt(params.hours || "24", 10);

  // If a specific satellite is requested
  if (params.sat) {
    try {
      const url = `${AMSAT_BASE}?name=${encodeURIComponent(params.sat)}&hours=${hours}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "SatOps-GCC/1.0 W5-Station" },
        signal: AbortSignal.timeout(12000),
      });

      if (!resp.ok) {
        return {
          statusCode: resp.status,
          headers,
          body: JSON.stringify({ error: `AMSAT returned ${resp.status}`, sat: params.sat }),
        };
      }

      const data = await resp.json();
      return { statusCode: 200, headers, body: JSON.stringify({ sat: params.sat, reports: data }) };
    } catch (err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: err.message, sat: params.sat }),
      };
    }
  }

  // Batch mode: fetch all FM birds in parallel
  const results = {};
  const errors = [];

  const fetches = ALL_FM_SATS.map(async (satName) => {
    try {
      const url = `${AMSAT_BASE}?name=${encodeURIComponent(satName)}&hours=${hours}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "SatOps-GCC/1.0 W5-Station" },
        signal: AbortSignal.timeout(15000),
      });

      if (resp.ok) {
        const data = await resp.json();
        results[satName] = {
          reports: data,
          count: data.length,
          lastReport: data.length > 0 ? data[0] : null,
          // Determine health: active=has reports in last 24h, 1=active, 2=partial, 0=no signal
          health: data.length > 0 ? Math.max(...data.map(r => parseInt(r.report || "0") || 0)) : null,
        };
      } else {
        errors.push({ sat: satName, status: resp.status });
        results[satName] = { reports: [], count: 0, lastReport: null, health: null, error: resp.status };
      }
    } catch (err) {
      errors.push({ sat: satName, error: err.message });
      results[satName] = { reports: [], count: 0, lastReport: null, health: null, error: err.message };
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
