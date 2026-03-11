export function normalizeSymbolToken(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toUpperCase();
}

export function normalizePathwayName(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCollectionName(value: string | null | undefined): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();

  if (normalized.includes('hallmark')) {
    return 'Hallmark';
  }

  if (normalized.includes('reactome')) {
    return 'Reactome';
  }

  return value?.trim() || 'Unknown';
}

export function normalizeColumnKey(value: string | null | undefined): string {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

export function normalizeSheetRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};

    Object.entries(row).forEach(([key, value]) => {
      const normalizedKey = normalizeColumnKey(key);
      if (!normalizedKey) {
        return;
      }

      if (!(normalizedKey in normalized) || normalized[normalizedKey] === '') {
        normalized[normalizedKey] = value;
      }
    });

    return normalized;
  });
}

export function slugify(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function parseNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  let sign = 1;
  let normalized = String(value ?? '')
    .replace(/[−–—]/g, '-')
    .replace(/[\u00A0\u202F]/g, ' ')
    .trim();
  if (!normalized) {
    return Number.NaN;
  }

  // Accounting exports often encode negatives with parentheses, e.g. "(1.23)".
  const parenthesized = normalized.match(/^\((.*)\)$/);
  if (parenthesized) {
    sign = -1;
    normalized = parenthesized[1].trim().replace(/^[-+]\s*/, '');
  }

  // Common exports sometimes encode detection limits such as "<1e-300".
  normalized = normalized.replace(/^[<>]=?\s*/, '');

  // Space or apostrophe thousand separators (e.g. 12 345,6 / 12'345.6).
  if (/^[-+]?\d{1,3}(?:[ '\u00A0\u202F]\d{3})+(?:[.,]\d+)?(?:[eE][-+]?\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/[ '\u00A0\u202F]/g, '');
  }

  const hasDot = normalized.includes('.');
  const hasComma = normalized.includes(',');

  // US thousands separators (e.g. 1,234.56 or 1,234e-3).
  if (
    hasComma &&
    /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?([eE][-+]?\d+)?$/.test(normalized)
  ) {
    normalized = normalized.replace(/,/g, '');
  } else if (
    hasComma &&
    hasDot &&
    /^[-+]?\d{1,3}(\.\d{3})+(,\d+)?([eE][-+]?\d+)?$/.test(normalized)
  ) {
    // European thousands separators + decimal comma (e.g. 1.234,56).
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (
    hasComma &&
    !hasDot &&
    /^[-+]?\d+,\d+([eE][-+]?\d+)?$/.test(normalized)
  ) {
    // Decimal comma (e.g. 0,001).
    normalized = normalized.replace(',', '.');
  }

  const parsed = Number(normalized);
  if (sign < 0 && Number.isFinite(parsed)) {
    return -parsed;
  }
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function hasRequiredColumns(
  rows: Array<Record<string, unknown>>,
  requiredColumns: string[],
): string[] {
  const headers = new Set<string>();
  const requiredSet = new Set(requiredColumns);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      headers.add(key);
      if (requiredSet.size && headers.size >= requiredSet.size) {
        let hasAll = true;
        for (const required of requiredSet) {
          if (!headers.has(required)) {
            hasAll = false;
            break;
          }
        }
        if (hasAll) {
          return [];
        }
      }
    }
  }
  return requiredColumns.filter((column) => !headers.has(column));
}

export function splitGeneList(value: unknown): string[] {
  return String(value ?? '')
    .split(/[;,|\n\r\t]+/g)
    .map((gene) => normalizeSymbolToken(gene))
    .filter(Boolean);
}

export function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function safeHtmlScriptPayload(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function downloadBlob(filename: string, blob: Blob): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
