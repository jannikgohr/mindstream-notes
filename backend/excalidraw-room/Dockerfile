# Mindstream Notes — excalidraw-room (freeform live sync).
#
# We don't ship anything from this repo into the image; we just build
# upstream excalidraw/excalidraw-room and run it. Pinned to a known-
# good commit so rebuilds are reproducible and upstream master can
# never break us without an intentional bump.
#
# Bump procedure: pick a fresh commit from
#   https://github.com/excalidraw/excalidraw-room/commits/master,
# update EXCALIDRAW_ROOM_REF below, rebuild and smoke-test.

ARG EXCALIDRAW_ROOM_REF=03ff435860b508d7cd9e005cfc90f7977ae2a593

FROM node:20-alpine AS build
ARG EXCALIDRAW_ROOM_REF
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q \
 && git remote add origin https://github.com/excalidraw/excalidraw-room.git \
 && git fetch --depth 1 origin "$EXCALIDRAW_ROOM_REF" \
 && git checkout -q FETCH_HEAD
RUN yarn install --frozen-lockfile \
 && yarn build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /src /app
ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80
CMD ["yarn", "start"]
