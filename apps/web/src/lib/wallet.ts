/**
 * An Oracle wallet zip, read in the browser (M38): the aliases its `tnsnames.ora` names, for the TNS alias field. A
 * minimal zip reader (the central directory, stored or deflated entries); anything it can't read gives no aliases.
 */
export async function walletAliases(zip: Uint8Array): Promise<string[]> {
  try {
    const text = await readEntry(zip, (name) => /(^|\/)tnsnames\.ora$/i.test(name))
    return text ? tnsAliases(text) : []
  } catch {
    return []
  }
}

/** The names `tnsnames.ora` defines: `name = (DESCRIPTION = …)` at the start of a line. */
export function tnsAliases(text: string): string[] {
  const names = new Set<string>()
  for (const m of text.matchAll(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*=/gm)) names.add(m[1]!)
  return [...names]
}

async function readEntry(zip: Uint8Array, wanted: (name: string) => boolean): Promise<string | null> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  // The end of central directory record: the last 22 bytes, or earlier with a comment.
  let end = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) return null
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  for (let n = 0; n < count && at + 46 <= zip.length; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) return null
    const method = view.getUint16(at + 10, true)
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (!wanted(name)) continue
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = zip.subarray(start, start + size)
    if (method === 0) return new TextDecoder().decode(data)
    if (method !== 8) return null
    const stream = new Blob([new Uint8Array(data)])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
    return await new Response(stream).text()
  }
  return null
}
