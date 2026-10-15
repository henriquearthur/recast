# Configure article generation

Recast can write Articles through GitHub Copilot, the Claude Agent SDK, or the Codex SDK. Configure credentials as the operating-system user running the service; the browser selects a provider and model but never accepts secrets.

## Credentials

Keep environment settings in `~/.config/recast/recast.env` with mode `600` (or in `.env` next to `compose.yaml` with Docker), and restart Recast after changing them.

- **Copilot:** install the Copilot CLI and set `COPILOT_GITHUB_TOKEN`, or use the service user's existing GitHub authentication. `COPILOT_CLI_PATH` selects a different executable. The Docker image includes the CLI; set `COPILOT_GITHUB_TOKEN` there.
- **Claude:** generation runs through the Claude Agent SDK, which installs its runtime through optional dependencies; keep them enabled during installation. Choose one way to authenticate:
  - **API key:** set `ANTHROPIC_API_KEY` from the [Claude Console](https://platform.claude.com/). Usage is billed per token to the key's organization. A key takes precedence over a subscription.
  - **Your own Claude subscription** (Pro, Max, Team or Enterprise): leave `ANTHROPIC_API_KEY` empty, run `claude setup-token` with [Claude Code](https://code.claude.com/docs/en/setup) and set the token it prints as `CLAUDE_CODE_OAUTH_TOKEN`. Without Docker, signing in to Claude Code (`claude`, then `/login`) as the service user also works. Usage counts toward your plan's limits.

  Sign-in always completes in Anthropic's own flow: Recast never asks for, reads or stores your Claude login, and only lets the unmodified Claude Code runtime use the credential of the user running the service. Anthropic allows subscription credentials for ordinary, individual use only, so use your own subscription on your own Recast, never to generate Articles for other people; anything else needs an API key. See Anthropic's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) terms.
- **Codex:** the Codex SDK installs its runtime. Run `node_modules/.bin/codex login` from the checkout as the service user to reuse an eligible ChatGPT subscription. With Docker, run `docker compose exec recast node_modules/.bin/codex login --device-auth`; the login is kept in the data volume. Alternatively, supply `CODEX_API_KEY` or `OPENAI_API_KEY`; API keys take precedence over the existing login. `CODEX_HOME` selects the existing authentication directory; `CODEX_CLI_PATH` overrides the executable used by both generation and discovery.

Refer to the official [Claude authentication](https://code.claude.com/docs/en/authentication) and [Codex authentication](https://learn.chatgpt.com/docs/auth) documentation for account eligibility and login methods.

## Choose the provider and model

Open **Settings**. Each provider shows its configuration/authentication state and the status, time, model and error of its last real generation. Credential checks do not generate text or guarantee model access, quota, or future success. There is no generation test button.

Select a provider, choose a model from its online catalog, and save. **Article language** sets the language of every Article and e-mail as a BCP 47 code, such as `en`, `pt-BR`, or `es`, whatever the language of the video; installations from before this setting keep `pt-BR`. A separate model selection is retained for each provider. An unavailable provider can still be selected for later setup. Only the selected provider affects `/api/health` and the global warning.

Catalogs come from the provider, not a fixed list in Recast: Copilot runtime model discovery, Anthropic's Models API (or, with a Claude subscription, the models the Agent SDK runtime offers the signed-in account), and Codex runtime remote discovery (or the OpenAI Models API for API-key access). Codex's bundled fallback is excluded. Recast caches successful catalogs for six hours; **Refresh models** queries again. Codex can reuse its recently fetched remote cache for up to five minutes, preserving the original timestamp. On failure, the last successful catalog and its timestamp remain visible. Without a saved catalog, selection is disabled until discovery succeeds. An existing selection is preserved even if it disappears from a later catalog.

## Jobs and regeneration

The provider and model are captured when the Article stage starts, not when the Video is added. Automatic retries, manual retries and recovery after restart preserve that selection. Regenerating a completed Article uses the current global configuration and then sends the new Article by email. There is no per-video model override or automatic switch to another provider.

Generation uses a private working directory, with tools disabled/restricted, cancellation and a fifteen-minute deadline. Failed or cancelled attempts retain any reported consumption; missing telemetry remains unknown.

## Read usage and costs

The Article shows its successful generation's provider, model, tokens, estimated USD value and price source. The Costs page includes every recorded attempt, grouping by provider/model, time and Channel. Historical records remain associated with Copilot; changing configuration never rewrites past estimates.

- **Copilot:** reported AI credits are shown separately; USD is the credit-equivalent at US$0.01 per credit. It is not necessarily an additional charge to the subscription.
- **Claude:** estimated USD comes from the Agent SDK, including its reported cache usage. This is not an invoice. With a subscription, the same figure is an API equivalent, not an amount charged to the plan.
- **Codex:** when a positive reference price exists in [Models.dev](https://models.dev), Recast estimates an API-equivalent amount from reported input/output/cache tokens. Reference prices are cached for 24 hours. Unpublished/zero reference prices, missing usage, unavailable cache rates, and inputs above 200,000 tokens remain unavailable because base prices do not establish long-context tiers. This estimate is not the amount billed to a ChatGPT subscription.

Unavailable costs are not zero. Totals with missing amounts are explicitly partial; averages are unavailable when their total is incomplete. The application does not fetch invoices or subscription billing statements.
