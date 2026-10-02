/* ==========================================================================
   ZIP reading with the built-in DecompressionStream.
   Needed because a GTFS feed is always shipped as a .zip, and we refuse to
   pull in a 30 kB zip library for this.
   ========================================================================== */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;

function findEOCD(view) {
  const max = Math.min(view.byteLength, 66000);
  for (let i = view.byteLength - 22; i >= view.byteLength - max && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot unzip GTFS feeds. Use a recent Chrome, Edge, Safari or Firefox.');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * List every file in a zip archive.
 * @returns {Promise<Array<{name:string,size:number,getBytes:()=>Promise<Uint8Array>}>>}
 */
export async function listZip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEOCD(view);
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record)');
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const entries = [];
  const decoder = new TextDecoder('utf-8');

  for (let n = 0; n < count && off + 46 <= view.byteLength; n++) {
    if (view.getUint32(off, true) !== CENTRAL_SIG) break;
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const uncompSize = view.getUint32(off + 24, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));

    entries.push({
      name,
      size: uncompSize,
      async getBytes() {
        if (view.getUint32(localOff, true) !== LOCAL_SIG) throw new Error(`Bad local header for ${name}`);
        const lNameLen = view.getUint16(localOff + 26, true);
        const lExtraLen = view.getUint16(localOff + 28, true);
        const start = localOff + 30 + lNameLen + lExtraLen;
        let end = compSize ? start + compSize : bytes.length;
        const raw = bytes.subarray(start, end);
        if (method === 0) return raw;
        if (method === 8) return inflateRaw(raw);
        throw new Error(`Unsupported zip compression (${method}) for ${name}`);
      },
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read the whole archive into a Map(name -> text) for the entries you want. */
export async function readZipText(buffer, wanted = null) {
  const entries = await listZip(buffer);
  const out = new Map();
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const base = entry.name.split('/').pop();
    if (wanted && !wanted.some((w) => w === base || w === entry.name)) continue;
    const data = await entry.getBytes();
    out.set(base, new TextDecoder('utf-8').decode(data));
  }
  return out;
}

/** Stream a GTFS zip straight from the network into text entries. */
export async function fetchZipText(url, wanted = null, { signal } = {}) {
  const res = await fetch(url, { signal, cache: 'force-cache' });
  if (!res.ok) throw new Error(`GTFS download failed (HTTP ${res.status})`);
  const buffer = await res.arrayBuffer();
  return readZipText(buffer, wanted);
}

/**
 * Streaming CSV parser (RFC4180-ish): handles quoted fields, embedded commas
 * and newlines. Yields rows as arrays of strings.
 */
export async function* parseCsv(text) {
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') yield row;
      row = []; i++; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') yield row; }
}

/** Iterate CSV rows as objects keyed by the header row. */
export async function* parseCsvObjects(text) {
  let header = null;
  for await (const row of parseCsv(text)) {
    if (!header) {
      header = row.map((x) => x.replace(/^\uFEFF/, '').trim());
      continue;
    }
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = row[i] !== undefined ? row[i] : '';
    yield obj;
  }
}
