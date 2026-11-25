/* Lettura dello zip del pacchetto, senza librerie. Nel browser usa DecompressionStream. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CambiaUnzip = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_FILES = 32;
  const MAX_TOTAL = 250 * 1024 * 1024;

  function findEocd(bytes) {
    const start = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= start; i -= 1) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        return i;
      }
    }
    throw new Error("Questo file non sembra uno zip di Cambia Genere.");
  }

  function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === "function") {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (typeof require === "function") {
      const zlib = require("zlib");
      return new Uint8Array(zlib.inflateRawSync(Buffer.from(data)));
    }
    throw new Error("Questo browser non apre gli zip. Aggiorna Chrome o Safari.");
  }

  function safeName(name) {
    const base = String(name).split("/").pop().split("\\").pop();
    if (!base || base.indexOf("..") !== -1) {
      throw new Error("Nel pacchetto c'è un nome di file che non uso.");
    }
    return base;
  }

  async function unzip(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = viewOf(bytes);
    const eocd = findEocd(bytes);
    const count = view.getUint16(eocd + 10, true);
    const offset = view.getUint32(eocd + 16, true);
    if (count > MAX_FILES) throw new Error("Il pacchetto ha troppi file.");
    const files = {};
    let cursor = offset;
    let total = 0;
    for (let n = 0; n < count; n += 1) {
      if (view.getUint32(cursor, true) !== 0x02014b50) {
        throw new Error("Lo zip è danneggiato.");
      }
      const method = view.getUint16(cursor + 10, true);
      const compSize = view.getUint32(cursor + 20, true);
      const nameLen = view.getUint16(cursor + 28, true);
      const extraLen = view.getUint16(cursor + 30, true);
      const commentLen = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLen);
      const name = safeName(new TextDecoder("utf-8").decode(nameBytes));
      cursor += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith("/")) continue;
      if (view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error("Lo zip è danneggiato.");
      }
      const localName = view.getUint16(localOffset + 26, true);
      const localExtra = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localName + localExtra;
      const compressed = bytes.slice(dataStart, dataStart + compSize);
      let raw;
      if (method === 0) raw = compressed;
      else if (method === 8) raw = await inflateRaw(compressed);
      else throw new Error("Un file del pacchetto usa una compressione che non leggo.");
      total += raw.length;
      if (total > MAX_TOTAL) throw new Error("Il pacchetto è troppo grande per il telefono.");
      files[name] = raw;
    }
    return files;
  }

  return { unzip: unzip };
});
