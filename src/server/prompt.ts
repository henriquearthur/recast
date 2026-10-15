import { languageName } from "../i18n";

/**
 * Prompt assembly belongs to Recast, not to the article writer adapter.
 * The Global Prompt comes first, then the Article language; Channel Instructions, when present, complement them.
 */
export function assembleInstructions(globalPrompt: string, language: string, channelInstructions?: string | null): string {
  const parts = [globalPrompt.trim(), `Write the article in ${languageName(language)} (${language}), whatever the language of the transcript.`];
  const extra = channelInstructions?.trim();
  if (extra) parts.push(`Instructions specific to this channel:\n${extra}`);
  return parts.join("\n\n");
}
