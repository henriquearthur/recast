#!/usr/bin/env bash
# Run from a clean, permanent main checkout after installing recast.service.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
state=${RECAST_DEPLOY_DIR:-"$HOME/.local/share/recast/deploy"}
units="$HOME/.config/systemd/user"
publisher="$HOME/.local/libexec/recast/update.sh"
bun_path=$(command -v bun)
node_path=$(command -v node)
for tool in git curl tar flock systemctl loginctl; do command -v "$tool" >/dev/null; done
[[ $(git -C "$repo" branch --show-current) == main && -z $(git -C "$repo" status --porcelain) ]] || {
  echo "Use a clean permanent main checkout, not a development worktree." >&2; exit 1;
}
systemctl --user is-active --quiet recast.service
[[ $(loginctl show-user "$(id -un)" -p Linger --value) == yes ]] || {
  echo "Run deploy/install.sh first to enable lingering." >&2; exit 1;
}
# Prevent an existing updater from publishing while its installation changes.
mkdir -p "$state/releases" "$(dirname "$publisher")" "$units/recast.service.d"
exec 9>"$state/update.lock"
flock -n 9 || { echo "A deployment is running; try again later." >&2; exit 1; }
[[ ! -e $units/recast.service.d/auto-update.conf || -L $state/active ]] || {
  echo "Existing automatic deployment has no active release; inspect it first." >&2; exit 1;
}
if [[ ! -d $state/repository.git ]]; then
  git clone --bare "$(git -C "$repo" remote get-url origin)" "$state/repository.git"
fi
if [[ ! -L $state/active ]]; then
  initial=$(mktemp -d "$state/releases/bootstrap.XXXXXX")
  git -C "$repo" archive HEAD | tar -x -C "$initial"
  (cd "$initial" && bun install --frozen-lockfile && bun run build)
  git -C "$repo" rev-parse HEAD >"$initial/.recast-commit"
  ln -s "$initial" "$state/active"
fi
install -m 755 "$repo/deploy/update.sh" "$publisher"
backup=$(mktemp "$state/override.XXXXXX")
had_override=false
if [[ -f $units/recast.service.d/auto-update.conf ]]; then
  cp "$units/recast.service.d/auto-update.conf" "$backup"
  had_override=true
fi
# JavaScript template expressions must reach Bun without shell expansion.
# shellcheck disable=SC2016
RECAST_INSTALL_REPO="$repo" RECAST_INSTALL_STATE="$state" RECAST_INSTALL_BUN="$bun_path" RECAST_INSTALL_NODE="$node_path" RECAST_INSTALL_PUBLISHER="$publisher" "$bun_path" -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const { dirname, join } = require("node:path");
  const quote = s => s.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%");
  const home = process.env.HOME;
  const units = join(home, ".config/systemd/user");
  const repo = process.env.RECAST_INSTALL_REPO;
  const path = `${dirname(process.env.RECAST_INSTALL_BUN)}:${dirname(process.env.RECAST_INSTALL_NODE)}:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`;
  const unit = readFileSync(join(repo, "deploy/recast-update.service"), "utf8")
    .replaceAll("@TOOL_PATH@", () => quote(path))
    .replaceAll("@DEPLOY_DIR@", () => quote(process.env.RECAST_INSTALL_STATE))
    .replaceAll("@PUBLISHER@", () => quote(process.env.RECAST_INSTALL_PUBLISHER));
  writeFileSync(join(units, "recast-update.service"), unit);
  writeFileSync(join(units, "recast-update.timer"), readFileSync(join(repo, "deploy/recast-update.timer")));
  writeFileSync(join(units, "recast.service.d/auto-update.conf"),
    `[Service]\nWorkingDirectory=${join(process.env.RECAST_INSTALL_STATE, "active").replaceAll("%", "%%")}\nEnvironment="PATH=${quote(path)}"\n`);
'
systemctl --user daemon-reload
env_args=()
if [[ -f $HOME/.config/recast/recast.env ]]; then
  env_args=(--env-file="$HOME/.config/recast/recast.env")
fi
# shellcheck disable=SC2016
health_url=$("$bun_path" "${env_args[@]}" -e 'console.log(process.env.RECAST_HEALTH_URL ?? `http://127.0.0.1:${process.env.RECAST_PORT ?? 4280}/api/health`)')
healthy() {
  local attempt
  for ((attempt = 1; attempt <= 15; attempt++)); do
    if curl -fsS --max-time 5 "$health_url" |
      "$bun_path" -e 'try { process.exit((await Bun.stdin.json()).ok === true ? 0 : 1); } catch { process.exit(1); }'; then
      return 0
    fi
    sleep 1
  done
  return 1
}
if ! { systemctl --user restart recast.service 9>&- && healthy; }; then
  if [[ $had_override == true ]]; then
    cp "$backup" "$units/recast.service.d/auto-update.conf"
  else
    rm -f "$units/recast.service.d/auto-update.conf"
  fi
  systemctl --user daemon-reload
  systemctl --user restart recast.service 9>&- || true
  rm -f "$backup"
  echo "Startup failed; restored the previous service configuration." >&2; exit 1
fi
rm -f "$backup"
systemctl --user enable --now recast-update.timer
systemctl --user --no-pager status recast.service recast-update.timer
