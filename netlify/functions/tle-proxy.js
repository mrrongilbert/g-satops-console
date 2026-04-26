// tle-proxy.js — SatOps Console N0XRG / EL29ot
// Proxies TLE data for FM amateur satellites
// Primary:  https://www.amsat.org/tle/current/nasabare.txt  (amateur-only TLE file, always current)
// Fallback: https://db.satnogs.org/api/tle/?norad_cat_id=   (Space-Track-sourced, per-NORAD)
//
// CORRECTED NORAD IDs (verified April 2026):
//   SO-50  = 27607   AO-91  = 43017   IO-86  = 40931  (LAPAN-A2, NOT 39684)
//   ISS    = 25544   PO-101 = 43678   AO-123 = 61781  (NOT 59561)
//   SO-125 = 63492   (HADES-ICM, NOT 57167)
//   RS95S  = 67291   (QMR-KWT-2, NOT 59052)
//   RS38S  = 57189   (replaces RS83S 59051 which was METEOR M2-4)

const AMSAT_TLE_URL = "https://www.amsat.org/tle/current/nasabare.txt";
const SATNOGS_TLE_URL = "https://db.satnogs.org/api/tle/?norad_cat_id=";

// Curated FM satellite list with VERIFIED correct NORAD IDs
// Voice FM only — RS-38S (57189) and RS95S (67291) removed April 2026
// (SatNOGS confirms: no active FM voice transceivers on those NORADs)
const FM_SAT_NORADS = [
  27607,  // SO-50     (SAUDISAT 1C)
  43017,  // AO-91     (Fox-1B)
  40931,  // IO-86     (LAPAN-A2)
  25544,  // ISS
  43678,  // PO-101    (Diwata-2)
  61781,  // AO-123
  63492,  // SO-125    (HADES-ICM)
];

/**
 * Parse a raw TLE text block (3-line format) into a map of NORAD → { name, line1, line2, norad }
 * Handles both "NAME\n1 NORAD...\n2 NORAD..." and "0 NAME\n1 NORAD...\n2 NORAD..." formats.
 */
function parseTleText(text) {
  const result = {};
  const lines = text
    .split("\n")
    .map(l => l.trimEnd())
    .filter(l => l.trim().length > 0);

  for (let i = 0; i < lines.length - 2; i++) {
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];

    if (
      l1 && l1.startsWith("1 ") && l1.length >= 69 &&
      l2 && l2.startsWith("2 ") && l2.length >= 69
    ) {
      const norad = parseInt(l1.substring(2, 7).trim(), 10);
      if (!isNaN(norad)) {
        result[norad] = {
          name: lines[i].replace(/^0 /, "").trim(),
          line1: l1.trim(),
          line2: l2.trim(),
          norad,
        };
      }
      i += 2; // skip consumed lines
    }
  }
  return result;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=21600", // 6-hour TLE cache (TLEs change slowly)
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const params = event.queryStringParameters || {};
  const requestedNorads = params.norad
    ? params.norad.split(",").map(n => parseInt(n.trim(), 10)).filter(Boolean)
    : FM_SAT_NORADS;

  const tleMap = {};
  const errors = [];
  let source = "none";

  // ─── PRIMARY: AMSAT nasabare.txt ──────────────────────────────────────────
  try {
    const resp = await fetch(AMSAT_TLE_URL, {
      headers: { "User-Agent": "SatOps-N0XRG/1.0 EL29ot" },
      signal: AbortSignal.timeout(15000),
    });

    if (resp.ok) {
      const text = await resp.text();
      const all = parseTleText(text);
      source = "amsat";

      // Keep only the requested NORADs
      for (const norad of requestedNorads) {
        if (all[norad]) tleMap[norad] = all[norad];
      }
    } else {
      errors.push({ source: "amsat", status: resp.status });
    }
  } catch (err) {
    errors.push({ source: "amsat", error: err.message });
  }

  // ─── FALLBACK: SatNOGS per-NORAD API ─────────────────────────────────────
  const stillNeeded = requestedNorads.filter(n => !tleMap[n]);
  if (stillNeeded.length > 0) {
    const fallbacks = stillNeeded.map(async (norad) => {
      try {
        const resp = await fetch(`${SATNOGS_TLE_URL}${norad}`, {
          headers: { "User-Agent": "SatOps-N0XRG/1.0 EL29ot" },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.length > 0) {
            const entry = data[0];
            const noradId = parseInt(entry.tle1.substring(2, 7).trim(), 10);
            tleMap[noradId] = {
              name: entry.tle0.replace(/^0 /, "").trim(),
              line1: entry.tle1,
              line2: entry.tle2,
              norad: noradId,
            };
            source = source === "amsat" ? "amsat+satnogs" : "satnogs";
          }
        } else {
          errors.push({ source: "satnogs", norad, status: resp.status });
        }
      } catch (err) {
        errors.push({ source: "satnogs", norad, error: err.message });
      }
    });
    await Promise.all(fallbacks);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      found: Object.keys(tleMap).length,
      requested: requestedNorads.length,
      source,
      tles: tleMap,
      errors: errors.length > 0 ? errors : undefined,
    }),
  };
};
