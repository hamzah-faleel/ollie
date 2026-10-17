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

Built with AI assistance. Licensed under MIT.

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

## Personal inbox (read-only)
The bot can read new messages from your personal WhatsApp (everyone, groups included) and summarize them on request. It never replies from that session, and the code refuses any write to it.
- **Storage:** each incoming message (text, or the caption/type for media) is saved in `bot.db` on your server for `INBOX_RETENTION_DAYS` (default 30). Status updates are skipped, and OTP-style codes and card-like numbers are removed before saving. `/inbox clear` deletes everything.
- **Processing:** `/inbox` summarizes everything new since the last digest; `/inbox <name>` covers one person or group over 7 days; `/inbox status` shows counts. Summaries go through OpenRouter with the zero-data-retention settings and **no tools**, so text from other people cannot make the bot do anything. If no compliant model is available it fails and nothing is sent elsewhere. It needs `AI_PROVIDER=openrouter`.
- **Isolation:** the digest is sent straight to you and not saved to the chat memory, so the main assistant (which has tools) never sees other people's messages.
- **Setup:** set `PERSONAL_SESSION_ID` in `.env` and rebuild, then register a webhook on the personal session using a key that can access it (the bot's own key can't). Use the same secret as `WEBHOOK_SECRET`:
  `curl -X POST http://127.0.0.1:2785/api/sessions/<personal session id>/webhooks -H "X-API-Key: <key>" -H "Content-Type: application/json" -d '{"url":"http://wa-bot:3000/webhook","events":["message.received"],"secret":"<WEBHOOK_SECRET>"}'`
  To stop: delete that webhook (`DELETE .../webhooks/<id>`) and run `/inbox clear`.
- **Know the trade-off:** zero data retention means the provider shouldn't keep or train on the text, but your friends' messages still leave the server to OpenRouter and its provider for processing.

### Waiting for your reply, and forwarding replies to you (no AI)
- `/pending` lists chats where the newest message is theirs and you haven't answered (default: waiting 30+ minutes, last 7 days). The morning briefing includes a short "Waiting for your reply" section. It only knows you answered if the personal-session webhook also sends `message.sent`: update it with `curl -X PUT http://127.0.0.1:2785/api/sessions/<personal session id>/webhooks/<webhook id> -H "X-API-Key: <key>" -H "Content-Type: application/json" -d '{"events":["message.received","message.sent"]}'`.
- Messages sent to the **bot's own number** by other people (for example replies to a message the bot sent for you) are stored and forwarded to you as `↩️ Name (+number): text`. `/forward replies` (default) relays only people the bot has messaged for you, `/forward all` relays every direct message, `/forward off` only stores them. At most 10 forwards per person and 60 overall per hour (`FORWARD_PER_SENDER_HOUR`, `FORWARD_TOTAL_HOUR`), with a single "holding back" notice. The bot never answers these people on its own.

