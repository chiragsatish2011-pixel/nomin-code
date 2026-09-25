/**
 * A minimal ZIP writer.
 *
 * Work that only exists inside a browser tab is work you cannot take anywhere,
 * so the workspace has to be downloadable. That does not justify a dependency:
 * a store-only ZIP is a few hundred bytes of header per file, and every tool
 * that opens archives reads it.
 *
 * Store-only means no compression. For the text these builds produce the
 * saving would be real but the cost is a compression library in the bundle and
 * a second failure mode; plain files that always open are the better trade.
 */

export interface ZipEntry {
  path: string;
  content: string;
}

export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(normalise(entry.path));
    const data = encoder.encode(entry.content);
    const crc = crc32(data);
    const { time, date } = dosTime(new Date());

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); // local file header
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 0, true); // stored, not deflated
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true); // extra field length
    local.set(name, 30);

    chunks.push(local, data);

    const entryHeader = new Uint8Array(46 + name.length);
    const entryView = new DataView(entryHeader.buffer);
    entryView.setUint32(0, 0x02014b50, true); // central directory header
    entryView.setUint16(4, 20, true); // version made by
    entryView.setUint16(6, 20, true); // version needed
    entryView.setUint16(8, 0, true);
    entryView.setUint16(10, 0, true);
    entryView.setUint16(12, time, true);
    entryView.setUint16(14, date, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, data.length, true);
    entryView.setUint32(24, data.length, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint16(30, 0, true); // extra
    entryView.setUint16(32, 0, true); // comment
    entryView.setUint16(34, 0, true); // disk number
    entryView.setUint16(36, 0, true); // internal attributes
    entryView.setUint32(38, 0, true); // external attributes
    entryView.setUint32(42, offset, true); // where the local header sits
    entryHeader.set(name, 46);
    central.push(entryHeader);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // end of central directory
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  // Copy each part into a plain ArrayBuffer view: a Uint8Array over a shared
  // buffer is not a valid BlobPart.
  const parts = [...chunks, ...central, end].map(
    (part) => new Uint8Array(part).buffer as ArrayBuffer,
  );
  return new Blob(parts, { type: "application/zip" });
}

/** Save a blob under a name, without leaving anything behind. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** ZIP paths use forward slashes and never escape the archive root. */
function normalise(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

let table: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[i] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP stores timestamps in the DOS format, which starts counting at 1980. */
function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
