# Recast with every runtime dependency: Bun, Node.js, yt-dlp, FFmpeg, whisper.cpp and the Copilot CLI.
# The Whisper model is downloaded into the data volume on first start (see docker/entrypoint.sh).

FROM debian:bookworm-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.9.5
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_CPP_VERSION" https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build /build --config Release -j "$(nproc)" --target whisper-cli

FROM oven/bun:1.3.14-debian AS bun

FROM node:22-bookworm-slim
ARG COPILOT_CLI_VERSION=1.0.98
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates python3 python3-venv libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/yt-dlp && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]" \
 && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
 && npm install -g "@github/copilot@$COPILOT_CLI_VERSION" && npm cache clean --force
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY . .

ENV RECAST_HOST=0.0.0.0 \
    RECAST_PORT=4280 \
    RECAST_DATA_DIR=/data \
    WHISPER_MODEL=/data/models/ggml-large-v3-turbo.bin \
    COPILOT_CLI_PATH=/usr/local/bin/copilot \
    HOME=/data/home
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4280
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["bun", "src/server/main.ts"]
