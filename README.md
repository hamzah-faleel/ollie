# Ollie: WhatsApp AI secretary + second brain

Ollie is a single-user AI secretary I talk to on WhatsApp. I send a text or a voice note, and it replies, sets reminders, saves notes to a Markdown vault I can also open in Obsidian, and reads or edits my Google Calendar.

**How it works:** WhatsApp -> OpenWA gateway -> HMAC-verified webhook -> Groq Whisper (voice) -> Gemini with function calling -> tools -> reply.

**Design choices**
- Zero npm dependencies: Node 22 built-ins only (`http`, `crypto`, `fetch`, `node:sqlite`).
- Notes are plain `.md` files, with optional Git sync to a private repo.
- Retries and a fallback model to cope with free-tier Gemini limits.
- Only answers the owner's number.
- Self-hosted with Docker on an Oracle Cloud ARM server.

Built with AI assistance (Claude Code). Licensed under MIT.

---

Text or voice note in -> Gemini (with tools) -> reply on WhatsApp. Only answers OWNER_NUMBERS.

- `index.js`  webhook server, message handling, reminder scheduler
- `ai.js`     Gemini call + tool loop (retries, fallback model)
- `tools.js`  tools the AI can use (reminders, notes)
- `db.js`     SQLite: chat history + reminders (`/data/bot.db`)
- `vault.js`  Obsidian-style Markdown vault (`/data/vault`), optional Git sync
- `google.js` Google OAuth (refresh token -> access token); `calendar.js` Calendar tools
- `google-auth.js` one-time script to get the refresh token

WhatsApp commands: `/help`, `/today`, `/reminders`, `/notes`, `/reset`

## Setup on the server
1. This folder lives at `~/OpenWA/wa-bot`; `docker-compose.override.yml` goes in `~/OpenWA/`.
2. `cp wa-bot/.env.example wa-bot/.env` and fill it in.
3. `~/OpenWA/.env` needs `SSRF_ALLOWED_HOSTS=wa-bot` and `RESOLVE_LID_TO_PHONE=true`.
4. `cd ~/OpenWA && docker compose up -d --build`
5. Register the webhook once (see earlier instructions). Logs: `docker logs -f wa-bot`

## Obsidian sync (optional)
1. Create a **private** GitHub repo, e.g. `second-brain` (empty, no README).
2. Create a fine-grained token with Contents: read & write on that repo only.
3. In `.env`: `VAULT_GIT_REMOTE=https://TOKEN@github.com/USER/second-brain.git`
4. On your Mac: clone the repo, open the folder as a vault in Obsidian, install the "Git" community plugin and enable auto pull.

## Google Calendar (optional)
1. console.cloud.google.com: create a project, enable **Google Calendar API**.
2. Google Auth Platform (OAuth consent screen): External, add yourself as a test user, then **Publish app** (In production).
   Apps left in "Testing" get refresh tokens that expire after 7 days.
3. Clients: create an OAuth client of type **Desktop app**. Put its ID and secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. `docker exec -it wa-bot node google-auth.js`, open the link, approve (click through "Google hasn't verified this app"),
   paste back the 127.0.0.1 URL the browser lands on. Put the printed `GOOGLE_REFRESH_TOKEN` in `.env`.
5. `cd ~/OpenWA && docker compose up -d wa-bot`, then send `/today` on WhatsApp.

## Backup
`docker run --rm -v openwa_wa-bot-data:/data -v $PWD:/out alpine tar czf /out/wa-bot-backup.tgz /data`
