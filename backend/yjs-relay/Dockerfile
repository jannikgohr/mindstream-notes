# Mindstream Notes — collab relay (E2EE).
#
# Drop-in replacement for the yjs y-websocket-server in deployments that
# want end-to-end encryption. The container runs collab-server.mjs,
# which is a stateless broadcast hub for the encrypted wire format the
# Mindstream client uses (see src/lib/sync/collab-provider.ts). Do NOT
# point a vanilla y-websocket client at this server; it speaks a different
# protocol on purpose.

FROM node:22-slim

WORKDIR /app

# uWebSockets.js: C++-backed WebSocket server with native pub/sub fanout
# and proper backpressure signals (orders of magnitude lower per-connection
# overhead than `ws`). Not published on npm — install from the upstream
# Git tag. node:22-slim (glibc) matches the prebuilt binary that ships
# with the tag, so no native compile step is needed. Bump the pinned tag
# when upstream releases a newer Node 22-compatible build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && npm install --omit=dev --no-audit --no-fund "uNetworking/uWebSockets.js#v20.49.0" \
 && apt-get purge -y --auto-remove git \
 && rm -rf /var/lib/apt/lists/*

COPY collab-server.mjs ./collab-server.mjs

ENV HOST=0.0.0.0
ENV PORT=1234
EXPOSE 1234

CMD ["node", "collab-server.mjs"]
