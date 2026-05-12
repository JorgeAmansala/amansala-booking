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

      case "updateReservationGuest":
        return ok(h, await updateReservationGuest(tok, body));

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
  // getAvailabilityReport returns HTML; derive availability from getReservations instead
  let allRes = [];
  let pageNumber = 1;
  while (true) {
    const res = await cbGet(tok, "/getReservations", {
      startDate:  start,
      endDate:    end,
      pageNumber,
      pageSize:   100,
    });
    if (!res.success) throw new Error("getReservations failed: " + JSON.stringify(res).slice(0, 300));
    const page = res.data || [];
    allRes = allRes.concat(page);
    if (allRes.length >= (res.total || 0) || page.length === 0) break;
    pageNumber++;
    if (pageNumber > 20) break;
  }

  const unavailable = {};
  const DAY_MS  = 86400000;
  const startMs = new Date(start).getTime();
  const endMs   = new Date(end).getTime();

  for (const r of allRes) {
    if (r.status === "canceled" || r.status === "no_show") continue;
    // rooms may appear as r.assignedRooms, r.rooms, or r.accommodation
    const rooms = r.assignedRooms || r.rooms || r.accommodation || [];
    const resStart = new Date(r.startDate || r.arrivalDate).getTime();
    const resEnd   = new Date(r.endDate   || r.departureDate).getTime();

    for (const room of (Array.isArray(rooms) ? rooms : Object.values(rooms))) {
      const name = room.roomName || room.name || room;
      if (!name || typeof name !== "string") continue;
      if (!unavailable[name]) unavailable[name] = [];
      for (let ms = Math.max(resStart, startMs); ms < Math.min(resEnd, endMs); ms += DAY_MS) {
        const d = new Date(ms).toISOString().slice(0, 10);
        if (!unavailable[name].includes(d)) unavailable[name].push(d);
      }
    }
  }

  return { unavailable };
}

async function createReservation(tok, body) {
  const { roomName, startDate, endDate, groupName, leaderName, adults, guestFullName } = body;
  if (!roomName || !startDate || !endDate)
    throw new Error("roomName, startDate, endDate are required");

  // Auto-populate on cold start (Lambda loses module state between instances)
  if (!_roomLookup[roomName]) await getRooms(tok);

  // Case-insensitive fallback (hub may store "1A" while Cloudbeds has "1a")
  const roomId = _roomLookup[roomName]
    || _roomLookup[roomName.toLowerCase()]
    || _roomLookup[roomName.toUpperCase()];
  if (!roomId) {
    const known = Object.keys(_roomLookup).slice(0, 40).join(", ");
    throw new Error(`Room not found in lookup: ${roomName}. Known rooms: ${known}`);
  }

  // firstName = guest full name (or retreat name if no guest assigned)
  // lastName  = retreat/group name always (for easy filtering in Cloudbeds)
  const retreatName = (groupName || leaderName || "Amansala").trim();
  const firstName   = (guestFullName || retreatName).trim() || "Guest";
  const lastName    = retreatName || "Amansala";

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
    guestId:       res.guestID || null,
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
  // Cloudbeds putReservation uses "status" (not "success") in its response
  return { success: !!(res.success || res.status), raw: res, reservationId };
}

async function updateReservationGuest(tok, body) {
  const { reservationId, guestFirstName, guestLastName,
          groupName, leaderName } = body;
  let { guestId } = body;

  const retreatName = (groupName || leaderName || "Amansala").trim();
  const firstName   = `${guestFirstName || ""} ${guestLastName || ""}`.trim() || retreatName;

  // If guestId not stored locally, look it up from the reservation
  if (!guestId && reservationId) {
    const resInfo = await cbGet(tok, "/getReservation", { reservationID: reservationId });
    console.log("[CB getReservation] raw:", JSON.stringify(resInfo).slice(0, 500));
    guestId = (resInfo.data || {}).guestID;
  }

  if (!guestId) {
    return { success: false, error: "guestID not found — delete and re-create the block" };
  }

  const form = new URLSearchParams({
    propertyID:     process.env.CLOUDBEDS_PROPERTY_ID,
    reservationID:  reservationId,
    guestID:        guestId,
    guestFirstName: firstName,
    guestLastName:  retreatName,
  }).toString();

  const res = await cbPost(tok, "/putGuest", form);
  return { success: !!(res.success || res.status), raw: res, reservationId, guestId };
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
