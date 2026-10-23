const { inflateRawSync } = require("node:zlib");
const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c >>> 0;
}
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const b of buffer) c = table[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** Validate actual expansion, CRC, duplicate names and local headers before an Office library sees the ZIP. */
function readOfficeArchive(buffer, limits = {}) {
  const maximum = limits.maxArchiveBytes || 64 * 1024 * 1024,
    maximumEntries = limits.maxArchiveEntries || 3000;
  let end = -1;
  for (let p = buffer.length - 22; p >= Math.max(0, buffer.length - 65557); p--)
    if (
      buffer.readUInt32LE(p) === 0x06054b50 &&
      p + 22 + buffer.readUInt16LE(p + 20) === buffer.length
    ) {
      end = p;
      break;
    }
  if (end < 0) throw Error("Invalid Office ZIP end record");
  const count = buffer.readUInt16LE(end + 10),
    directorySize = buffer.readUInt32LE(end + 12),
    directory = buffer.readUInt32LE(end + 16);
  if (
    buffer.readUInt16LE(end + 4) ||
    buffer.readUInt16LE(end + 6) ||
    count !== buffer.readUInt16LE(end + 8) ||
    count > maximumEntries ||
    count === 65535 ||
    directory + directorySize > end
  )
    throw Error("Unsupported or oversized Office archive");
  let offset = directory,
    expanded = 0;
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (
      offset + 46 > directory + directorySize ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    )
      throw Error("Invalid ZIP directory");
    const flags = buffer.readUInt16LE(offset + 8),
      method = buffer.readUInt16LE(offset + 10),
      crc = buffer.readUInt32LE(offset + 16),
      packed = buffer.readUInt32LE(offset + 20),
      size = buffer.readUInt32LE(offset + 24),
      nameLength = buffer.readUInt16LE(offset + 28),
      extra = buffer.readUInt16LE(offset + 30),
      comment = buffer.readUInt16LE(offset + 32),
      local = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extra + comment;
    if (
      !nameLength ||
      nameLength > 1024 ||
      next > directory + directorySize ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      size === 0xffffffff ||
      packed === 0xffffffff ||
      local + 30 > directory
    )
      throw Error("Unsupported Office ZIP entry");
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (
      name.includes("\\") ||
      name.startsWith("/") ||
      name.includes("\0") ||
      name.includes(":") ||
      name.split("/").some((p) => p === ".." || p === ".") ||
      files.has(name)
    )
      throw Error("Unsafe or duplicate Office ZIP path");
    if (
      buffer.readUInt32LE(local) !== 0x04034b50 ||
      buffer.readUInt16LE(local + 6) !== flags ||
      buffer.readUInt16LE(local + 8) !== method
    )
      throw Error("Office ZIP local header mismatch");
    const localNameLength = buffer.readUInt16LE(local + 26),
      start = local + 30 + localNameLength + buffer.readUInt16LE(local + 28);
    if (
      start + packed > directory ||
      buffer
        .subarray(local + 30, local + 30 + localNameLength)
        .toString("utf8") !== name ||
      expanded + size > maximum
    )
      throw Error("Office archive exceeds expansion limits");
    const compressed = buffer.subarray(start, start + packed),
      content =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, {
              maxOutputLength: Math.max(
                1,
                Math.min(maximum - expanded, size + 1),
              ),
            });
    if (content.length !== size || crc32(content) !== crc)
      throw Error("Office ZIP size or CRC mismatch");
    expanded += content.length;
    if (
      /\.(xml|rels)$/i.test(name) &&
      (content.includes(0) ||
        /<!DOCTYPE|<!ENTITY/i.test(content.toString("utf8")))
    )
      throw Error("Office XML document types and entities are forbidden");
    if (/(^|\/)vbaProject\.bin$/i.test(name))
      throw Error("Macro-enabled Office packages are not supported");
    files.set(name, content);
    offset = next;
  }
  if (offset !== directory + directorySize)
    throw Error("Office ZIP directory length mismatch");
  return files;
}
module.exports = { readOfficeArchive, crc32 };
