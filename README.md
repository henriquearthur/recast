# Recast

Turn YouTube videos into articles you can read instead of watch.

Recast follows the YouTube channels you choose. When one of them publishes a video, Recast downloads the audio, transcribes it on your own machine with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), has an AI model write an article from the transcript, and sends it to your inbox. You can also paste any video link by hand.

It is self-hosted and single-user: a small Bun server with a web interface and a SQLite database, running on your computer or home server.

- **Follow channels** and get every new video as an article. Shorts, livestreams, and members-only videos are skipped.
- **Read in the browser or by e-mail**, with a summary up front and sections linked to the moment of the video they cover.
- **Write in any language.** Articles use the language you pick in Settings, whatever the language of the video.
- **Bring your own AI provider:** GitHub Copilot, Claude (your own Claude subscription or an Anthropic API key), or OpenAI through Codex, with models from each provider's online catalog.
- **Shape the articles** with a global prompt and optional instructions per channel.
- **Track usage and estimated cost** per provider, model, and channel.
- **Use the interface in English or Brazilian Portuguese.**

## How it works

```
YouTube ──▶ Download ──▶ Transcription ──▶ Article ──▶ Delivery
            (yt-dlp)     (whisper.cpp,     (Copilot,    (e-mail)
                          on your machine)  Claude or
                                            Codex)
```

Each video goes through these four stages in order. Failed stages are retried automatically, and you can follow progress live, retry, cancel, or regenerate an article from the interface.

## What you need

