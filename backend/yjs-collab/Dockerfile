# Mindstream Notes — collab relay (E2EE).
#
# Drop-in replacement for the yjs y-websocket-server in deployments that
# want end-to-end encryption. The container runs backend/collab-server.mjs,
# which is a stateless broadcast hub for the encrypted wire format the
# Mindstream client uses (see src/lib/sync/collab-provider.ts). Do NOT
# point a vanilla y-websocket client at this server; it speaks a different
# protocol on purpose.

FROM node:22-alpine

WORKDIR /app

# Single runtime dep. Pinning major.minor; ws is stable enough that this
# rarely needs touching. The lockfile lives in the project root, but for
# a one-file relay we install ws directly to keep the image self-contained.
RUN npm install --omit=dev --no-audit --no-fund ws@8

COPY collab-server.mjs ./collab-server.mjs

ENV HOST=0.0.0.0
ENV PORT=1234
EXPOSE 1234

CMD ["node", "collab-server.mjs"]
