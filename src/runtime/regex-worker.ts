import { parentPort, workerData } from "node:worker_threads";

const input = workerData as { pattern: string; ignoreCase: boolean };
const pattern = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
parentPort!.on("message", (request: { lines: string[]; limit: number }) => {
  const matches: number[] = [];
  for (
    let i = 0;
    i < request.lines.length && matches.length < request.limit;
    i++
  )
    if (pattern.test(request.lines[i].slice(0, 4000))) matches.push(i);
  parentPort!.postMessage(matches);
});
