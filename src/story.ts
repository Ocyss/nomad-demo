const novel = await Bun.file(new URL("./novel.txt", import.meta.url)).text();

export const storyId = Bun.hash(novel).toString(16);

export function cursorFrom(url: string) {
  const value = new URL(url).searchParams.get("cursor") ?? "0";
  const cursor = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(cursor) ||
    cursor > Number.MAX_SAFE_INTEGER - 3
  ) {
    throw new Error("cursor 必须是安全范围内的非负整数");
  }
  return cursor;
}

export function chunkAt(offset: number) {
  const start = offset % novel.length;
  const text = (novel + novel).slice(start, start + 3);
  return { event: "chunk", storyId, offset, next: offset + text.length, text };
}
