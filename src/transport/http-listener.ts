import type { AddressInfo, ListenOptions, Server, Socket } from "node:net";

// Source: WHATWG Fetch §2.9, https://fetch.spec.whatwg.org/#port-blocking
// These ports can be allocated by the OS, but browsers and Node fetch reject HTTP to them.
const blockedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
  137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
  532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);
const maxAttempts = 32;

function bind(server: Server, options: ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(options);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** Only OS-assigned ports are reselected; explicit ports retain their original semantics. */
export async function listenHttp(
  server: Server,
  options: { host: string; port: number },
): Promise<AddressInfo> {
  const sockets = new Set<Socket>();
  function forget(this: Socket): void {
    sockets.delete(this);
  }
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", forget);
  };
  const closeRejected = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  };
  server.on("connection", track);
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await bind(server, options);
      const address = server.address();
      if (!address || typeof address === "string") {
        await closeRejected();
        throw new Error("HTTP listener did not expose a TCP address");
      }
      if (options.port !== 0 || !blockedPorts.has(address.port)) return address;
      await closeRejected();
    }
    throw new Error(
      `Could not allocate an HTTP port accepted by fetch after ${maxAttempts} attempts`,
    );
  } finally {
    server.off("connection", track);
    for (const socket of sockets) socket.off("close", forget);
  }
}
