/** Product labels only; never persist chat bodies, contacts or full order responses. */
export interface ProductNameEntry { orderId: string; product: string; savedAt: number }
export interface ProductNameCache {
  get(key: string): ProductNameEntry | null;
  set(key: string, entry: ProductNameEntry): void;
  delete(key: string): void;
}
export interface ProductNameStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function createProductNameCache(storage?: ProductNameStorage, namespace = 'vbk.product-names.v1'): ProductNameCache {
  const entries = new Map<string, ProductNameEntry>();
  const valid = (value: unknown): value is ProductNameEntry => {
    const e = value as ProductNameEntry | null;
    return !!e && typeof e.orderId === 'string' && /^\d{1,32}$/.test(e.orderId) && typeof e.product === 'string' && !!e.product.trim() && e.product.length <= 2048 && Number.isFinite(e.savedAt) && e.savedAt >= 0;
  };
  try {
    const rows: unknown = JSON.parse(storage?.getItem(namespace) ?? '[]');
    if (Array.isArray(rows)) for (const row of rows.slice(-1000)) if (Array.isArray(row) && typeof row[0] === 'string' && row[0].length <= 4096 && valid(row[1])) entries.set(row[0], row[1]);
  } catch { /* Restricted or corrupted storage falls back to memory. */ }
  const persist = () => { try { storage?.setItem(namespace, JSON.stringify([...entries])); } catch {} };
  return {
    get: key => { const e = entries.get(key); return e ? { ...e } : null; },
    set(key, entry) { if (!valid(entry)) return; entries.delete(key); entries.set(key, { ...entry }); while (entries.size > 1000) entries.delete(entries.keys().next().value!); persist(); },
    delete(key) { if (entries.delete(key)) persist(); },
  };
}
