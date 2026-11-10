/**
 * Read a request or response body as UTF-8 text, counting the bytes actually
 * received so a chunked body without `Content-Length` cannot exceed the cap.
 *
 * @param body - The body stream, or `null` for an empty body.
 * @param maxBytes - Largest body accepted, in bytes.
 * @returns The body text, or `null` once it passes `maxBytes`.
 * @example
 * const text = await readBoundedText(request.body, 4 * 1024 * 1024);
 * if (text === null) return new Response("Too large", { status: 413 });
 */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
