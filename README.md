# Ollie: WhatsApp AI secretary + second brain

Ollie is a single-user AI secretary I talk to on WhatsApp. I send a text or a voice note, and it replies, sets reminders, saves notes to a Markdown vault I can also open in Obsidian, reads or edits my Google Calendar, searches Gmail and drafts replies (never sends), reads photos and PDFs, finds notes by meaning, keeps my contacts, to-do list and a profile of my life, and sends a morning briefing with weather, today's agenda, tasks, birthdays and unread email.

**How it works:** WhatsApp -> OpenWA gateway -> HMAC-verified webhook -> Groq Whisper (voice) -> AI model with function calling (OpenRouter or Gemini) -> tools -> reply.

**Design choices**
- Zero npm dependencies: Node 22 built-ins only (`http`, `crypto`, `fetch`, `node:sqlite`).
- Notes are plain `.md` files, with optional Git sync to a private repo.
- Retries and a fallback model, a daily spend guard, and per-call usage tracking.
- Zero-data-retention routing on OpenRouter: prompts only go to endpoints that don't keep or train on them.
- Only answers the owner's number.
- Self-hosted with Docker on an Oracle Cloud ARM server.

Built with AI assistance (Claude Code). Licensed under MIT.

---

Text or voice note in -> AI model (with tools) -> reply on WhatsApp. Only answers OWNER_NUMBERS.

