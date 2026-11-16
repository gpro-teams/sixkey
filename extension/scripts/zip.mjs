// A deterministic zip of a directory (scripts/package.mjs): every file under it, entries in path order (the archive's
// own names compared by code unit, so the order never depends on how a file system lists a directory), one fixed
// timestamp (1980-01-01 00:00, the earliest DOS date), deflated, UTF-8 names, no extra fields. The same files give the
// same bytes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

/** The zip of everything under `dir`, and its entry names in archive order. */
export function zipDirectory(top) {
  const files = [];
  (function walk(dir) {
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  })(top);
  const nameOf = (p) => relative(top, p).split("\\").join("/");
  files.sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));

  // 1980-01-01 00:00, the earliest DOS date: the same bytes for the same build
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const local = [];
  const central = [];
  let offset = 0;
  for (const p of files) {
    const name = Buffer.from(nameOf(p), "utf8");
    const data = readFileSync(p);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, packed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += head.length + name.length + packed.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, ...central, end]);
  return { zip, names: files.map(nameOf) };
}
