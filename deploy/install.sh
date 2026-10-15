#!/bin/sh
# Installs (or updates) the Recast user service. Run from the permanent checkout: sh deploy/install.sh
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
bun_path=$(command -v bun)
unit_dir="$HOME/.config/systemd/user"
env_dir="$HOME/.config/recast"

mkdir -p "$unit_dir" "$env_dir"
if [ ! -f "$env_dir/recast.env" ]; then
  install -m 600 "$repo/deploy/recast.env.example" "$env_dir/recast.env"
  echo "Created $env_dir/recast.env: fill in credentials and run: systemctl --user restart recast"
fi
(cd "$repo" && bun install --frozen-lockfile)
# Quote systemd strings and escape specifiers in installation paths.
RECAST_INSTALL_REPO="$repo" RECAST_INSTALL_BUN="$bun_path" "$bun_path" -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const { dirname, join } = require("node:path");
  const quote = (s) => s.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%");
  const repo = process.env.RECAST_INSTALL_REPO;
  const bun = process.env.RECAST_INSTALL_BUN;
  const unit = readFileSync(join(repo, "deploy/recast.service"), "utf8")
    .replaceAll("@RECAST_CHECKOUT@", () => repo.replaceAll("%", "%%"))
    .replaceAll("@BUN_DIRECTORY@", () => quote(dirname(bun)))
    .replaceAll("@BUN_EXECUTABLE@", () => quote(bun));
  writeFileSync(join(process.env.HOME, ".config/systemd/user/recast.service"), unit, { mode: 0o644 });
'
systemctl --user daemon-reload
loginctl enable-linger "$(id -un)"
[ "$(loginctl show-user "$(id -un)" -p Linger --value)" = yes ] || {
  echo "Could not enable lingering; the service needs it to start without a login session." >&2
  exit 1
}
systemctl --user enable recast.service
systemctl --user restart recast.service
systemctl --user --no-pager status recast.service | head -5
