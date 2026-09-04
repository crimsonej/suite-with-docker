FROM node:20-alpine

WORKDIR /app

# Install system dependencies: FFmpeg, Python3, ca-certificates, tzdata, curl, bash
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    ca-certificates \
    tzdata \
    curl \
    bash \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --legacy-peer-deps --ignore-scripts

COPY . .

RUN chmod +x setup.sh installer.js && node installer.js

# Declare volumes for persistent authentication and settings
VOLUME ["/app/session_auth", "/app/media"]

ENV NODE_ENV=production
ENV DNS_SERVERS=8.8.8.8,8.8.4.4,1.1.1.1,1.0.0.1

CMD ["npm", "start"]