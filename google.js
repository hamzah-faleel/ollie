// Google APIs via OAuth: swap the long-lived refresh token (from google-auth.js) for short-lived access tokens.
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const enabled = () => Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);

let cached = { token: null, exp: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j.error === 'invalid_grant') throw new Error('Google access expired or was revoked. The owner must re-run google-auth.js and update GOOGLE_REFRESH_TOKEN.');
    throw new Error(`Google token ${res.status} ${j.error_description || j.error || ''}`);
  }
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

// JSON request to a Google API. Retries once with a fresh token on 401.
async function api(url, { method = 'GET', body } = {}, retried = false) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) { cached = { token: null, exp: 0 }; return api(url, { method, body }, true); }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`Google ${method} ${res.status} ${j.error?.message || ''}`.trim());
  }
  return res.status === 204 ? null : res.json();
}

module.exports = { enabled, api };
