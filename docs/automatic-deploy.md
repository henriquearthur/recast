# Deploy main automatically

Automatic deployment is optional, for a host that should follow a branch you control, such as your fork's `main`. It uses a systemd user timer that fetches `origin/main` every two minutes after the previous check finishes. No inbound webhook, GitHub Actions runner, or deployment secret is required. Git must be able to fetch the repository unattended as the service user.

## Install and verify

First [install the application service](service.md#install) and verify that `/api/health` reports `"ok": true`. Install Git, curl, tar, and flock (from util-linux), alongside Bun and systemd. From a clean permanent `main` checkout containing these scripts:

```sh
git pull --ff-only
bash deploy/install-auto-update.sh
systemctl --user status recast recast-update.timer
systemctl --user list-timers recast-update.timer
```

The installer takes a snapshot of the checkout's committed code as the initial release. It preserves the existing service's executable, credentials, and data directory, and adds a `WorkingDirectory` override pointing to the active release. It records Bun's and Node's directories from the installer's `PATH`, followed by `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, and `/bin`, for both the application and the updater. Node 22 or later must be installed as described in the README, including when it lives under nvm. Configure absolute tool paths in the application environment file for other locations. It restarts Recast and enables the timer only after a successful health check. If startup fails, it restores the previous service configuration and restarts it.

The installer requires user lingering to already be enabled by `deploy/install.sh`. Rerun the automatic deployment installer from the permanent checkout to update the installed publisher and units when deployment scripts change. It never publishes uncommitted checkout files.

## What happens after a push

Each check fetches `main` into a dedicated bare clone. If its commit differs from the active release, the publisher extracts the committed files into a new directory, installs dependencies with the frozen lockfile, and runs the build. Type checking and tests are not part of deployment; run them before merging. The running release remains untouched throughout preparation.

After the build, the publisher atomically switches the `active` symlink and restarts `recast.service`. It checks `/api/health` up to 15 times, requiring both HTTP success and JSON `"ok": true`. If startup fails, it restores the previous release and restarts it. Check logs if recovery itself fails. Deployment briefly interrupts the server; arrange pushes around long-running processing jobs.

Build or startup failures record a rejected commit. That commit is skipped until a different commit is pushed or you retry it explicitly. Fetch and dependency retrieval failures are retried on the next timer tick. Concurrent checks share a lock. An unchanged commit does not restart the application; normal process recovery remains the application's systemd service responsibility.

Rollback restores application code and dependencies. It does not restore the SQLite database or reverse migrations; releases must remain compatible with the existing data. Data, models, and credentials stay in their [configured locations](../deploy/recast.env.example) outside the releases.

## Inspect or retry

```sh
journalctl --user -u recast-update --since today
systemctl --user start recast-update.service  # Check now.
cat ~/.local/share/recast/deploy/active/.recast-commit
readlink -f ~/.local/share/recast/deploy/previous
# Retry a rejected commit, loading the same environment and PATH as the timer:
systemctl --user stop recast-update.timer
systemd-run --user --wait --pipe --collect \
  -p "EnvironmentFile=$HOME/.config/recast/recast.env" \
  -p "Environment=PATH=$(dirname "$(command -v bun)"):$(dirname "$(command -v node)"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  /bin/bash "$HOME/.local/libexec/recast/update.sh" --retry-rejected
systemctl --user start recast-update.timer
```

The updater reads `RECAST_PORT` from `~/.config/recast/recast.env` (default 4280); set `RECAST_HEALTH_URL` there to override the health endpoint. The dedicated clone, release directories, active/previous symlinks, and rejection marker live in `~/.local/share/recast/deploy`. All prepared releases are retained for inspection; monitor disk usage. Never edit release directories. The stable publisher is installed in `~/.local/libexec/recast/update.sh`, and the units in `~/.config/systemd/user`.

## Pause or return to manual deployment

To pause automatic deployment while keeping the current release running:

```sh
systemctl --user disable --now recast-update.timer
systemctl --user stop recast-update.service
```

Before returning to a permanent checkout, ensure its committed version is suitable for the current database. Remove only the deployment override, then rerun the regular installer from that checkout:

```sh
rm ~/.config/systemd/user/recast.service.d/auto-update.conf
sh deploy/install.sh
```

Keep the release and data directories for recovery. See [service operations](service.md) for application logs and network access.
