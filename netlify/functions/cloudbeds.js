"use strict";
const { request } = require("https");

// ─── Module-level state (survives warm Lambda invocations) ───────────────────
let _token      = null; // { access_token, expires_at_ms }
let _roomLookup = {};   // { roomName → Cloudbeds roomID }
let _maxOcc     = {};   // { roomName → maxGuests }

const CB_BASE  = "https://api.cloudbeds.com/api/v1.3";
const CB_TOKEN = "https://api.cloudbeds.com/api/v1.2/access_token";

// Colors keyed to actual Cloudbeds room type names (lowercase)
const COLOR_MAP = {
  "beachfront king":           "#0891b2",
  "beachview double":          "#2563eb",
  "bed in a beachview double": "#2563eb",
  "superior":                  "#7c3aed",
  "garden plus":               "#16a34a",
  "garden":                    "#2d6a6a",
  "simple n small":            "#ca8a04",
  "double":                    "#dc2626",
  "bed in a double room":      "#dc2626",
  "triple":                    "#9333ea",
  "bed in a triple room":      "#9333ea",
  "quad":                      "#e11d48",
  "bed in a quad room":        "#e11d48",
  "casa master":               "#b45309",
  "casa shanti":               "#0369a1",
  "shanti king":               "#0369a1",
  "shanti 2 bed":              "#0284c7",
  "casita 4":                  "#78350f",
  "casita 4 / 1 bed":          "#f59e0b",
  "casita 4 / 2 beds":         "#fbbf24",
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

// ─── Auth: OAuth2 with refresh_token → api_key ───────────────────────────────
async function getToken() {
  const now = Date.now();
  if (_token && _token.expires_at_ms > now + 60_000) return _token.access_token;

  const clientId     = process.env.CLOUDBEDS_CLIENT_ID     || "";
  const clientSecret = process.env.CLOUDBEDS_CLIENT_SECRET || "";
  const refreshToken = process.env.CLOUDBEDS_REFRESH_TOKEN || "";

  if (!refreshToken) throw new Error(
    "CLOUDBEDS_REFRESH_TOKEN not set. Visit /.netlify/functions/cloudbeds-setup to authorize."
  );

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  }).toString();

  const res = await httpJSON("POST", CB_TOKEN, body, {
    "Content-Type": "application/x-www-form-urlencoded",
  });

  if (!res.access_token)
    throw new Error("Token refresh failed: " + JSON.stringify(res));

  _token = {
    access_token:  res.access_token,
    expires_at_ms: now + (res.expires_in || 28800) * 1000,
  };
  return _token.access_token;
}

// ─── API actions ─────────────────────────────────────────────────────────────

async function getRooms(tok) {
  // Fetch all pages (v1.3 returns max 100 per page; total can be 183+)
  let allRooms = [];
  let pageNumber = 1;
  while (true) {
    const res = await cbGet(tok, "/getRooms", { pageNumber, pageSize: 100 });
    if (!res.success) throw new Error("getRooms failed: " + JSON.stringify(res));
    // v1.3 nests rooms under data[].rooms (one entry per property)
    for (const prop of (res.data || [])) {
      allRooms = allRooms.concat(prop.rooms || []);
    }
    if (allRooms.length >= (res.total || 0)) break;
    pageNumber++;
    if (pageNumber > 10) break; // safety limit
  }

  const types  = {};
  const lookup = {};

  for (const r of allRooms) {
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
        price1: 0, price2: 0, price1_low: 0, price2_low: 0,
      };
    }
    types[r.roomTypeID].rooms.push(r.roomName);
    _maxOcc[r.roomName] = parseInt(r.maxGuests, 10) || 2;
  }

  _roomLookup = lookup;
  return { roomTypes: Object.values(types), roomLookup: lookup };
}

