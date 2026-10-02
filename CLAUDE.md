# WhatsApp AI secretary (wa-bot)

Personal AI secretary + second brain that the owner talks to on WhatsApp (text and voice notes).
Single-user: it only ever answers numbers in OWNER_NUMBERS.

## Architecture
WhatsApp → OpenWA (self-hosted gateway, separate container `openwa-api`) → webhook POST → this bot
→ Groq Whisper (voice transcription) → Gemini (generateContent + function calling) → tools → reply via OpenWA REST API.

- `index.js` webhook server (HMAC-verified, `X-OpenWA-Signature`), message handling, WhatsApp commands, reminder scheduler (every 20s)
- `ai.js` Gemini tool loop; retries 500/503, falls back to GEMINI_FALLBACK_MODEL; echoes model turns verbatim (thought signatures)
- `tools.js` tool declarations (Gemini schema, uppercase types) + handlers: reminders, notes, calendar
- `db.js` SQLite via built-in `node:sqlite`: `messages` (chat history), `reminders`
- `google.js` OAuth refresh-token -> access-token cache + `api()` helper (shared by future Gmail tools)
- `calendar.js` Google Calendar list/create/update/delete; tools are only declared when GOOGLE_* env is set
- `google-auth.js` one-time interactive script (Desktop OAuth client, loopback redirect pasted by hand) that prints GOOGLE_REFRESH_TOKEN
- `vault.js` Obsidian-compatible Markdown vault; optional git sync to a private GitHub repo (VAULT_GIT_REMOTE)

## Constraints
- Zero npm dependencies on purpose: Node 22 built-ins only (http, crypto, fetch, FormData, node:sqlite). Ask before adding packages.
- Free-tier AI: Gemini free tier (rate limits, 429 = quota, 503 = busy). Keep token usage lean.
- Notes are the source of truth as `.md` files (owner also edits them in Obsidian). Never store notes only in SQLite.
- Times: owner is in Asia/Colombo (UTC+05:30). Reminders are stored as epoch ms.

## Runtime
- Runs in Docker on an Oracle Cloud Ampere A1 (ARM64, Ubuntu) server, in `~/OpenWA/wa-bot`.
- `docker-compose.override.yml` lives in `~/OpenWA/` and adds the `wa-bot` service on network `openwa-network`, volume `wa-bot-data:/data` (bot.db + vault).
- OpenWA needs `SSRF_ALLOWED_HOSTS=wa-bot` and `RESOLVE_LID_TO_PHONE=true` in `~/OpenWA/.env`.
- OpenWA API docs: https://github.com/rmyndharis/OpenWA/blob/main/docs/06-api-specification.md (webhooks §6.6)

## Commands
- Rebuild + restart: `cd ~/OpenWA && docker compose up -d --build wa-bot`
- Logs: `docker logs -f wa-bot`
- Syntax check (no node on host): `docker run --rm -v "$PWD":/app -w /app node:22-alpine sh -c 'for f in *.js; do node --check $f; done'`
- Secrets live in `.env` (never commit it).

## Roadmap
- Done: Google Calendar tools + `/today` command.
- Stage 3 ideas: Gmail tools (add the gmail scope in google-auth.js and re-auth), morning briefing, voice-note replies (TTS), smarter note search (embeddings), image/document understanding.
