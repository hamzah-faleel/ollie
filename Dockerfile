FROM node:22-alpine
# git: vault sync. ffmpeg: turns Gemini TTS audio into WhatsApp voice notes (OGG/Opus).
RUN apk add --no-cache git ffmpeg
WORKDIR /app
COPY *.js ./
# /data holds bot.db and the notes vault; owned by the unprivileged node user
RUN mkdir -p /data && chown node:node /data
USER node
ENV DB_PATH=/data/bot.db VAULT_DIR=/data/vault
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "index.js"]
