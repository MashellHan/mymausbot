import fs from "node:fs";
import path from "node:path";

const MARKER = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const BLOCK = 1024 * 1024;
const unsupported = () => new Error("Private browser storage is unavailable for this Electron runtime");

/** Electron 43 fuse v1 stores nine ASCII 0/1 values after the marker; index 1 controls cookie encryption. */
export function verifyPrivateBrowserFuse(runtime = process, files = fs) {
  if (runtime.platform !== "darwin" || runtime.versions?.electron !== "43.7.9" ||
      !path.isAbsolute(runtime.execPath ?? "") || path.basename(path.dirname(runtime.execPath)) !== "MacOS") throw unsupported();
  const contents = path.dirname(path.dirname(runtime.execPath));
  if (path.basename(contents) !== "Contents") throw unsupported();
  const framework = path.join(contents, "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework");
  let fd;
  try {
    fd = files.openSync(framework, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = files.fstatSync(fd);
    if (!stat.isFile() || stat.size < MARKER.length + 11 || stat.size > 512 * 1024 * 1024) throw unsupported();
    const chunk = Buffer.alloc(BLOCK + MARKER.length - 1);
    const wire = Buffer.alloc(11);
    let found = 0, last = -1;
    for (let offset = 0; offset < stat.size; offset += BLOCK) {
      const read = files.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (read <= 0) throw unsupported();
      for (let index = chunk.indexOf(MARKER, 0); index >= 0 && index < read; index = chunk.indexOf(MARKER, index + 1)) {
        const absolute = offset + index;
        if (absolute <= last || index + MARKER.length > read) continue;
        last = absolute;
        if (files.readSync(fd, wire, 0, wire.length, absolute + MARKER.length) !== wire.length ||
            wire[0] !== 1 || wire[1] !== 9 || !wire.subarray(2).every(value => value === 48 || value === 49)) throw unsupported();
        found++;
        if (found > 1 || wire[3] !== 48) throw unsupported();
      }
    }
    if (found !== 1) throw unsupported();
  } catch {
    throw unsupported();
  } finally {
    if (fd !== undefined) files.closeSync(fd);
  }
}
