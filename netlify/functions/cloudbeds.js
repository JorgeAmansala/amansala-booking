"use strict";
const { request } = require("https");

// ─── Module-level state (survives warm Lambda invocations) ───────────────────
let _token     = null; // { access_token, expires_at_ms }
let _roomLookup = {};  // { roomName → Cloudbeds roomID }

const CB_BASE   = "https://api.cloudbeds.com/api/v1.3";
const CB_OAUTH  = "https://api.cloudbeds.com/api/v1.3/oauth";

// Preserve existing hub colors when mapping Cloudbeds room type names
const COLOR_MAP = {
  "beachfront king":        "#0891b2",
  "superior king":          "#7c3aed",
  "garden plus king":       "#16a34a",
  "garden king":            "#2d6a6a",
  "garden basic":           "#ca8a04",
  "double beachview":       "#2563eb",
  "double room":            "#dc2626",
  "triple":                 "#9333ea",
  "quad":                   "#e11d48",
  "shanti king":            "#0369a1",
  "shanti 2 queens":        "#0284c7",
  "casa king downstairs":   "#92400e",
  "casa grande bedroom":    "#b45309",
  "casa 2 queens":          "#d97706",
  "cg individual bed":      "#f59e0b",
  "cg small queen":         "#fbbf24",
  "cg full house":          "#78350f",
};

