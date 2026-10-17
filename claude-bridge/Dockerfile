# Claude Code in its own container. It gets NO .env files, no Docker socket and no bot data:
# only its own login volume and a read-only copy of the repo's git history (cloned into /home/node/work).
# Versions are pinned: bridge.js relies on CLI flags (--strict-mcp-config, --setting-sources, --safe-mode, ...) checked against
# this exact CLI version. Bump both on purpose and re-run the checks described in bridge.js.
FROM node:22.23-slim
ARG CLAUDE_CODE_VERSION=2.1.302
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
COPY bridge.js /opt/bridge.js
USER node
ENV HOME=/home/node DISABLE_AUTOUPDATER=1
RUN git config --global --add safe.directory '*' && git config --global user.name "Remote session" && git config --global user.email "remote-session@localhost"
WORKDIR /home/node
EXPOSE 8787
CMD ["node", "/opt/bridge.js"]
