# Claude Code in its own container. It gets NO .env files, no Docker socket and no bot data:
# only its own login volume and a read-only copy of the repo's git history (cloned into /home/node/work).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code
COPY bridge.js /opt/bridge.js
USER node
ENV HOME=/home/node
RUN git config --global --add safe.directory '*' && git config --global user.name "Claude (bridge)" && git config --global user.email "claude-bridge@localhost"
WORKDIR /home/node
EXPOSE 8787
CMD ["node", "/opt/bridge.js"]
