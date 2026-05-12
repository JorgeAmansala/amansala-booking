"use strict";
const { request } = require("https");

// One-time OAuth2 setup helper.
// GET  /.netlify/functions/cloudbeds-setup          → redirect to Cloudbeds authorization
// GET  /.netlify/functions/cloudbeds-setup?code=XXX → exchange code for tokens

exports.handler = async (event) => {
  const qs           = event.queryStringParameters || {};
  const clientId     = process.env.CLOUDBEDS_CLIENT_ID     || "";
  const clientSecret = process.env.CLOUDBEDS_CLIENT_SECRET || "";
  const redirectUri  = process.env.CLOUDBEDS_REDIRECT_URI  ||
    `https://${event.headers.host}/.netlify/functions/cloudbeds-setup`;

  // Step 2: exchange authorization code for tokens
  if (qs.code) {
    const body = new URLSearchParams({
      grant_type:    "authorization_code",
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      code:          qs.code,
    }).toString();

    const res = await httpJSON(
      "POST",
      "https://api.cloudbeds.com/api/v1.2/access_token",
      body,
      { "Content-Type": "application/x-www-form-urlencoded" }
    );

    if (!res.refresh_token) {
      return html(502, `
        <h2 style="color:red">Error exchanging code</h2>
        <pre>${JSON.stringify(res, null, 2)}</pre>
        <p><a href="/.netlify/functions/cloudbeds-setup">Try again</a></p>
      `);
    }

    return html(200, `
      <h2 style="color:green">✓ Authorization successful</h2>
      <p>Add this environment variable to Netlify and redeploy:</p>
      <table border="1" cellpadding="8" style="border-collapse:collapse;font-family:monospace">
        <tr><th>Key</th><th>Value</th></tr>
        <tr>
          <td><strong>CLOUDBEDS_REFRESH_TOKEN</strong></td>
          <td style="word-break:break-all">${res.refresh_token}</td>
        </tr>
      </table>
      <br>
      <p><strong>Steps:</strong></p>
      <ol>
        <li>Copy the refresh_token value above</li>
        <li>Go to Netlify → Project configuration → Environment variables</li>
        <li>Add: Key = <code>CLOUDBEDS_REFRESH_TOKEN</code>, Value = the token above</li>
        <li>Trigger a new deploy</li>
      </ol>
      <p style="color:gray;font-size:12px">
        Access token (expires in ${res.expires_in}s): ${res.access_token}
      </p>
    `);
  }

  // Step 1: redirect to Cloudbeds authorization page
  const authUrl = "https://api.cloudbeds.com/api/v1.3/oauth?" + new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: "code",
  }).toString();

  return {
    statusCode: 302,
    headers:    { Location: authUrl },
    body:       "",
  };
};

function httpJSON(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const buf = body ? Buffer.from(body) : null;
    const req = request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers:  { ...headers, "Content-Length": buf ? buf.length : 0 },
    }, (res) => {
      let d = "";
      res.on("data", c => { d += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({ raw: d }); }
      });
    });
    req.on("error", reject);
    if (buf) req.write(buf);
    req.end();
  });
}

function html(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>body{font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 20px}</style>
      </head><body>${body}</body></html>`,
  };
}
