// These helpers read published data only. Never evaluate scripts or MDX from a
// pricing page: a changed page must fail extraction instead of becoming code.
export function entities(value) {
  const names = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, key) => {
    if (key[0] !== '#') return names[key.toLowerCase()] ?? match;
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
  });
}

export function text(html) {
  return entities(String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<br\s*\/?\s*>|<\/(?:p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')).replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export function tables(html) {
  return [...String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map(match => {
    const grid = [];
    let r = -1;
    for (const row of match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      r++;
      grid[r] ??= [];
      let c = 0;
      for (const cell of row[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]\s*>/gi)) {
        while (grid[r][c] !== undefined) c++;
        const span = name => Math.min(100, Math.max(1, Number(cell[1].match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i'))?.[1] ?? 1)));
        const width = span('colspan');
        const height = span('rowspan');
        const value = text(cell[2]);
        for (let y = r; y < r + height; y++) {
          grid[y] ??= [];
          for (let x = c; x < c + width; x++) grid[y][x] = value;
        }
        c += width;
      }
      // A row span reserves future rows; length cannot be used as row index.
    }
    return grid;
  });
}

export function numeric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(value.trim()))) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1000000 ? n : undefined;
}

export function maxRate(object, key, value) {
  if (value !== undefined) object[key] = Math.max(object[key] ?? 0, value);
}

export function tokenMultiplier(unit) {
  const clean = String(unit).toLowerCase().replace(/[\s,_]/g, '');
  if (/hour|minute|second|image|request|tpm|gb|day/.test(clean)) return undefined;
  if (/^(?:1m|m|million|1000000)(?:tokens?)?$/.test(clean)) return 1;
  if (/^(?:1k|k|1000)(?:tokens?)?$/.test(clean)) return 1000;
  if (/^tokens?$/.test(clean)) return 1000000;
  return undefined;
}

// Only currently effective USD amounts are returned. Storage/time and other
// modalities are separate meters and cannot be folded into text token prices.
export function dollarRates(cell, now = Date.now(), { textOnly = false } = {}) {
  const amounts = [];
  const datePattern = '([A-Za-z]+\\s+\\d{1,2},?\\s+\\d{4})';
  for (const line of String(cell).replace(/\$\s+(?=\d)/g, '$').split(/\n+/)) {
    for (const match of line.matchAll(/\$\s*([\d,]+(?:\.\d+)?)([^$]*)/g)) {
      const rest = match[2];
      if (/per hour|\/\s*(?:hour|hr|min|second)|storage price|per (?:request|image|character)/i.test(rest)) continue;
      if (textOnly && /\b(?:audio|video|image)\b/i.test(rest) && !/\btext\b/i.test(rest)) continue;
      const from = rest.match(new RegExp(`(?:starting|effective(?: from)?|from)\\s+${datePattern}`, 'i'));
      const until = rest.match(new RegExp(`(?:through|until)\\s+${datePattern}`, 'i'));
      if (from && now < Date.parse(`${from[1]} 00:00:00 GMT`)) continue;
      if (until && now >= Date.parse(`${until[1]} 00:00:00 GMT`) + 86400000) continue;
      const value = numeric(match[1].replace(/,/g, ''));
      if (value !== undefined) amounts.push(value);
    }
  }
  return amounts;
}

export function finish(entries, id) {
  const combined = new Map();
  for (const entry of entries) {
    if (!entry?.model || numeric(entry.rates?.input) === undefined || numeric(entry.rates?.output) === undefined) continue;
    const key = `${entry.currency}/${entry.model}`;
    const existing = combined.get(key);
    if (!existing) {
      combined.set(key, { ...entry, rates: { ...entry.rates } });
      continue;
    }
    for (const rate of ['input', 'output', 'cacheRead', 'cacheWrite']) maxRate(existing.rates, rate, numeric(entry.rates[rate]));
    existing.notes = [...new Set([...(existing.notes ?? []), ...(entry.notes ?? [])])];
    existing.aliases = [...new Set([...(existing.aliases ?? []), ...(entry.aliases ?? [])])];
  }
  if (!combined.size) throw new Error(`${id} 官方价格源没有提取到完整的文本输入和输出单价`);
  return [...combined.values()];
}