async function getRates(tok) {
  // Request a 1-night window so roomRate = per-night rate
  const today    = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const res = await cbGet(tok, "/getRatePlans", { startDate: today, endDate: tomorrow });
  if (!res.success) throw new Error("getRatePlans failed: " + JSON.stringify(res));

  // v1.3: res.data is a flat array; only use the two yoga rate plans
  const rates = {};
  for (const entry of (res.data || [])) {
    const rtId    = entry.roomTypeID;
    const planPub = (entry.ratePlanNamePublic || "").toLowerCase();
    const rate    = Math.round(entry.roomRate || 0);
    if (!rtId || !rate) continue;
    if (!rates[rtId]) rates[rtId] = {};

    if (planPub === "yoga rate") {
      rates[rtId].price1 = rate;
      rates[rtId].price2 = rate;
    } else if (planPub === "yoga we take payment") {
      rates[rtId].price1_low = rate;
      rates[rtId].price2_low = rate;
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

  // Auto-populate on cold start (Lambda loses module state between instances)
  if (!_roomLookup[roomName]) await getRooms(tok);

  // Case-insensitive fallback (hub may store "1A" while Cloudbeds has "1a")
  const roomId = _roomLookup[roomName]
    || _roomLookup[roomName.toLowerCase()]
    || _roomLookup[roomName.toUpperCase()];
  if (!roomId) throw new Error(`Room not found in lookup: ${roomName}`);

  const nameParts = (groupName || leaderName || "Group Amansala").trim().split(/\s+/);
  const firstName = nameParts[0];
  const lastName  = nameParts.slice(1).join(" ") || "Amansala";

  const form = new URLSearchParams();
  form.append("propertyID",     process.env.CLOUDBEDS_PROPERTY_ID);
  form.append("startDate",      startDate);
  form.append("endDate",        endDate);
  // roomId format is "roomTypeID-index" (e.g. "667992-0")
  const roomTypeID = roomId.split("-")[0];
  form.append("rooms[0][roomTypeID]", roomTypeID);
  form.append("rooms[0][quantity]",   "1");
  const maxGuests   = _maxOcc[roomName] || _maxOcc[roomName.toLowerCase()] || 2;
  const adultCount  = Math.min(adults || 2, maxGuests);
  form.append("adults[0][roomTypeID]",   roomTypeID);
  form.append("adults[0][quantity]",     String(adultCount));
  form.append("children[0][roomTypeID]", roomTypeID);
  form.append("children[0][quantity]",   "0");
  form.append("guestFirstName", firstName);
  form.append("guestLastName",  lastName);
  form.append("guestEmail",     "groups@amansala.com");
  form.append("guestCountry",   "MX");
  form.append("guestZip",       "77780");
  form.append("paymentMethod",  "cash");
  form.append("notes",          `Group: ${groupName || ""} · Leader: ${leaderName || ""}`);

  const res = await cbPost(tok, "/postReservation", form.toString());
  if (!res.success) {
    // Skip gracefully if no rate is configured for this room type yet
    if (res.message && res.message.includes("No rate found")) {
      console.warn(`[CB] No rate for room ${roomName} — skipping Cloudbeds reservation`);
      return { reservationId: null, roomName, skipped: true };
    }
    throw new Error("postReservation failed: " + JSON.stringify(res));
  }

  return {
    reservationId: res.reservationID,
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
    propertyID: process.env.CLOUDBEDS_PROPERTY_ID,
    ...params,
  }).toString();
  return httpJSON("GET", `${CB_BASE}${path}?${qs}`, null, {
    Authorization:  `Bearer ${tok}`,
    "X-PROPERTY-ID": process.env.CLOUDBEDS_PROPERTY_ID,
  });
}

function cbPost(tok, path, formBody) {
  return httpJSON("POST", `${CB_BASE}${path}`, formBody, {
    Authorization:  `Bearer ${tok}`,
    "X-PROPERTY-ID": process.env.CLOUDBEDS_PROPERTY_ID,
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
  if (n.includes("SHANTI"))   return "CASA SHANTI";
  if (n.includes("MOJAVE"))   return "MOJAVE";
  if (n.includes("CHIKA"))    return "CHIKA";
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
