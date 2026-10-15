# Operate the service

This guide runs Recast as a systemd user service on Linux, from a permanent checkout. For containers, see [Docker](../README.md#quick-start-with-docker). It starts at boot without an active login session (the installer enables and verifies user *lingering*) and restarts automatically if the process fails.

To prepare a new machine, install tools, and configure your own credentials, first follow the [README](../README.md#installation). The installer renders [deploy/recast.service](../deploy/recast.service) with the checkout's absolute path and the Bun executable found on `PATH`. Run the installer again if either location changes.

## Install

From your permanent checkout:

```sh
sh deploy/install.sh
$EDITOR ~/.config/recast/recast.env      # First installation: fill in credentials.
systemctl --user restart recast
```

The script installs the rendered unit in `~/.config/systemd/user/`, creates `~/.config/recast/recast.env` (mode 600, outside the repository) from `deploy/recast.env.example` if absent, enables and verifies *lingering*, and enables and starts the service. The default model is `~/.local/share/recast/models/ggml-large-v3-turbo.bin`; set `WHISPER_MODEL` to use a model elsewhere. Optional variables are documented in the example; keep secret values outside the repository.

The service's tool search path includes Bun's directory, `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, and `/bin`. Configure absolute tool paths in the environment file when your installation uses other locations.

Copilot authentication uses the service user's `gh` login (`~/.config/gh/hosts.yml`) by default. Set `COPILOT_GITHUB_TOKEN` in the environment file for explicit authentication.

## Access

Recast listens on `127.0.0.1:4280` by default, so only the machine itself can reach it at `http://localhost:4280`. The interface and API have no authentication. To reach Recast from other devices, set `RECAST_HOST=0.0.0.0` and restrict access to a trusted private network, such as a VPN or a tailnet; for example, with Tailscale, `http://<machine-name>.<tailnet>.ts.net:4280` (find the name with `tailscale status`). Set `RECAST_BASE_URL` to the address you use, so links in e-mails open Recast. `RECAST_PORT` changes the port.

## Update

To deploy pushes to `main` automatically, follow [automatic deployment](automatic-deploy.md). The timer prepares isolated releases and recovers the previous one if startup fails.

For a manual installation without automatic deployment, use the same permanent checkout:

```sh
git pull
sh deploy/install.sh     # Installs dependencies, updates the unit, and restarts.
```

## Logs

```sh
journalctl --user -u recast -f              # Follow live logs.
journalctl --user -u recast --since today
systemctl --user status recast
```

## YouTube access through a VPN

If the VPN blocks YouTube or its IPv6 connections time out, configure `RECAST_YOUTUBE_SOURCE_ADDRESS` in `~/.config/recast/recast.env` with the machine's local IPv4 address. Install curl and first ensure the host has a source-based routing rule that sends connections from that address through the LAN gateway, outside the VPN. This setting binds both RSS reads and every yt-dlp operation (channel resolution, metadata, audio) to the same address. A yt-dlp `--source-address` configuration alone does not affect RSS reads.

Before restarting the service, verify the route with a real channel ID:

```sh
curl --ipv4 --interface <local-ipv4> --fail --max-time 15 \
  'https://www.youtube.com/feeds/videos.xml?channel_id=<channel-id>'
systemctl --user restart recast
```

RSS uses curl when this setting is enabled, and the normal Bun fetch otherwise. The existing 60-second check timeout cancels curl too; HTTP and network failures remain visible on the channel. After restarting, wait for the next scheduled channel check (up to 15 minutes) to clear the previous error. Update the configured address and the host routing rule if the machine's LAN address changes.

## Missing dependencies

The interface displays a red warning when the audio downloader (yt-dlp), converter (ffmpeg), transcriber (whisper-cli), transcription model, Copilot authentication, or email credentials are missing. The same information is available at `GET /api/health`. The check calls no model and sends no email.
