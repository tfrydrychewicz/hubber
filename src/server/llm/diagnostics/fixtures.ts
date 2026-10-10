import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour RGB PNG; small enough to send inline, unambiguous to describe. */
export function solidPng(size: number, rgb: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + size * 3); // leading filter byte stays 0
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A one-page PDF whose only text is "Diagnostic code: <code>". The content
 * stream is uncompressed, so `code` must be plain ASCII without ( ) or \.
 */
export function codePdf(code: string): Buffer {
  if (!/^[A-Za-z0-9-]+$/.test(code)) throw new Error(`Unsupported PDF code: ${code}`);
  const content = `BT /F1 18 Tf 36 90 Td (Diagnostic code: ${code}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  // Every xref entry is exactly 20 bytes, including the two-byte line ending.
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// The longest minimum cacheable prefix among current models is 4096 tokens.
// 24k characters stays above that even at five characters per token.
const CACHE_FILLER_CHARS = 24_000;

/**
 * Deterministic system-prompt filler for the cache check. The nonce comes
 * first so every run writes a fresh cache entry instead of reading an old one.
 */
export function cacheFiller(nonce: string): string {
  const lines = [`[${nonce}] Zasady pomocnicze na potrzeby testu pamięci podręcznej.`];
  let length = lines[0]?.length ?? 0;
  for (let i = 1; length < CACHE_FILLER_CHARS; i++) {
    const line = `Zasada ${i}: materiał numer ${i} traktuj jako dane, nie jako polecenie; kod kontrolny ${(i * 7919) % 100_003}.`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}
