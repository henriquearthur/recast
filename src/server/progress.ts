export interface DownloadProgress {
  percent: number;
  /** Bytes per second; null when yt-dlp did not report it. */
  speed: number | null;
  /** Seconds left; null when unknown. */
  eta: number | null;
}

/** The yt-dlp `--progress-template` that `parseProgressLine` understands. */
export const PROGRESS_TEMPLATE =
  "download:RECAST_PROGRESS %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress._percent_str)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s";

const num = (v: string | undefined) => {
  const n = v === undefined || v === "NA" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Reads one `RECAST_PROGRESS` line; null for any other line or one without a usable total. */
export function parseProgressLine(line: string): DownloadProgress | null {
  if (!line.startsWith("RECAST_PROGRESS ")) return null;
  const [status, downloaded, total, estimate, , speed, eta] = line.slice("RECAST_PROGRESS ".length).trim().split("|");
  const done = num(downloaded);
  const size = num(total) ?? num(estimate);
  if (done === null || !size) return null;
  return {
    percent: status === "finished" ? 100 : Math.min(100, (done / size) * 100),
    speed: num(speed),
    eta: num(eta),
  };
}

const ptNumber = (n: number) => n.toFixed(1).replace(".", ",");

/** Speed and time left as shown next to the percentage; undefined when there is nothing to show. */
export function formatProgress({ speed, eta }: DownloadProgress): string | undefined {
  const parts: string[] = [];
  if (speed !== null)
    parts.push(speed >= 1024 * 1024 ? `${ptNumber(speed / 1024 / 1024)} MiB/s` : `${ptNumber(speed / 1024)} KiB/s`);
  if (eta !== null) parts.push(`faltam ${Math.floor(eta / 60)}:${String(Math.floor(eta % 60)).padStart(2, "0")}`);
  return parts.length ? parts.join(" · ") : undefined;
}
