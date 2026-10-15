export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, i).replace(/\r$/, "");
      buffer = buffer.slice(i + 1);
    }
  }
  if (buffer) yield buffer;
}

/** Runs a program (no shell), feeding each output line to the callbacks; kills it when `signal` aborts. Returns the exit code. */
export async function runProcess(
  bin: string,
  args: string[],
  signal: AbortSignal | undefined,
  onOut: (line: string) => void,
  onErr: (line: string) => void,
): Promise<number> {
  if (signal?.aborted) throw new Error("cancelled");
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const kill = () => proc.kill();
  signal?.addEventListener("abort", kill);
  try {
    const consume = async (stream: ReadableStream<Uint8Array>, on: (l: string) => void) => {
      for await (const line of lines(stream)) on(line);
    };
    await Promise.all([consume(proc.stdout, onOut), consume(proc.stderr, onErr)]);
    const code = await proc.exited;
    if (signal?.aborted) throw new Error("cancelled");
    return code;
  } finally {
    signal?.removeEventListener("abort", kill);
  }
}
