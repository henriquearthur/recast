import type { Stage, VideoView } from "../server/pipeline";

/** Source message keys for stage labels, statuses, and video states; translate when rendering. */
export const STAGE_LABEL: Record<string, string> = { download: "Download", transcription: "Transcription", article: "Article", delivery: "Delivery" };
export const STATUS_LABEL: Record<string, string> = { waiting: "Waiting", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" };
export const VIDEO_STATE_LABEL: Record<VideoView["state"], string> = {
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
export const STAGE_ORDER: Stage[] = ["download", "transcription", "article", "delivery"];
/** The color that identifies a Stage in every chart. */
export const STAGE_COLOR: Record<string, string> = {
  download: "var(--stage-download)",
  transcription: "var(--stage-transcription)",
  article: "var(--stage-article)",
  delivery: "var(--stage-delivery)",
};
