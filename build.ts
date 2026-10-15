import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["src/server/main.ts"],
  outdir: "dist",
  target: "bun",
  external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"],
  plugins: [tailwind],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`build ok: ${result.outputs.length} files in dist/`);
