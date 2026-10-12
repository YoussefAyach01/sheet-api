/** Reads a request body with a hard byte cap, aborting the stream early. Null = too large. */
export async function readCapped(req: Request, limit: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
