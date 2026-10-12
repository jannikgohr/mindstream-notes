# Mindstream server.
#
# Built from this directory alone, so the image does not depend on the rest
# of the repository:
#
#   docker build -t mindstream-server backend/server

FROM rust:1-slim-bookworm AS build
WORKDIR /src
# The lockfile names the client library the tests use, a git dependency, so
# cargo needs git to resolve it even though the release build never compiles
# it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release --locked --bin mindstream-server

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home mindstream \
 && mkdir -p /data/blobs \
 && chown -R mindstream /data
COPY --from=build /src/target/release/mindstream-server /usr/local/bin/mindstream-server
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
