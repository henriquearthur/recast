/** The text of whatever was thrown. */
export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
