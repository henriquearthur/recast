#!/bin/sh
# Downloads the Whisper model on first start, then runs Recast.
set -eu
mkdir -p "$HOME" "$(dirname "$WHISPER_MODEL")"
if [ ! -f "$WHISPER_MODEL" ]; then
  url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$(basename "$WHISPER_MODEL")"
  echo "Downloading the Whisper model from $url (first start only)..."
  curl -fL --retry 3 -o "$WHISPER_MODEL.part" "$url"
  mv "$WHISPER_MODEL.part" "$WHISPER_MODEL"
fi
exec "$@"
