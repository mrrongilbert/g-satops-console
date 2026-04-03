// tle-proxy.js
// Proxies CelesTrak TLE feeds for amateur satellites
// Route: /api/tle?group=amateur     → full amateur group
//        /api/tle?norad=27607,43017 → specific NORAD IDs
//        /api/tle?group=stations    → ISS + stations

const CELESTRAK_BASE = "https://celestrak.org/SOCRATES/query.php";
const CELESTRAK_GP = "https://celestrak.org/SOCRATES/query.php";
const CELESTRAK_GROUPS = "https://celestrak.org/SOCRATES/query.php";

// CelesTrak GP API for specific NORAD IDs (most reliable)
const GP_API = "https://celestrak.org/SOCRATES/query.php";
const CELESTRAK_GP_URL = "https://celestrak.org/SOCRATES/query.php?FORMAT=TLE&CATALOG=";

// Our curated FM satellite NORAD IDs
const FM_SAT_NORADS = [
  27607,  // SO-50 (SAUDISAT 1C)
  43017,  // AO-91 (Fox-1B)
  39684,  // IO-86
  25544,  // ISS (ZARYA)
  43678,  // PO-101 (Diwata-2)
  56218,  // HADES-D
  59561,  // AO-123
  57167,  // SO-125
  59051,  // RS83S
  59052,  // RS95S
  44406,  // AO-73 (FUNcube-1)
  40931,  // LO-90
  42778,  // JO-97 (JAISAT-1)
];

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=21600", // 6-hour client cache for TLEs
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const params = event.queryStringParameters || {};

  // Parse requested NORAD IDs (comma-separated) or use default FM sat list
  const requestedNorads = params.norad
    ? params.norad.split(",").map(n => parseInt(n.trim(), 10)).filter(Boolean)
    : FM_SAT_NORADS;

  const tleLines = {};
  const errors = [];
  const notFound = [];

  // Try CelesTrak GP (General Perturbations) API — most reliable for specific IDs
  // Format: https://celestrak.org/SOCRATES/query.php?FORMAT=TLE&CATALOG=NORAD_ID
  // For multiple: fetch each in small batches
  const BATCH_SIZE = 5;
  const batches = [];
  for (let i = 0; i < requestedNorads.length; i += BATCH_SIZE) {
    batches.push(requestedNorads.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    try {
      // Primary: CelesTrak GP API with CATALOG param
      const batchUrls = batch.map(norad =>
        `https://celestrak.org/SOCRATES/query.php?FORMAT=TLE&CATALOG=${norad}`
      );

      const batchFetches = batchUrls.map(async (url, idx) => {
        const norad = batch[idx];
        try {
          const resp = await fetch(url, {
            headers: { "User-Agent": "SatOps-GCC/1.0 W5-Station" },
            signal: AbortSignal.timeout(12000),
          });

          if (!resp.ok) {
            errors.push({ norad, status: resp.status });
            return;
          }

          const text = await resp.text();
          const lines = text.trim().split("\n").map(l => l.trim()).filter(l => l.length > 0);

          // Parse TLE triplets
          for (let i = 0; i < lines.length - 2; i += 3) {
            const name = lines[i];
            const line1 = lines[i + 1];
            const line2 = lines[i + 2];
            if (line1 && line1.startsWith("1 ") && line2 && line2.startsWith("2 ")) {
              const parsedNorad = parseInt(line1.substring(2, 7).trim(), 10);
              tleLines[parsedNorad] = { name: name.trim(), line1, line2, norad: parsedNorad };
            }
          }
        } catch (err) {
          errors.push({ norad, error: err.message });
        }
      });

      await Promise.all(batchFetches);
    } catch (err) {
      errors.push({ batch, error: err.message });
    }
  }

  // Check which were not found
  for (const norad of requestedNorads) {
    if (!tleLines[norad]) notFound.push(norad);
  }

  // If many not found, try the amateur group feed as fallback
  if (notFound.length > requestedNorads.length / 2) {
    try {
      const amateurResp = await fetch(
        "https://celestrak.org/SOCRATES/query.php?FORMAT=TLE&GROUP=amateur",
        {
          headers: { "User-Agent": "SatOps-GCC/1.0 W5-Station" },
          signal: AbortSignal.timeout(15000),
        }
      );

      if (amateurResp.ok) {
        const text = await amateurResp.text();
        const lines = text.trim().split("\n").map(l => l.trim()).filter(l => l.length > 0);

        for (let i = 0; i < lines.length - 2; i += 3) {
          const name = lines[i];
          const line1 = lines[i + 1];
          const line2 = lines[i + 2];
          if (line1 && line1.startsWith("1 ") && line2 && line2.startsWith("2 ")) {
            const parsedNorad = parseInt(line1.substring(2, 7).trim(), 10);
            if (requestedNorads.includes(parsedNorad) && !tleLines[parsedNorad]) {
              tleLines[parsedNorad] = { name: name.trim(), line1, line2, norad: parsedNorad };
            }
          }
        }
      }
    } catch (err) {
      errors.push({ source: "amateur-group", error: err.message });
    }
  }

  // Also try stations group for ISS
  if (!tleLines[25544]) {
    try {
      const issResp = await fetch(
        "https://celestrak.org/SOCRATES/query.php?FORMAT=TLE&CATALOG=25544",
        {
          headers: { "User-Agent": "SatOps-GCC/1.0 W5-Station" },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (issResp.ok) {
        const text = await issResp.text();
        const lines = text.trim().split("\n").map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length >= 3) {
          tleLines[25544] = {
            name: lines[0],
            line1: lines[1],
            line2: lines[2],
            norad: 25544,
          };
        }
      }
    } catch (err) {
      errors.push({ norad: 25544, error: err.message });
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      found: Object.keys(tleLines).length,
      requested: requestedNorads.length,
      tles: tleLines,
      errors: errors.length > 0 ? errors : undefined,
    }),
  };
};
