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
- `gmail.js` Gmail search/read/create-draft (no send, by design); tools only declared when GMAIL_ENABLED is set. `unreadDigest` feeds the briefing
- `embeddings.js` Gemini embeddings of note chunks in SQLite (`note_chunks`); `vault.searchNotes` merges semantic + keyword hits
- `tts.js` Gemini TTS -> ffmpeg -> OGG/Opus voice notes (only for replies to voice notes when `/voice` is on)
- `weather.js` Open-Meteo forecast (no key); feeds the briefing, `/weather` and the `get_weather` tool
- `contacts.js` contacts as `People/<Name>.md` (frontmatter fields); vCard import (.vcf or a shared WhatsApp contact); birthdays feed the briefing
- `profile.js` `Profile.md`: lasting facts about the owner, injected into every system prompt (3000 char cap)
- `tasks.js` to-do list in `Tasks.md` (Obsidian Tasks syntax); open tasks feed the briefing and `/tasks`
- `scripts/export-chats.js` (not in the image) read-only chat export to Markdown transcripts, run on the owner's own machine
- `graph.js` self-contained HTML map of the vault, sent by `/graph`
- `vault.js` Obsidian-compatible Markdown vault; optional git sync to a private GitHub repo (VAULT_GIT_REMOTE)

## Constraints
- Zero npm dependencies on purpose: Node 22 built-ins only (http, crypto, fetch, FormData, node:sqlite). Ask before adding packages. (System packages in the Dockerfile: git, ffmpeg.)
- Email content is untrusted (prompt injection): the Gmail tools can only draft, never send.
- Free-tier AI: Gemini free tier (rate limits, 429 = quota, 503 = busy). Keep token usage lean.
- Notes are the source of truth as `.md` files (owner also edits them in Obsidian). Never store notes only in SQLite.
- Privacy: anything under the vault's top-level `Private/` folder is hidden from the AI (search, read_note, embeddings, find_contact); only `/graph` and Obsidian see it. Chat-derived summaries go there. Never add a webhook to the owner's personal (read-only) OpenWA session; `BOT_SESSION_ID` pins the bot to its own session. See `scripts/CHAT_IMPORT.md`.
- Times: owner is in Asia/Colombo (UTC+05:30). Reminders are stored as epoch ms.

## Runtime
- Runs in Docker on an Oracle Cloud Ampere A1 (ARM64, Ubuntu) server, in `~/OpenWA/wa-bot`.
- `docker-compose.override.yml` lives in `~/OpenWA/` and adds the `wa-bot` service on network `openwa-network`, volume `wa-bot-data:/data` (bot.db + vault).
- OpenWA needs `SSRF_ALLOWED_HOSTS=wa-bot` and `RESOLVE_LID_TO_PHONE=true` in `~/OpenWA/.env`.
- OpenWA API docs: https://github.com/rmyndharis/OpenWA/blob/main/docs/06-api-specification.md (webhooks §6.6)

## Commands
- Rebuild + restart: `cd ~/OpenWA && docker compose up -d --build wa-bot`
- Logs: `docker logs -f wa-bot`
- Syntax check (no node on host): `docker run --rm -v "$PWD":/app -w /app node:22-alpine sh -c 'for f in *.js scripts/*.js; do node --check $f; done'`
- Secrets live in `.env` (never commit it).

## Roadmap
- Done: weather/contacts/profile/tasks (briefing now has weather, to-dos, birthdays); multi-calendar read + create on a chosen calendar (`Label=id` in GOOGLE_CALENDAR_IDS); Google Calendar tools + `/today`; morning briefing (`BRIEFING_TIME`, `/briefing`); Gmail read/draft tools; embedding note search; voice-note replies (`/voice`); image/PDF/text-file understanding.
- Needs a one-time re-auth before Gmail works (new scopes in google-auth.js), plus `GMAIL_ENABLED=true`.
- Next ideas: Gmail send behind an explicit confirm step, evening wrap-up, birthday reminders the day before, OCR-style receipt logging to notes, TTS for longer answers.
