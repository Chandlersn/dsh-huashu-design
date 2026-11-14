export async function loadHandbook(read, path, { previous = null, signal, onProgress, maxPages = 8 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError('maxPages must be a positive integer.');
  let content = previous?.path === path ? previous.content : '';
  let offset = previous?.path === path ? previous.nextOffset : 0;
  let total = previous?.path === path ? previous.total : null;
  if (offset === null) return previous;
  let result;
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) throw new DOMException('Handbook read cancelled.', 'AbortError');
    result = await read({ path, offset, limit: 16000 }, signal);
    if (signal?.aborted) throw new DOMException('Handbook read cancelled.', 'AbortError');
    if (result.path !== path || result.offset !== offset || typeof result.content !== 'string'
      || !Number.isSafeInteger(result.total) || result.total < offset + result.content.length
      || (total !== null && total !== 0 && result.total !== total)) throw new Error('Handbook changed while loading; reopen it before reading further.');
    total = result.total;
    const end = offset + result.content.length;
    if ((result.nextOffset !== null && (result.nextOffset !== end || end <= offset || end >= total))
      || (result.nextOffset === null && end !== total)) throw new Error('Handbook pagination did not advance correctly.');
    content += result.content;
    offset = result.nextOffset;
    onProgress?.({ loaded: content.length, total });
    if (offset === null) break;
  }
  return { ...result, path, content, offset: 0, limit: content.length, total, nextOffset: offset, pending: false };
}
