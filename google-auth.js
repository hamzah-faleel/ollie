// One-time setup: get a Google refresh token for the bot.
//   docker exec -it wa-bot node google-auth.js
// Uses the "Desktop app" OAuth client. Google redirects to 127.0.0.1, which won't load in your
// browser; that's expected. Copy the full URL from the address bar and paste it here.
const crypto = require('crypto');
const readline = require('readline/promises');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const REDIRECT = 'http://127.0.0.1:8085';

(async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const clientId = process.env.GOOGLE_CLIENT_ID || (await rl.question('OAuth client ID: ')).trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || (await rl.question('OAuth client secret: ')).trim();

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256',
  });

  console.log(`\n1. Open this link and approve:\n\n${url}\n`);
  console.log('2. The browser ends on a page that fails to load (127.0.0.1). Copy that whole URL.\n');
  const pasted = (await rl.question('Paste it here: ')).trim();
  rl.close();
  const code = pasted.includes('code=') ? new URL(pasted).searchParams.get('code') : pasted;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const j = await res.json();
  if (!res.ok || !j.refresh_token) { console.error('\nFailed:', j.error_description || j.error || JSON.stringify(j)); process.exit(1); }
  console.log(`\nAdd this to wa-bot/.env:\n\nGOOGLE_REFRESH_TOKEN=${j.refresh_token}\n`);
})();
