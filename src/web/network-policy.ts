import { BlockList, isIP } from "node:net";

const restricted4 = new BlockList(),
  restricted6 = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  restricted4.addSubnet(address, bits, "ipv4");
for (const [address, bits] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2001::", 32],
  ["2002::", 16],
] as const)
  restricted6.addSubnet(address, bits, "ipv6");
export function restrictedAddress(address: string) {
  const family = isIP(address);
  return (
    !family ||
    (family === 4
      ? restricted4.check(address, "ipv4")
      : restricted6.check(address, "ipv6"))
  );
}
export const hostMatches = (patterns: string[], host: string) =>
  patterns.some((value) => {
    const p = value.toLowerCase();
    return (
      p === "*" ||
      p === host ||
      (p.startsWith("*.") &&
        host.endsWith(p.slice(1)) &&
        host.length > p.length - 1)
    );
  });
