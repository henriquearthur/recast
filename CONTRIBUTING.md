# Contributing to Recast

Read the [README](README.md#development) for setup and the [glossary](GLOSSARY.md) for domain vocabulary. Use `bun run demo` to work on the interface without external services or credentials.

Write code, documentation, agent instructions, code comments, issues, and pull requests in English. Keep paths and examples portable across machines: nothing in the repository should depend on a particular host, network, or user. The interface supports English and Brazilian Portuguese; Articles are written in the Article language chosen in Settings (English by default).

## Propose a change

Use GitHub Issues for bugs and feature discussions. Describe the observed behavior, expected behavior, and steps to reproduce a bug. Create issues only when needed for your contribution.

Keep changes focused. Before opening a pull request, run:

```sh
bun run test
bun run typecheck
bun run build
```

Describe the problem, resulting behavior, and verification in the pull request. Use a Conventional Commit title, such as `fix: preserve articles after delivery failures`.

Keep credentials, personal paths, browser cookies, and runtime data outside commits.

## Website

The project website is a static page in `site/`, published to GitHub Pages by `.github/workflows/pages.yml` when it changes on `main`. It reuses the README screenshot, copied from `docs/images/recast.webp` at deploy time. To preview it, copy that image into `site/` and serve the folder, for example with `python3 -m http.server --directory site`.

## Interface translations

Write interface copy and application-owned API diagnostics in English, through `t()` from `src/web/lib/i18n.ts` in the interface. English source messages are the English catalog; add the Brazilian Portuguese translation to `src/locales/pt-BR.json`, which the interface and e-mails share. Use numbered placeholders (`{0}`, `{1}`) for values, keeping the same placeholders in each language. External diagnostics retain their original text.

Format dates and numbers with the selected locale through `src/web/lib/format.ts`. Keep user content, article output, and transcripts in their original language. Verify both languages and mobile layouts when changing interface copy.
