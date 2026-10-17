import { Kernel, parseConfig } from "../../src/index.js";
const config = parseConfig(JSON.parse(process.argv[2]));
const kernel = new Kernel(config);
const timestamp = new Date().toISOString();
kernel.store.put("runs", {
  id: "child_active",
  sessionId: "child_session",
  status: "running",
  createdAt: timestamp,
  updatedAt: timestamp,
});
process.stdout.write("owned\n");
setInterval(() => {}, 1000);
