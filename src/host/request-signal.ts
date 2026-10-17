import type { IncomingMessage } from "node:http";
/** A direct operator request owns its work until a result is returned or the transport disconnects. */
export function requestSignal(req: IncomingMessage) {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new Error("Application API client disconnected"));
  req.once("aborted", abort);
  req.socket.once("close", abort);
  if (req.aborted || req.socket.destroyed) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener("aborted", abort);
      req.socket.removeListener("close", abort);
    },
  };
}
