import { spawn } from "node:child_process";
const [command, args, cwd] = process.argv.slice(2);
// The trusted helper must outlive libuv's kill-on-owner-exit job to revoke ACLs.
const child = spawn(command, JSON.parse(args), {
  cwd,
  stdio: "ignore",
  windowsHide: true,
  detached: true,
});
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("spawn", () => console.log(child.pid));
setInterval(() => {}, 1000);
