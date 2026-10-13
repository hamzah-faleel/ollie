# WhatsApp AI secretary (wa-bot)

Personal AI secretary + second brain that the owner talks to on WhatsApp (text and voice notes).
Single-user: it only ever answers numbers in OWNER_NUMBERS.

## Architecture
WhatsApp → OpenWA (self-hosted gateway, separate container `openwa-api`) → webhook POST → this bot
→ Groq Whisper (voice transcription) → AI provider (OpenRouter chat completions, or Gemini generateContent, with function calling) → tools → reply via OpenWA REST API.

- `index.js` webhook server (HMAC-verified, `X-OpenWA-Signature`), message handling, WhatsApp commands, reminder scheduler (every 20s)
- `ai.js` provider-independent tool loop (max 6 steps); `AI_PROVIDER=openrouter|gemini`. Providers are flat files because the Dockerfile only copies `*.js`
- `ai-openrouter.js` OpenAI-compatible chat completions; sends ZDR/no-collection routing on every request; retries 429/500/502/503 (2/4/8s), then fallback model; 404 = no allowed endpoint -> fallback; 402 -> `CreditError`; clock moved out of the system prompt (cacheable)
- `ai-gemini.js` the original Gemini path; retries 500/503, falls back to GEMINI_FALLBACK_MODEL; echoes model turns verbatim (thought signatures)
- `ai-common.js` error classes, one-line `[ai]` usage log (also writes `ai_usage`), turn ids, `bus` (spend-limit event)
- `usage.js` `ai_usage` table, `/usage` report, daily spend guard (`DAILY_SPEND_LIMIT_USD`); `models.js` runtime main model in SQLite kv (`model_main`), OpenRouter model list + prices
- `tools.js` tool declarations (Gemini schema, uppercase types; `openaiTools()` derives the OpenAI format, so tools are defined once) + handlers: reminders, notes, calendar
- `db.js` SQLite via built-in `node:sqlite`: `messages` (chat history), `reminders`
- `google.js` OAuth refresh-token -> access-token cache + `api()` helper (shared by future Gmail tools)
- `calendar.js` Google Calendar list/create/update/delete; tools are only declared when GOOGLE_* env is set
- `google-auth.js` one-time interactive script (Desktop OAuth client, loopback redirect pasted by hand) that prints GOOGLE_REFRESH_TOKEN
- `gmail.js` Gmail search/read/create-draft (no send, by design); tools only declared when GMAIL_ENABLED is set. `unreadDigest` feeds the briefing
- `outbox.js` WhatsApp messages to other people from the bot's own number. The AI only drafts (`send_whatsapp`); `index.js` sends when the owner replies yes (typed, code-level check, 15 min expiry, `SEND_DAILY_LIMIT`). Names are also looked up in `Private/People` in code only (phone numbers; the AI never sees those notes). Never send from the personal session
- `inbox.js` read-only personal inbox: stores incoming messages from the personal session (SQLite `inbox_messages`, `INBOX_RETENTION_DAYS`, OTP/card numbers redacted), `/inbox` digest via `ai.untrusted()`
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
- AI cost: default is OpenRouter with low-cost models (gpt-6-luna, gemini flash-lite), paid per token; Gemini free tier is the alternative (429 = quota, 503 = busy). Keep token usage lean. Never print, log or commit API keys.
- AI privacy: OpenRouter requests must keep `provider: { zdr: true, data_collection: 'deny', allow_fallbacks: false, require_parameters: true }`.
- Embeddings and TTS still call Gemini directly (`GEMINI_API_KEY`), whatever `AI_PROVIDER` is.
- Notes are the source of truth as `.md` files (owner also edits them in Obsidian). Never store notes only in SQLite.
- Privacy: anything under the vault's top-level `Private/` folder is hidden from the AI (search, read_note, embeddings, find_contact); only `/graph` and Obsidian see it. Chat-derived summaries go there. `BOT_SESSION_ID` pins the bot's own behaviour to its own session. The owner's personal OpenWA session (`PERSONAL_SESSION_ID`) is READ-ONLY: since 2026-10-13 the owner allows a message.received webhook on it, but only for `inbox.js` (store messages, summarize on `/inbox`). Everything from that session is routed to storage before any bot logic; `openwa()` refuses every non-GET call to it; summaries use `ai.untrusted()` (OpenRouter ZDR routing, no tools, fails closed, never Gemini direct); digests are sent directly and not saved to chat memory. Do not widen this (no replies, no tools on that text, no non-ZDR models). See `scripts/CHAT_IMPORT.md`.
- Times: owner is in Asia/Colombo (UTC+05:30). Reminders are stored as epoch ms.

## Runtime
- Runs in Docker on an Oracle Cloud Ampere A1 (ARM64, Ubuntu) server, in `~/OpenWA/wa-bot`.
- `docker-compose.override.yml` lives in `~/OpenWA/` and adds the `wa-bot` service on network `openwa-network`, volume `wa-bot-data:/data` (bot.db + vault).
- OpenWA needs `SSRF_ALLOWED_HOSTS=wa-bot` and `RESOLVE_LID_TO_PHONE=true` in `~/OpenWA/.env`.
- OpenWA API docs: https://github.com/rmyndharis/OpenWA/blob/main/docs/06-api-specification.md (webhooks §6.6)

## Commands
- Rebuild + restart: `cd ~/OpenWA && docker compose up -d --build wa-bot`
- Logs: `docker logs -f wa-bot`
- Mock tests: `docker run --rm -v "$PWD":/app -w /app node:22-alpine node --disable-warning=ExperimentalWarning scripts/test-mock.js`
- After a rebuild check the bot's OpenWA session and `POST /api/sessions/<id>/start` if `disconnected`
- Syntax check (no node on host): `docker run --rm -v "$PWD":/app -w /app node:22-alpine sh -c 'for f in *.js scripts/*.js; do node --check $f; done'`
- Secrets live in `.env` (never commit it).

## Roadmap
- Done: weather/contacts/profile/tasks (briefing now has weather, to-dos, birthdays); multi-calendar read + create on a chosen calendar (`Label=id` in GOOGLE_CALENDAR_IDS); Google Calendar tools + `/today`; morning briefing (`BRIEFING_TIME`, `/briefing`); Gmail read/draft tools; embedding note search; voice-note replies (`/voice`); image/PDF/text-file understanding; OpenRouter provider + `/usage` + `/model` + daily spend guard; confirm-to-send WhatsApp messages (`outbox.js`); `/graph` coloured by relationship.
- Needs a one-time re-auth before Gmail works (new scopes in google-auth.js), plus `GMAIL_ENABLED=true`.
- Next ideas: Gmail send behind the same confirm step as outbox.js, evening wrap-up, birthday reminders the day before, OCR-style receipt logging to notes, TTS for longer answers.