// ─── Main handler ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const h = corsHeaders();

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: h, body: "" };
  }

  const qs     = event.queryStringParameters || {};
  const action = qs.action;
  const body   = event.body ? safeJSON(event.body) : {};

  try {
    const tok = await getToken();

    switch (action) {
      case "getRooms":
        return ok(h, await getRooms(tok));

      case "getRates":
        return ok(h, await getRates(tok));

      case "getAvailability":
        if (!qs.start || !qs.end)
          return ok(h, { error: "start and end are required" }, 400);
        return ok(h, await getAvailability(tok, qs.start, qs.end));

      case "createReservation":
        return ok(h, await createReservation(tok, body));

      case "cancelReservation":
        return ok(h, await cancelReservation(tok, body.reservationId));

      default:
        return ok(h, { error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error("[cloudbeds]", err);
    return ok(h, { error: err.message }, 502);
  }
};

// ─── Auth: OAuth2 authorization_code with refresh_token ──────────────────────
async function getToken() {
  // Use cached token if still valid
  const now = Date.now();
  if (_token && _token.expires_at_ms > now + 60_000) return _token.access_token;

  const clientId     = process.env.CLOUDBEDS_CLIENT_ID     || "";
  const clientSecret = process.env.CLOUDBEDS_CLIENT_SECRET || "";
  const refreshToken = process.env.CLOUDBEDS_REFRESH_TOKEN || "";

  if (!refreshToken) throw new Error(
    "CLOUDBEDS_REFRESH_TOKEN not set. Complete OAuth2 setup at " +
    "/.netlify/functions/cloudbeds-setup"
  );

  // Exchange refresh_token for new access_token
  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();

  const res = await httpJSON(
    "POST",
    `${CB_OAUTH}/access_token`,
    body,
    { "Content-Type": "application/x-www-form-urlencoded" }
  );

  if (!res.access_token)
    throw new Error("Cloudbeds token refresh failed: " + JSON.stringify(res));

  _token = {
    access_token:  res.access_token,
    expires_at_ms: now + (res.expires_in || 3600) * 1000,
  };
  return _token.access_token;
}

// ─── API actions ─────────────────────────────────────────────────────────────

async function getRooms(tok) {
  const res = await cbGet(tok, "/getPropertyRooms");
  if (!res.success) throw new Error("getPropertyRooms failed: " + JSON.stringify(res));

  const types  = {};
  const lookup = {};

  for (const r of (res.data || [])) {
    lookup[r.roomName] = r.roomID;

    if (!types[r.roomTypeID]) {
      const nameLow = (r.roomTypeName || "").toLowerCase().trim();
      types[r.roomTypeID] = {
        id:       r.roomTypeID,
        name:     r.roomTypeName,
        property: deriveProperty(r.roomTypeName),
        color:    COLOR_MAP[nameLow] || "#607D8B",
        maxOcc:   parseInt(r.maxGuests, 10) || 2,
        rooms:    [],
        // Prices filled by getRates; zero until then
        price1: 0, price2: 0, price1_low: 0, price2_low: 0,
      };
    }
    types[r.roomTypeID].rooms.push(r.roomName);
  }

  _roomLookup = lookup;
  return { roomTypes: Object.values(types), roomLookup: lookup };
}

async function getRates(tok) {
  const res = await cbGet(tok, "/getRatePlans");
  if (!res.success) throw new Error("getRatePlans failed: " + JSON.stringify(res));

  const rates = {}; // { roomTypeID: { price1, price2, price1_low, price2_low } }

  for (const plan of Object.values(res.data || {})) {
    const n = (plan.ratePlanName || "").toLowerCase();
    for (const [rtId, rtData] of Object.entries(plan.roomTypes || {})) {
      if (!rates[rtId]) rates[rtId] = {};
      const rate = parseFloat(rtData.roomRate) || 0;
      if (!rate) continue;

      if      (/single.*high|1\s*p.*high|high.*single|private.*high/i.test(n)) rates[rtId].price1     = rate;
      else if (/double.*high|2\s*p.*high|shar.*high|high.*double/i.test(n))    rates[rtId].price2     = rate;
      else if (/single.*low|1\s*p.*low|low.*single|private.*low/i.test(n))     rates[rtId].price1_low = rate;
      else if (/double.*low|2\s*p.*low|shar.*low|low.*double/i.test(n))        rates[rtId].price2_low = rate;
      else {
        // Fallback: single plan per room type — populate all slots
        if (!rates[rtId].price1) {
          rates[rtId].price1     = rate;
          rates[rtId].price2     = rate;
          rates[rtId].price1_low = Math.round(rate * 0.85);
          rates[rtId].price2_low = Math.round(rate * 0.85);
        }
      }
    }
  }

  return { rates };
}

async function getAvailability(tok, start, end) {
  const res = await cbGet(tok, "/getAvailabilityReport", {
    startDate: start,
    endDate:   end,
  });
  if (!res.success) throw new Error("getAvailabilityReport failed: " + JSON.stringify(res));

  // Build map: roomName → [unavailable date strings]
  const unavailable = {};
  for (const [date, rooms] of Object.entries(res.data || {})) {
    for (const room of Object.values(rooms || {})) {
      if (!room.available) {
        if (!unavailable[room.roomName]) unavailable[room.roomName] = [];
        unavailable[room.roomName].push(date);
      }
    }
  }

  return { unavailable };
}

async function createReservation(tok, body) {
  const { roomName, startDate, endDate, groupName, leaderName, adults } = body;
  if (!roomName || !startDate || !endDate)
    throw new Error("roomName, startDate, endDate are required");

  const roomId = _roomLookup[roomName];
  if (!roomId) throw new Error(`Room not found in lookup: ${roomName}. Call getRooms first.`);

  const nameParts = (groupName || leaderName || "Group Amansala").trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName  = nameParts.slice(1).join(" ") || "Amansala";

  const form = new URLSearchParams({
    propertyID:    process.env.CLOUDBEDS_PROPERTY_ID,
    startDate,
    endDate,
    roomID:        roomId,
    adults:        adults || 2,
    guestFirstName: firstName,
    guestLastName:  lastName,
    notes:         `Group: ${groupName || ""} · Leader: ${leaderName || ""}`,
  }).toString();

  const res = await cbPost(tok, "/postReservation", form);
  if (!res.success) throw new Error("postReservation failed: " + JSON.stringify(res));

  return {
    reservationId: res.data?.reservationID || res.data?.id,
    roomName,
  };
}

async function cancelReservation(tok, reservationId) {
  if (!reservationId) throw new Error("reservationId is required");

  const form = new URLSearchParams({
    propertyID:    process.env.CLOUDBEDS_PROPERTY_ID,
    reservationID: reservationId,
    status:        "canceled",
  }).toString();

  const res = await cbPost(tok, "/putReservation", form);
  return { success: res.success, reservationId };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function cbGet(tok, path, params = {}) {
  const qs = new URLSearchParams({
    propertyID:   process.env.CLOUDBEDS_PROPERTY_ID,
    access_token: tok,
    ...params,
  }).toString();
  return httpJSON("GET", `${CB_BASE}${path}?${qs}`, null, {
    Authorization: `Bearer ${tok}`,
  });
}

function cbPost(tok, path, formBody) {
  // Append access_token to body as well for Cloudbeds compatibility
  const fullBody = formBody + `&access_token=${encodeURIComponent(tok)}`;
  return httpJSON("POST", `${CB_BASE}${path}`, fullBody, {
    Authorization:  `Bearer ${tok}`,
    "Content-Type": "application/x-www-form-urlencoded",
  });
}

function httpJSON(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const buf = body ? Buffer.from(body) : null;
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers:  { ...headers, "Content-Length": buf ? buf.length : 0 },
    };
    const req = request(opts, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function deriveProperty(roomTypeName) {
  const n = (roomTypeName || "").toUpperCase();
  if (n.includes("SHANTI"))                        return "CASA SHANTI";
  if (n.includes("CASA") && n.includes("GRANDE"))  return "CASA GRANDE";
  if (n.includes("MOJAVE"))                        return "MOJAVE";
  if (n.includes("CHIKA"))                         return "CHIKA";
  return "AMANSALA";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type":                 "application/json",
  };
}

function ok(headers, data, statusCode = 200) {
  return { statusCode, headers, body: JSON.stringify(data) };
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
