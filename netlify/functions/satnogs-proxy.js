// satnogs-proxy.js
// Proxies SatNOGS DB API for amateur FM satellite transmitter data
// Route: /api/satnogs            → all active amateur FM transmitters
//        /api/satnogs?norad=27607 → specific satellite by NORAD ID

const SATNOGS_BASE = "https://db.satnogs.org/api";

exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=3600", // 1-hour cache
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const params = event.queryStringParameters || {};

  try {
    let url;

    if (params.norad) {
      // Fetch transmitters for a specific satellite
      // First get the satellite to get its internal ID
      const satResp = await fetch(
        `${SATNOGS_BASE}/satellites/?format=json&norad_cat_id=${params.norad}`,
        {
          headers: { "User-Agent": "SatOps-GCC/1.0 W5-Station" },
          signal: AbortSignal.timeout(12000),
        }
      );

      if (!satResp.ok) {
        return {
          statusCode: satResp.status,
          headers,
          body: JSON.stringify({ error: `SatNOGS returned ${satResp.status}` }),
        };
      }

      const satData = await satResp.json();
      const sat = satData.results ? satData.results[0] : (satData[0] || null);

      if (!sat) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: `Satellite NORAD ${params.norad} not found in SatNOGS` }),
        };
      }

      // Get transmitters for this satellite
      const txResp = await fetch(
        `${SATNOGS_BASE}/transmitters/?format=json&satellite__norad_cat_id=${params.norad}&status=active`,
        {
          headers: { "User-Agent": "SatOps-GCC/1.0 W5-Station" },
          signal: AbortSignal.timeout(12000),
        }
      );

      const txData = txResp.ok ? await txResp.json() : { results: [] };
      const transmitters = txData.results || txData;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          satellite: sat,
          transmitters,
          norad: parseInt(params.norad, 10),
        }),
      };
    }

    // Default: fetch active FM/SSB amateur transmitters relevant to our station
    // Filter to FM mode, amateur service, active status
    const fmResp = await fetch(
      `${SATNOGS_BASE}/transmitters/?format=json&service=Amateur&mode=FM&status=active`,
      {
        headers: { "User-Agent": "SatOps-GCC/1.0 W5-Station" },
        signal: AbortSignal.timeout(15000),
      }
    );

    if (!fmResp.ok) {
      return {
        statusCode: fmResp.status,
        headers,
        body: JSON.stringify({ error: `SatNOGS returned ${fmResp.status}` }),
      };
    }

    const fmData = await fmResp.json();
    const transmitters = fmData.results || fmData;

    // Filter to those with both uplink and downlink (actual repeaters, not beacons)
    const repeaters = transmitters.filter(tx =>
      tx.uplink_low && tx.downlink_low && tx.type === "Transceiver"
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        total: transmitters.length,
        repeaters: repeaters.length,
        transmitters: repeaters,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
