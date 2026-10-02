# wa-bot: WhatsApp AI secretary + second brain

Text or voice note in -> Gemini (with tools) -> reply on WhatsApp. Only answers OWNER_NUMBERS.

- `index.js`  webhook server, message handling, reminder scheduler
- `ai.js`     Gemini call + tool loop (retries, fallback model)
- `tools.js`  tools the AI can use (reminders, notes)
- `db.js`     SQLite: chat history + reminders (`/data/bot.db`)
- `vault.js`  Obsidian-style Markdown vault (`/data/vault`), optional Git sync

WhatsApp commands: `/help`, `/reminders`, `/notes`, `/reset`

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

## Backup
`docker run --rm -v openwa_wa-bot-data:/data -v $PWD:/out alpine tar czf /out/wa-bot-backup.tgz /data`
