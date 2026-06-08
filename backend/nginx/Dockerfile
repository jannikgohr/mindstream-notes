# Mindstream Notes — collab edge proxy.
#
# Fronts the two backend services on a single listener:
#   /socket.io/  → excalidraw-room (freeform live sync, official protocol)
#   /            → yjs-relay       (markdown + PDF collab, custom E2EE)
#
# Plain HTTP only — TLS is the operator's responsibility upstream
# (Caddy/Cloudflare/etc. terminate and forward here).

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
