# Native WebKit/GTK checks run in a disposable Linux container. Mount the source
# read-only, copy it to /work, and retain logs before removing the container.
FROM rust:1.97.1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libssl-dev libdbus-1-dev libsecret-1-dev libkeyutils-dev \
    dbus-x11 xvfb xauth openbox gnome-keyring python3 \
    && rm -rf /var/lib/apt/lists/*
ENV LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
# WebKit's nested process sandbox cannot run as root in this test container.
ENV WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
WORKDIR /work
RUN apt-get update && apt-get install -y --no-install-recommends weston \
    && rm -rf /var/lib/apt/lists/*
