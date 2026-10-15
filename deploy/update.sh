#!/usr/bin/env bash
# Publish origin/main from an isolated clone, never from a development checkout.
set -euo pipefail
state=${RECAST_DEPLOY_DIR:-"$HOME/.local/share/recast/deploy"}
health_url=${RECAST_HEALTH_URL:-"http://127.0.0.1:${RECAST_PORT:-4280}/api/health"}
retry=false
if [[ ${1:-} == --retry-rejected ]]; then retry=true; shift; fi
if (($#)); then echo "Usage: $0 [--retry-rejected]" >&2; exit 2; fi

mkdir -p "$state/releases"
exec 9>"$state/update.lock"
flock -n 9 || exit 0

healthy() {
  local attempt
  for ((attempt = 1; attempt <= 15; attempt++)); do
    if curl -fsS --max-time 5 "$health_url" |
      bun -e 'try { process.exit((await Bun.stdin.json()).ok === true ? 0 : 1); } catch { process.exit(1); }'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

activate() {
  ln -sfnT "$1" "$state/active.next"
  mv -Tf "$state/active.next" "$state/active"
  systemctl --user restart recast.service 9>&-
}

git --git-dir="$state/repository.git" fetch --quiet origin main
candidate=$(git --git-dir="$state/repository.git" rev-parse FETCH_HEAD)
old=$(readlink -f "$state/active")
[[ -d $old ]] || { echo "Install automatic deployment first." >&2; exit 1; }
if [[ $(cat "$old/.recast-commit") == "$candidate" ]]; then
  echo "Already deployed: $candidate"
  exit 0
fi
if [[ $retry == false && -f $state/rejected-commit && $(cat "$state/rejected-commit") == "$candidate" ]]; then
  echo "Previously rejected: $candidate (use --retry-rejected to try again)"
  exit 0
fi

staging=$(mktemp -d "$state/releases/.staging.XXXXXX")
trap 'rm -rf -- "$staging"; rm -f -- "$state/active.next"' EXIT
git --git-dir="$state/repository.git" archive "$candidate" | tar -x -C "$staging"
# Retrieval failures are retried on the next timer tick, without touching the service.
(cd "$staging" && bun install --frozen-lockfile)
if ! (cd "$staging" && bun run build); then
  printf '%s\n' "$candidate" >"$state/rejected-commit"
  echo "Build failed; active release preserved." >&2
  exit 1
fi
printf '%s\n' "$candidate" >"$staging/.recast-commit"
# A unique directory allows retrying a commit without changing a running release.
release="$state/releases/$candidate-$(basename "$staging")"
mv "$staging" "$release"
echo "Activating: $candidate"
if activate "$release" && healthy; then
  ln -sfnT "$old" "$state/previous.next"
  mv -Tf "$state/previous.next" "$state/previous"
  rm -f "$state/rejected-commit"
  echo "Deployed: $candidate"
  exit 0
fi

printf '%s\n' "$candidate" >"$state/rejected-commit"
echo "Startup failed; restoring $(cat "$old/.recast-commit")" >&2
if activate "$old" && healthy; then
  echo "Previous release recovered." >&2
else
  echo "Recovery failed; inspect journalctl --user -u recast." >&2
fi
exit 1
