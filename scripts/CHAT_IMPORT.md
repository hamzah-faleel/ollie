# Private chat import (runs on your own computer)

Goal: turn your WhatsApp conversations into one summary note per person in the second brain, without any chat
content going to Gemini or passing through the bot.

```
OpenWA (read-only personal session)  --GET only-->  export-chats.js on your Mac  -->  transcripts (local, temporary)
transcripts --> local Claude Code session --> Private/People/<Name>.md in your vault clone --> git --> server vault
```

## Why `Private/`

The bot sends note content to Google in two places: embeddings for note search, and tool results (search_notes,
read_note, find_contact) that Gemini reads when you ask it something. Everything under the vault's top-level
`Private/` folder is excluded from all of that (see `walk()` in `vault.js`). Obsidian and `/graph` still show it.
Put chat-derived notes only there. If you later want the bot to know something about a person, add it yourself
to their normal `People/<Name>.md` card or to `Profile.md`.

## Steps

1. Reach OpenWA from your Mac: `ssh -N -L 2785:127.0.0.1:2785 ubuntu@<server>` (leave it running).
2. Export (Node 22+, no install): `OPENWA_API_KEY=<viewer key> node scripts/export-chats.js --session <personal session id>`
   Start small: `--only "Sam"` or `--since 2026-01-01`. Add `--groups` only if you want groups.
3. Open Claude Code in your vault clone and give it the prompt below, pointing at the export folder.
4. When finished, delete the export folder. Keep it out of git and out of the vault.

## Prompt for the local Claude session

> The folder `<EXPORT_DIR>` has WhatsApp transcripts, one file per person (`_index.md` lists them). My vault is the
> current directory. For each transcript, create or update `Private/People/<Name>.md`. Work one chat at a time,
> and record finished names in `<EXPORT_DIR>/_done.txt` so you can resume.
>
> Note format (keep any text I wrote myself; merge, don't duplicate):
>
> ```
> ---
> private: true
> phone: +94...          (from the transcript header)
> relationship: ...      (your best read: friend, cousin, classmate, client... say "unsure" if so)
> last_contact: YYYY-MM-DD
> source: whatsapp-export YYYY-MM-DD
> ---
> # Name
> ## Snapshot            2-3 sentences: who they are to me, how close, how often we talk
> ## How we talk         tone, language mix, typical topics, response patterns
> ## Open loops          things promised, pending plans, unanswered questions (with dates)
> ## Key moments         dated, one line each: trips, events, favours, disagreements, milestones
> ## Facts               birthday, work/study, family, interests, preferences, important dates
> ```
>
> Rules: be concise and factual, and mark guesses as guesses. Never copy passwords, OTPs, card or ID numbers, or
> addresses. For health, money, romantic or other sensitive topics, record only the topic level
> ("was going through a hard time in March") not the details. Don't quote long passages. Skip chats with fewer than
> 10 messages or only automated/business messages. Don't create any file outside `Private/People/`.

## Privacy notes

- A local Claude Code session still sends what it reads to Anthropic's API. It is private from the bot and from
  Google/Gemini, but not offline. For fully offline processing, use a local model (for example Ollama) with the
  same prompt.
- The personal session must stay passive: a `viewer` API key scoped to that session (`allowedSessions`), no webhook
  registered on it, and the bot pinned to its own session with `BOT_SESSION_ID`.
- Unofficial clients can get numbers banned. This export only reads, one chat at a time with a pause between chats.
