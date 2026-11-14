FROM node:20-bookworm-slim

# yt-dlp needs frequent updates to keep working with YouTube, so the default
# tracks the latest release. For reproducible builds pin it, e.g.
#   docker build --build-arg YT_DLP_VERSION=2025.10.22 .
ARG YT_DLP_VERSION=latest

WORKDIR /app

# System dependencies: FFmpeg, Python3 (yt-dlp runtime), ca-certificates, tzdata, curl, bash
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        ca-certificates \
        tzdata \
        curl \
        bash \
    && rm -rf /var/lib/apt/lists/*

# Download yt-dlp and verify it against the release's published SHA-256 list.
RUN set -eu; \
    if [ "$YT_DLP_VERSION" = "latest" ]; then base="https://github.com/yt-dlp/yt-dlp/releases/latest/download"; \
    else base="https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}"; fi; \
    cd /tmp; \
    curl -fsSL "$base/yt-dlp" -o yt-dlp; \
    curl -fsSL "$base/SHA2-256SUMS" -o SHA2-256SUMS; \
    grep -E ' yt-dlp$' SHA2-256SUMS | sha256sum -c -; \
    install -m 0755 yt-dlp /usr/local/bin/yt-dlp; \
    rm -f yt-dlp SHA2-256SUMS

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --legacy-peer-deps --ignore-scripts

COPY . .

RUN chmod +x setup.sh installer.js docker-entrypoint.sh \
    && node installer.js \
    && chown -R node:node /app

ENV NODE_ENV=production
ENV DNS_SERVERS=8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1

# The entrypoint starts as root only to fix ownership of mounted volumes
# (Railway/Docker volumes are root-owned), then drops to the unprivileged
# `node` user before launching the bot.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
