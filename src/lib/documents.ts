/**
 * Reading documents the agent cannot otherwise open.
 *
 * A .pptx, .docx or .xlsx is a ZIP of XML. The browser can already inflate a
 * deflate stream, so the text can be pulled out without a parser library and
 * without uploading the file anywhere — which matters, because the documents
 * people attach are usually the ones they would least like to send to a third
 * party.
 *
 * What comes back is text, not a rendering: slide titles and bullets, the body
 * of a document, the cells of a sheet. That is what a language model can use.
 */

export interface DocumentText {
  /** Plain text, in reading order. */
  text: string;
  /** How it was broken up — slides, or sheets — when that is meaningful. */
  sections: Array<{ title: string; body: string }>;
  kind: "slides" | "document" | "sheet" | "pdf" | "unknown";
}

interface ZipFile {
  name: string;
  bytes: Uint8Array;
}

const MAX_TEXT = 120_000;

export function isOfficeDocument(name: string): boolean {
  return /\.(pptx|docx|xlsx)$/i.test(name);
}

export async function readDocument(file: File): Promise<DocumentText | null> {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".pptx")) return await readSlides(file);
    if (name.endsWith(".docx")) return await readWord(file);
    if (name.endsWith(".xlsx")) return await readSheet(file);
  } catch {
    return null;
  }
  return null;
}

/* ------------------------------------------------------------------ pptx */

async function readSlides(file: File): Promise<DocumentText> {
  const entries = await unzip(file);
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

  const sections = slides.map((slide, index) => {
    const paragraphs = textRuns(decode(slide.bytes));
    const [first, ...rest] = paragraphs;
    return {
      title: first ? first.slice(0, 80) : `Slide ${index + 1}`,
      body: rest.join("\n"),
    };
  });

  const notes = entries
    .filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(entry.name))
    .map((entry) => textRuns(decode(entry.bytes)).join(" "))
    .filter(Boolean);

  const text = sections
    .map((section, index) => `Slide ${index + 1}: ${section.title}\n${section.body}`.trim())
    .join("\n\n");

  return {
    kind: "slides",
    sections,
    text: clip(notes.length ? `${text}\n\nSpeaker notes:\n${notes.join("\n")}` : text),
  };
}

const slideNumber = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

/* ------------------------------------------------------------------ docx */

async function readWord(file: File): Promise<DocumentText> {
  const entries = await unzip(file);
  const main = entries.find((entry) => entry.name === "word/document.xml");
  if (!main) return { kind: "document", sections: [], text: "" };

  const xml = decode(main.bytes);
  // Paragraphs carry the structure; runs inside them carry the words.
  const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
    .map((match) => textRuns(match[0], "w:t").join(""))
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    kind: "document",
    sections: [],
    text: clip(paragraphs.join("\n\n")),
  };
}

/* ------------------------------------------------------------------ xlsx */

async function readSheet(file: File): Promise<DocumentText> {
  const entries = await unzip(file);
  const sharedEntry = entries.find((entry) => entry.name === "xl/sharedStrings.xml");
  const shared = sharedEntry
    ? [...decode(sharedEntry.bytes).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
        textRuns(match[1] ?? "", "t").join(""),
      )
    : [];

  const sheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name));

  const sections = sheets.map((sheet, index) => {
    const xml = decode(sheet.bytes);
    const rows = [...xml.matchAll(/<row\b[\s\S]*?<\/row>/g)].slice(0, 200).map((rowMatch) => {
      const cells = [...rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => {
        const attributes = cell[1] ?? "";
        const body = cell[2] ?? "";
        const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        // t="s" means the value is an index into the shared string table.
        if (/t="s"/.test(attributes)) return shared[Number(value)] ?? "";
        if (/t="inlineStr"/.test(attributes)) return textRuns(body, "t").join("");
        return value;
      });
      return cells.join("\t");
    });
    return { title: `Sheet ${index + 1}`, body: rows.join("\n") };
  });

  return {
    kind: "sheet",
    sections,
    text: clip(sections.map((section) => `${section.title}\n${section.body}`).join("\n\n")),
  };
}

/* ------------------------------------------------------------------- zip */

/**
 * Read a ZIP well enough to get the parts out.
 *
 * The central directory is parsed from the end of the file, which is the only
 * reliable way to find entries: local headers can claim sizes of zero and
 * defer them to a descriptor after the data.
 */
async function unzip(file: File): Promise<ZipFile[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);

  const end = findEndOfCentralDirectory(bytes);
  if (end === -1) return [];

  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const files: ZipFile[] = [];

  for (let i = 0; i < count && offset + 46 <= bytes.length; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (/\.xml$/i.test(name)) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      const inflated = method === 0 ? data : await inflate(data);
      if (inflated) files.push({ name, bytes: inflated });
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  // The record is at the end, after a comment of unknown length.
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66_000); i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

/** Inflate with the browser's own decompressor — no library needed. */
async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([new Uint8Array(data).buffer as ArrayBuffer])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- text */

/** Pull the text out of an Office XML fragment, in document order. */
function textRuns(xml: string, tag = "a:t"): string[] {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(pattern)]
    .map((match) => unescapeXml(match[1] ?? ""))
    .filter((line) => line.trim());
}

const unescapeXml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const clip = (text: string) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(truncated)` : text;
