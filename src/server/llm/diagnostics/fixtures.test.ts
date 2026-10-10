import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cacheFiller, codePdf, crc32, solidPng } from "./fixtures.ts";

function pngChunks(png: Buffer): Array<{ type: string; data: Buffer; crcOk: boolean }> {
  const chunks = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const body = png.subarray(offset + 4, offset + 8 + length);
    chunks.push({
      type: body.subarray(0, 4).toString("latin1"),
      data: body.subarray(4),
      crcOk: png.readUInt32BE(offset + 8 + length) === crc32(body),
    });
    offset += 12 + length;
  }
  return chunks;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("solidPng", () => {
  const png = solidPng(96, [220, 20, 20]);

  it("is a well-formed PNG with valid checksums", () => {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const chunks = pngChunks(png);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(chunks.every((chunk) => chunk.crcOk)).toBe(true);
  });

  it("declares its size and fills every pixel with the colour", () => {
    const [header, data] = pngChunks(png);
    expect(header?.data.readUInt32BE(0)).toBe(96);
    expect(header?.data.readUInt32BE(4)).toBe(96);
    expect([...(header?.data.subarray(8) ?? [])]).toEqual([8, 2, 0, 0, 0]);

    const pixels = inflateSync(data?.data ?? Buffer.alloc(0));
    expect(pixels).toHaveLength(96 * (1 + 96 * 3));
    const lastRow = pixels.subarray(95 * (1 + 96 * 3));
    expect([...lastRow.subarray(0, 4)]).toEqual([0, 220, 20, 20]);
    expect([...lastRow.subarray(-3)]).toEqual([220, 20, 20]);
  });
});

describe("codePdf", () => {
  const pdf = codePdf("HUBBER-ABC12345").toString("latin1");

  it("carries the code as plain text", () => {
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf).toContain("(Diagnostic code: HUBBER-ABC12345) Tj");
    expect(pdf.endsWith("%%EOF\n")).toBe(true);
  });

  it("has a cross-reference table whose offsets point at the objects", () => {
    const xrefOffset = Number(/startxref\n(\d+)\n/.exec(pdf)?.[1]);
    expect(pdf.slice(xrefOffset, xrefOffset + 4)).toBe("xref");

    const entries = [...pdf.slice(xrefOffset).matchAll(/^(\d{10}) 00000 n \n/gm)].map((match) => Number(match[1]));
    expect(entries).toHaveLength(5);
    entries.forEach((offset, index) => {
      expect(pdf.slice(offset, offset + 8)).toBe(`${index + 1} 0 obj\n`);
    });
  });

  it("declares the exact length of the content stream", () => {
    const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(pdf);
    expect(match?.[2]).toHaveLength(Number(match?.[1]));
  });

  it("refuses text it cannot encode safely", () => {
    expect(() => codePdf("kod (1)")).toThrow();
    expect(() => codePdf("zażółć")).toThrow();
  });
});

describe("cacheFiller", () => {
  it("is deterministic, starts with the nonce and clears the largest cache minimum", () => {
    const filler = cacheFiller("abc12345");

    expect(filler).toBe(cacheFiller("abc12345"));
    expect(filler.startsWith("[abc12345] ")).toBe(true);
    expect(filler.length).toBeGreaterThanOrEqual(24_000);
    expect(filler.length).toBeLessThan(25_000);
    expect(cacheFiller("ffff0000")).not.toBe(filler);
  });
});
