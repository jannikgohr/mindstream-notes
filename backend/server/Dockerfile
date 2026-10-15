# Mindstream server.
#
# Built from the repository root, because the manifest names the client
# library in vendor/ that the tests use:
#
#   docker build -t mindstream-server -f backend/server/Dockerfile .
#
# What reaches the build is listed in Dockerfile.dockerignore next to this
# file.

FROM rust:1-slim-bookworm@sha256:2c3a22f0a5533ea2dd5a16627bc841228151faa2d4de2644ac9987e4a2f1f2fa AS build
WORKDIR /src/backend/server
# Only the tests compile the client library, but cargo reads its manifest to
# resolve the lockfile.
COPY vendor/etebase-rs /src/vendor/etebase-rs
COPY backend/server/Cargo.toml backend/server/Cargo.lock ./
COPY backend/server/migrations ./migrations
COPY backend/server/src ./src
RUN cargo build --release --locked --bin mindstream-server

# Pinned by digest so a rebuild builds what was reviewed. Refresh the pins
# when the base images move, and rebuild for their security updates.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN useradd --system --uid 10001 --no-create-home mindstream \
 && mkdir -p /data/blobs \
 && chown -R mindstream /data
COPY --from=build /src/backend/server/target/release/mindstream-server /usr/local/bin/mindstream-server
USER mindstream
ENV MINDSTREAM_LISTEN=0.0.0.0:3735
ENV MINDSTREAM_BLOB_DIR=/data/blobs
# glibc keeps a separate heap per thread and is slow to hand freed memory back.
# Two arenas keep a server that has just moved a large attachment from holding
# on to several times its size.
ENV MALLOC_ARENA_MAX=2
VOLUME /data
EXPOSE 3735
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["mindstream-server", "healthcheck"]
ENTRYPOINT ["mindstream-server"]