- A machine that stays on, running Linux or macOS. Transcription runs locally on the CPU, or on the GPU with a whisper.cpp build that supports it.
- An account with one AI provider:
  - **GitHub Copilot**: a subscription and a GitHub token with Copilot access.
  - **Claude**: your own Claude Pro, Max, Team or Enterprise subscription, or an [Anthropic API key](https://platform.claude.com/).
  - **Codex**: a ChatGPT plan that includes Codex, or an OpenAI API key.
- For e-mail delivery, a Gmail account with an [app password](https://support.google.com/accounts/answer/185833), or any other SMTP server. E-mail is optional; articles are always readable in the browser.

## Quick start with Docker

The Docker image includes every tool Recast needs. You only need [Docker](https://docs.docker.com/get-started/get-docker/) with Compose.

```sh
git clone https://github.com/henriquearthur/recast.git
cd recast
cp deploy/recast.env.example .env
```

Edit `.env`: set the credentials of your AI provider and, for e-mail, `RECAST_SMTP_USER` and `RECAST_SMTP_PASSWORD`. Then start Recast:

```sh
docker compose up -d
docker compose logs -f   # The first start downloads the Whisper model (about 1.6 GB).
```

Open <http://localhost:4280> and continue with [first steps](#first-steps).

Data (database, audio, transcription model, provider logins) lives in the `recast-data` volume. To use a different Whisper model, set `WHISPER_MODEL=/data/models/ggml-<name>.bin` in `.env`, for example `ggml-small.bin` on a slower machine; the model is downloaded on the next start. To update, run `git pull` and `docker compose up -d --build`.

## Install without Docker

Install these tools first:

| Tool | Notes |
| --- | --- |
| [Bun](https://bun.sh) | Runs Recast. |
| [Node.js](https://nodejs.org/) 22+ | Used by yt-dlp to solve YouTube challenges, and by the provider runtimes. |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) | With its default extras, e.g. `pipx install "yt-dlp[default]"`. |
| [FFmpeg](https://ffmpeg.org/download.html) | Converts the audio for transcription. |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp#quick-start) | Provides `whisper-cli`; on macOS, `brew install whisper-cpp`. |
| [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) | Only for the Copilot provider. |

Then clone Recast, download a Whisper model, and create the configuration file outside the repository:

```sh
git clone https://github.com/henriquearthur/recast.git
cd recast
bun install --frozen-lockfile

mkdir -p ~/.local/share/recast/models
curl -L -o ~/.local/share/recast/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin

mkdir -p ~/.config/recast
install -m 600 deploy/recast.env.example ~/.config/recast/recast.env
```

Edit `~/.config/recast/recast.env` with your provider credentials and e-mail settings, and set the tool paths for any tool that is not on your `PATH`. Then start Recast:

```sh
bun --env-file="$HOME/.config/recast/recast.env" run start
```

Open <http://localhost:4280> and continue with [first steps](#first-steps).

To keep Recast running in the background on Linux, stop the foreground process and install the systemd user service: `sh deploy/install.sh`. It starts at boot and restarts on failure; see [service operations](docs/service.md) for logs and updates. On macOS, run it under a process manager of your choice.

## First steps

1. Open **Settings**, pick the AI provider and model, and set the e-mail recipient.
2. Set the **Article language**, such as `en`, `pt-BR`, or `es`.
3. Paste a YouTube video link on the home page, or follow a channel in **Channels**.

If something is missing, such as a tool, the transcription model, provider authentication, or e-mail credentials, a red banner tells you what to fix. The same check is available at <http://localhost:4280/api/health>.

## Configuration

Recast reads its configuration from environment variables: `~/.config/recast/recast.env` for the systemd service, or `.env` with Docker. [deploy/recast.env.example](deploy/recast.env.example) documents every variable. The most common ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RECAST_BASE_URL` | `http://localhost:4280` | Address used in e-mail links. |
| `RECAST_HOST` | `127.0.0.1` | Interface to listen on. Use `0.0.0.0` to accept other devices. |
| `RECAST_PORT` | `4280` | Port to listen on. |
| `RECAST_DATA_DIR` | `~/.local/share/recast` | Database, audio, and logs. |
| `RECAST_SMTP_USER`, `RECAST_SMTP_PASSWORD` | | E-mail account (sender) and password for delivery. |
| `RECAST_SMTP_HOST`, `RECAST_SMTP_PORT` | `smtp.gmail.com`, `465` | SMTP server, for providers other than Gmail. |
| `COPILOT_GITHUB_TOKEN` | gh login | Copilot authentication. |
| `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | claude login | Claude authentication: an API key, or your own subscription. |
| `CODEX_API_KEY`, `OPENAI_API_KEY` | codex login | Codex authentication. |
| `WHISPER_CLI_PATH`, `WHISPER_MODEL` | `whisper-cli`, `~/.local/share/recast/models/ggml-large-v3-turbo.bin` | Transcription. |

Everything about the articles themselves (provider, model, language, recipient, prompt) is set in the interface. See [article generation](docs/generation.md) for provider authentication, model catalogs, and cost estimates.

## Access from other devices

Recast has no authentication, so by default it only accepts connections from the machine it runs on. To read articles from your phone or another computer, keep Recast on a trusted private network, such as your home network, a VPN, or a [Tailscale](https://tailscale.com/) tailnet, and:

- without Docker, set `RECAST_HOST=0.0.0.0`;
- with Docker, change the port in `compose.yaml` from `"127.0.0.1:4280:4280"` to `"4280:4280"`.

Set `RECAST_BASE_URL` to the address you use, such as `http://my-server.example-tailnet.ts.net:4280`, so links in e-mails work. Never expose Recast directly to the internet.

## Troubleshooting

- **YouTube asks to "confirm you're not a bot" or returns HTTP 429/403.** YouTube rate-limits some networks, especially VPN and datacenter addresses. Try again later or from another network. If your host uses a VPN, see [YouTube access through a VPN](docs/service.md#youtube-access-through-a-vpn).
- **Transcription is slow.** Use a smaller Whisper model, such as `ggml-small.bin`, or a whisper.cpp build with GPU support.
- **A provider shows as not authenticated.** Check its credentials in [article generation](docs/generation.md) and restart Recast.

## Development

```sh
bun install --frozen-lockfile
bun run demo        # The interface over sample data, without external tools or credentials.
bun run test
bun run typecheck
bun run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, the [glossary](GLOSSARY.md) for the domain vocabulary, or [open an issue](https://github.com/henriquearthur/recast/issues) to report a bug or suggest a feature.

## License

[MIT](LICENSE)
