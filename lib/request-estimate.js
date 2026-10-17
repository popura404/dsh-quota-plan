// Estimate only model-visible fields. This is a heuristic, not a tokenizer or
// a guaranteed billing bound; the caller adds a configurable safety margin.
const FRAME_TOKENS = 4;

export function estimateTextTokens(value) {
  if (typeof value !== 'string') throw new TypeError('模型文本必须是字符串');
  let ascii = 0;
  let unicode = 0;
  for (const character of value) {
    if (character.codePointAt(0) < 128) ascii += 1;
    else unicode += 1;
  }
  // The usual four-characters-per-token heuristic badly undercounts Chinese.
  return Math.ceil(ascii / 4) + unicode;
}

function schemaTokens(tool) {
  if (!tool || typeof tool.name !== 'string' || typeof tool.description !== 'string'
    || !tool.parameters || typeof tool.parameters !== 'object' || Array.isArray(tool.parameters)) {
    throw new TypeError('无法估算工具定义');
  }
  // Include field names and JSON structure too, especially for many small
  // tools where values alone can be less than half the serialized schema.
  return FRAME_TOKENS + estimateTextTokens(JSON.stringify({ name: tool.name,
    description: tool.description, parameters: tool.parameters,
    ...(tool.deferLoading === true ? { deferLoading: true } : {}) }));
}

/**
 * Return null when an unknown block/projection cannot be measured. Provider
 * image pricing and file handles are optional SDK capabilities, passed in by
 * the host; prompts and attachment contents never leave this function.
 */
export function estimateRequestTokens(options, { projectRequest, priceImages, fileText } = {}) {
  try {
    if (!options || !Array.isArray(options.messages)) return null;
    const projected = projectRequest ? projectRequest(options) : options;
    if (!projected || !Array.isArray(projected.messages)) return null;
    const { messages } = projected;
    const tools = projected.tools ?? [];
    if (!Array.isArray(tools)) return null;
    let total = FRAME_TOKENS; // response priming
    if (options.system !== undefined) total += FRAME_TOKENS + estimateTextTokens(options.system);
    const images = [];
    for (const message of messages) {
      if (!message || typeof message.role !== 'string') return null;
      total += FRAME_TOKENS;
      // Older adapters also accept a plain text message body.
      if (typeof message.content === 'string') {
        total += estimateTextTokens(message.content);
        continue;
      }
      if (!Array.isArray(message.content)) return null;
      for (const block of message.content) {
        total += FRAME_TOKENS;
        switch (block?.type) {
          case 'text':
          case 'reasoning':
            total += estimateTextTokens(block.text);
            break;
          case 'tool-call':
            total += estimateTextTokens(block.name) + estimateTextTokens(block.arguments);
            break;
          case 'tool-addition':
          case 'tool-removal':
            total += estimateTextTokens(block.toolName);
            break;
          case 'image':
            images.push(block);
            break;
          case 'file':
            if (!fileText) return null;
            total += estimateTextTokens(fileText(block.attachment));
            break;
          default:
            return null;
        }
      }
    }
    if (images.length) {
      if (!priceImages) return null;
      const prices = priceImages(images);
      if (!Array.isArray(prices) || prices.length !== images.length) return null;
      for (const price of prices) {
        if (!Number.isSafeInteger(price?.visualTokens) || price.visualTokens < 0) return null;
        total += price.visualTokens + estimateTextTokens(price.text);
      }
    }
    for (const tool of tools) total += schemaTokens(tool);
    // Without the newer SDK projection, keep historical definitions as well.
    // Exact duplicates are counted once; revisions and removed tools remain.
    if (!projectRequest && options.toolHistory !== undefined) {
      const history = options.toolHistory;
      if (!history || !Array.isArray(history.tools) || !Array.isArray(history.updates)) return null;
      const seen = new Set(tools.map(tool => JSON.stringify(tool)));
      const historical = [...history.tools];
      for (const update of history.updates) {
        if (!Array.isArray(update?.additions)) return null;
        historical.push(...update.additions);
      }
      for (const tool of historical) {
        const key = JSON.stringify(tool);
        if (!seen.has(key)) { total += schemaTokens(tool); seen.add(key); }
      }
    }
    return Number.isSafeInteger(total) && total > 0 ? total : null;
  } catch {
    // Do not surface serialization errors that could include request content.
    return null;
  }
}