### Alerts and the routine check (no AI)
Every minute the bot checks your calendar for **online meetings** (it needs a Meet/Zoom/Teams link) and every 10 minutes your **messages**. It texts you on WhatsApp about:
- a meeting starting in 10 min, and again urgently at 2 min;
- a message that sounds urgent (urgent, asap, call me...), several pings in a row, or a message from a **VIP** (`/vip add <name>`) that you haven't answered;
- a missed WhatsApp call (needs the `call.missed` event on the personal webhook);
- chats waiting for your reply for 2h+ (a gentle nudge, daytime only).
Replying to the bot with anything (or `/ack`) acknowledges. An **urgent** alert you don't acknowledge within 4 minutes escalates to a **phone call** if you set up Twilio. Quiet hours (default 23:30-07:00) hold normal alerts and suppress calls. Limits: 8 alert texts an hour, 5 calls a day. `/alerts` lists, `/watch` shows what is watched, `/watch now` checks immediately.
- **Phone calls** (optional): OpenWA cannot place calls, so create a Twilio account (a number that can call your phone), then set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` in `.env` and rebuild. `/callme` places a test call. By default the call says only "you have an urgent message on WhatsApp" (`CALL_SPEAK_DETAILS=true` adds the name or meeting title, which Twilio will see).
- **Webhook events:** update the personal-session webhook to `["message.received","message.sent","call.missed"]` with the same `PUT` as in "Waiting for your reply".

### New people: the intake form and the AI gate
`/intake on` makes the bot ask a **new** number that writes to it four fixed questions (name, how they know you with a menu that separates *uni club*, *classmate*, *work*, *former work*, *client*, club/company, best time to reach). No AI. The answers are saved in their private note and you get a summary. People you already know (they have a note, a contact, or the bot messaged them for you) are never put through it. STOP is honoured forever; at most 5 new people a day and 12 template messages per person a day. `/people` lists everyone.
The AI only talks to someone after you say `/allow <name>`. It is suggested to you when someone has finished the form, written 5+ times, and you're in touch (at most 2 suggestions a day, each person once a week). An allowed chat is short (2 sentences), never shares links, emails or personal details, can't agree to anything, uses the zero-data-retention route with no tools, is limited to 6 replies an hour per person, and every exchange is copied to you. `/allow off <name>`, `/allow off all` or `/intake off` stop it.

### Who is who: relationships
Relationships used to be guessed from chat text, which mixed up uni clubs and work. Now **you** decide: `/rel` shows people one page at a time with a keyword hint, and you reply like `/rel 1=c 2=e 3=skip`. Letters: A family, B friend, C uni club, D classmate, E work, F former work, G client, H shop/service, I acquaintance, J other. Your choice is marked `reviewed: true` and the nightly memory job never changes it. `/rel stats` shows the split.

### Memory: keeping the Private/People notes up to date
A background job turns your personal chats into the hidden `Private/People/<Name>.md` notes (snapshot, how you talk, open loops, key moments, facts), so your second brain follows your conversations.
- **When:** every night at `MEMORY_TIME` (default 03:00 local), or `/memory run` to start it now, `/memory` for status. It is quiet unless something needs attention.
- **Older history:** put a read-only (viewer) OpenWA key for the personal session in `.env` as `OPENWA_PERSONAL_KEY` (never paste it in chat). The job fetches old 1:1 history a few chats per night (`MEMORY_BACKFILL_CHATS`, default 15; `MEMORY_BACKFILL_MESSAGES`, default 500 newest per chat). It only makes GET requests. Old history never shows up in `/inbox`.
- **What it does with a chat:** finds the person's note by phone number (or creates one), sends the existing note plus the new messages to the zero-data-retention model with no tools, and writes back the merged note. Your own hand-written text and the `relationship:` line are kept. Incomplete or much-shorter model answers are rejected and retried the next night. Automated or business chats are skipped. Groups are not turned into notes.
- **Cost control:** a chat is processed only when it has at least `MEMORY_MIN_MESSAGES` (default 5) new messages, or its oldest has waited 3 days. Each night stops at `MEMORY_NIGHTLY_CHARS` (default 600000 characters, about 150k input tokens) and at the daily spend limit, and resumes the next night. Expect cents per month once the first backfill is done.
- **Retention:** raw messages are deleted `INBOX_RETENTION_DAYS` (30) after being folded into a note; never-processed ones after 180 days. To record your own replies for new messages too, add the `message.sent` event to the personal-session webhook.

## Private notes
Anything under the vault's top-level `Private/` folder is hidden from the AI (search, read_note, embeddings, find_contact). Chat-derived summaries live in `Private/People`; see `scripts/CHAT_IMPORT.md`. `/graph` and Obsidian still show them.

## Tests
`node scripts/test-mock.js` starts the real bot against a fake OpenRouter and fake OpenWA and checks plain replies, tool calls, retries, the fallback, credit handling, `/usage`, `/model` and the spend guard. Run it in Docker: `docker run --rm -v "$PWD":/app -w /app node:22-alpine node --disable-warning=ExperimentalWarning scripts/test-mock.js`

## Setup on the server
1. This folder lives at `~/OpenWA/wa-bot`; `docker-compose.override.yml` goes in `~/OpenWA/`.
2. `cp wa-bot/.env.example wa-bot/.env` and fill it in.
3. `~/OpenWA/.env` needs `SSRF_ALLOWED_HOSTS=wa-bot` and `RESOLVE_LID_TO_PHONE=true`.
4. `cd ~/OpenWA && docker compose up -d --build` the first time. To redeploy only the bot use `docker compose up -d --build --no-deps wa-bot`: without `--no-deps`, OpenWA restarts too and both WhatsApp sessions (the bot's and your personal one) drop; start them again from the dashboard WhatsApp tab
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
Sending email (optional, off by default): add the `gmail.send` scope to the consent screen, re-run `google-auth.js` once more and replace `GOOGLE_REFRESH_TOKEN`, then set `GMAIL_SEND_ENABLED=true` and rebuild with `cd ~/OpenWA && docker compose up -d --build --no-deps wa-bot`. Ask "reply to Sam's email saying yes" and the bot shows the exact To, subject and body; it sends only after you type `yes` (15 min expiry, `EMAIL_DAILY_LIMIT` default 5 per 24h, `/email` shows or cancels it). If it read email in that chat and the address is not the sender you're replying to or a saved contact, it warns you and you must type `yes <address>`.
Note: Google treats `gmail.readonly` as a restricted scope. For personal use you can click through the "unverified app" warning, but public verification needs a security assessment.

## Backup
`docker run --rm -v openwa_wa-bot-data:/data -v $PWD:/out alpine tar czf /out/wa-bot-backup.tgz /data`


## Claude bridge (nightly runs on Claude, `/code` from your phone)
Claude Code runs in its own container so it can never read the bot's `.env` files.
1. `cd ~/OpenWA && docker compose up -d --build claude-bridge` (needs `claude-bridge.env` with `BRIDGE_TOKEN=<random>`; the same value goes into `wa-bot/.env` as `CLAUDE_BRIDGE_TOKEN`, plus `CLAUDE_BRIDGE_URL=http://claude-bridge:8787`).
2. Log in once: `docker exec -it claude-bridge claude`, then `/login` (a Claude subscription is needed for Remote Control).
3. Rebuild the bot with `docker compose up -d --build --no-deps wa-bot`.
4. WhatsApp: `/nightly claude` (nightly memory run on Claude, all tools off), `/code start` (opens a Claude Code session you then drive from the Claude app > Code; each action asks you for approval), `/code stop`.