- `index.js`  webhook server, message handling, reminder scheduler
- `ai.js`     provider-independent tool loop; `ai-openrouter.js` and `ai-gemini.js` are the providers (`AI_PROVIDER`), `ai-common.js` shared errors + usage log
- `usage.js`  `ai_usage` table, `/usage` report, daily spend guard; `models.js` runtime model choice (`/model`) and prices
- `outbox.js` messages to other people: the AI drafts, you reply `yes` to send (from the bot's own number)
- `tools.js`  tools the AI can use (reminders, notes)
- `db.js`     SQLite: chat history + reminders (`/data/bot.db`)
- `vault.js`  Obsidian-style Markdown vault (`/data/vault`), optional Git sync
- `google.js` Google OAuth (refresh token -> access token); `calendar.js` Calendar tools; `gmail.js` Gmail search/read/draft tools; `weather.js`, `contacts.js`, `profile.js`, `tasks.js` weather, people, life profile and to-dos (all stored as Markdown in the vault)
- `google-auth.js` one-time script to get the refresh token

WhatsApp commands: `/help`, `/today`, `/tasks`, `/weather`, `/briefing`, `/voice`, `/reminders`, `/notes`, `/graph`, `/usage`, `/model`, `/reset`

| Command | What it does |
| --- | --- |
| `/usage` | AI messages, tokens and cost for today, this week and this month, plus the models that answered |
| `/model` | Show the main and fallback AI models |
| `/model <slug>` | Switch the main model (checked against OpenRouter; must support tools; survives restarts) |
| `/model reset` | Go back to `OPENROUTER_MODEL` from `.env` |
| `/graph` | Interactive map of the vault as an HTML file; people notes are coloured by relationship |

A morning briefing (calendar, reminders, unread email) is sent daily at `BRIEFING_TIME` (default 07:00 local). It goes to the chat you last messaged the bot from.

## AI provider and models
`AI_PROVIDER` in `.env` picks the backend: `openrouter` (recommended) or `gemini` (the original direct path).

**OpenRouter setup**
1. Put `OPENROUTER_API_KEY` in `.env` (never commit it) and set `AI_PROVIDER=openrouter`.
2. In your OpenRouter account, turn on Zero Data Retention and turn off training/data sharing.
3. Optional: `OPENROUTER_MODEL` (default `openai/gpt-6-luna`) and `OPENROUTER_FALLBACK_MODEL` (default `google/gemini-3.1-flash-lite`). Find slugs at https://openrouter.ai/api/v1/models.
4. Rebuild (see below).

Every request asks OpenRouter for `zdr: true`, `data_collection: "deny"`, `allow_fallbacks: false` and `require_parameters: true`, so it only reaches zero-data-retention endpoints that support tool calling. If a model has no endpoint allowed under those rules, the bot goes straight to the fallback model.

**Reliability.** 429/500/502/503 and network errors are retried after 2s, 4s and 8s, then the fallback model answers. If OpenRouter returns 402 (out of credit), the bot replies that the AI is unavailable and sends "AI credit ran out — top up OpenRouter" at most once an hour.

**Caching.** The current time is placed on the newest message instead of the system prompt, so the system prompt and tool list stay identical between messages and providers can cache them (OpenAI and Gemini models cache automatically; Anthropic models get an explicit cache marker).

Voice notes always go through Groq Whisper. Embeddings (note search) and voice replies still use Gemini, so they need `GEMINI_API_KEY` even when `AI_PROVIDER=openrouter`.

### How to switch models
- From WhatsApp: `/model` to see the current ones, `/model openai/gpt-6-luna` (any OpenRouter slug) to switch the main model, `/model reset` to go back to the `.env` default. A wrong slug is rejected with suggestions, and models without tool support are refused. The choice is kept across restarts.
- Permanently: change `OPENROUTER_MODEL` / `OPENROUTER_FALLBACK_MODEL` in `.env`, then rebuild.
- Back to direct Gemini: set `AI_PROVIDER=gemini` (uses `GEMINI_MODEL`) and rebuild.

### How to check costs
- `/usage` on WhatsApp: today, this week (since Monday) and this month, each with messages, tokens and dollars, then calls and cost per model. A `+` after a cost means some calls had no cost data (direct Gemini doesn't report cost).
- `docker logs wa-bot | grep "\[ai\]"` gives one line per request: `model`, `in`, `out`, `cached` tokens and `cost`.
- Raw data: the `ai_usage` table in `/data/bot.db`. OpenRouter's own Activity page is the source of truth for billing.
- Spend guard: `DAILY_SPEND_LIMIT_USD` (default 0.50, `0` turns it off). Once today's cost (local time) reaches it, the bot tries the cheaper of the main and fallback models first for the rest of the day and warns you once. The check runs at the start of each message, so one long tool-using message can overshoot slightly.

## Messaging other people
Tell the bot "message Sam that I'm running late". It writes a draft and shows you the exact text. Nothing is sent until you reply `yes` (typed, not a voice note); `no` cancels, and asking for a change makes a new draft. Drafts expire after 15 minutes, and `SEND_DAILY_LIMIT` (default 10 per 24h) caps sends. Messages come from the bot's own number, never from your personal WhatsApp session.
Names are looked up in `People/` first, then in `Private/People` (in code only, the AI never sees those notes). Numbers starting with `0` get `DEFAULT_COUNTRY_CODE` (default 94). To add contacts in bulk, send the bot a `.vcf` export.

## Private notes
Anything under the vault's top-level `Private/` folder is hidden from the AI (search, read_note, embeddings, find_contact). Chat-derived summaries live in `Private/People`; see `scripts/CHAT_IMPORT.md`. `/graph` and Obsidian still show them.

## Tests
`node scripts/test-mock.js` starts the real bot against a fake OpenRouter and fake OpenWA and checks plain replies, tool calls, retries, the fallback, credit handling, `/usage`, `/model` and the spend guard. Run it in Docker: `docker run --rm -v "$PWD":/app -w /app node:22-alpine node --disable-warning=ExperimentalWarning scripts/test-mock.js`

## Setup on the server
1. This folder lives at `~/OpenWA/wa-bot`; `docker-compose.override.yml` goes in `~/OpenWA/`.
2. `cp wa-bot/.env.example wa-bot/.env` and fill it in.
3. `~/OpenWA/.env` needs `SSRF_ALLOWED_HOSTS=wa-bot` and `RESOLVE_LID_TO_PHONE=true`.
4. `cd ~/OpenWA && docker compose up -d --build` (rebuilding can restart `openwa-api` and leave the bot's WhatsApp session `disconnected`; check `GET /api/sessions/<id>` and `POST /api/sessions/<id>/start` if it does)
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

## Gmail (optional)
Adds search, read and draft tools. The bot can save drafts but never sends email; you review and send from Gmail.
1. In the same Google Cloud project, enable the **Gmail API** and add the scopes `gmail.readonly` and `gmail.compose` to the consent screen.
2. Re-run `docker exec -it wa-bot node google-auth.js` (it now requests the Gmail scopes too) and replace `GOOGLE_REFRESH_TOKEN` in `.env`.
3. Add `GMAIL_ENABLED=true` to `.env`, then `cd ~/OpenWA && docker compose up -d wa-bot`.
Note: Google treats `gmail.readonly` as a restricted scope. For personal use you can click through the "unverified app" warning, but public verification needs a security assessment.

## Backup
`docker run --rm -v openwa_wa-bot-data:/data -v $PWD:/out alpine tar czf /out/wa-bot-backup.tgz /data`
