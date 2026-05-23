import { Router } from 'express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { db } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

const IMG_BASE = 'https://www.sephora.com/productimages/sku/s';

// ─── Schema ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    sku_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    brand TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    rating REAL NOT NULL,
    description TEXT
  )
`);

// ─── CSV loading (product database only — NOT RAG) ───────────────
const CSV_PATH = join(__dirname, '..', 'sephora-shop', 'public', 'products.csv');

try {
  const csvRaw = readFileSync(CSV_PATH, 'utf-8');
  const lines = csvRaw.trim().split('\n');

  const insert = db.prepare(
    'INSERT OR IGNORE INTO products (sku_id, name, brand, category, price, rating, description) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const insertMany = db.transaction((rows) => {
    for (const row of rows) insert.run(...row);
  });

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 7) continue;
    rows.push([
      parts[0].trim(),
      parts[1].trim(),
      parts[2].trim(),
      parts[3].trim(),
      parseFloat(parts[4]),
      parseFloat(parts[5]),
      parts.slice(6).join(',').trim(),
    ]);
  }

  insertMany(rows);
  console.log(`  Loaded ${rows.length} products into database`);
} catch (err) {
  console.warn('  Could not load products CSV:', err.message);
}

// ─── Helpers ─────────────────────────────────────────────────────
function productRow(row) {
  return {
    ...row,
    image: `${IMG_BASE}${row.sku_id}-main-zoom.jpg&imwidth=122`,
  };
}

// ─── GET /api/products ──────────────────────────────────────────
router.get('/api/products', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
  const offset = (page - 1) * limit;
  const category = req.query.category || null;

  let countSql = 'SELECT COUNT(*) as total FROM products';
  let dataSql = 'SELECT * FROM products';
  const params = [];

  if (category) {
    countSql += ' WHERE category = ?';
    dataSql += ' WHERE category = ?';
    params.push(category);
  }

  dataSql += ' ORDER BY brand, name LIMIT ? OFFSET ?';

  const total = db.prepare(countSql).get(...params).total;
  const products = db.prepare(dataSql).all(...params, limit, offset).map(productRow);
  const totalPages = Math.ceil(total / limit);

  res.json({ products, total, page, limit, totalPages });
});

// ─── GET /api/products/categories ───────────────────────────────
router.get('/api/products/categories', (_req, res) => {
  const rows = db.prepare('SELECT DISTINCT category FROM products ORDER BY category').all();
  res.json({ categories: rows.map(r => r.category) });
});

// ─── GET /api/products/search ───────────────────────────────────
router.get('/api/products/search', (req, res) => {
  const q = req.query.q;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Query parameter q is required' });

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
  const offset = (page - 1) * limit;
  const category = req.query.category || null;
  const pattern = `%${q.trim()}%`;

  let where = '(name LIKE ? OR brand LIKE ? OR description LIKE ?)';
  const params = [pattern, pattern, pattern];

  if (category) {
    where += ' AND category = ?';
    params.push(category);
  }

  const total = db.prepare(`SELECT COUNT(*) as total FROM products WHERE ${where}`).get(...params).total;
  const products = db.prepare(`SELECT * FROM products WHERE ${where} ORDER BY brand, name LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map(productRow);
  const totalPages = Math.ceil(total / limit);

  res.json({ products, total, page, limit, totalPages });
});

// ─── GET /api/products/by-skus ──────────────────────────────────
// Fetch multiple products by SKU IDs (for AI tool results)
router.post('/api/products/by-skus', (req, res) => {
  const { skus } = req.body;
  if (!Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ error: 'skus array is required' });
  }

  const placeholders = skus.map(() => '?').join(',');
  const products = db.prepare(`SELECT * FROM products WHERE sku_id IN (${placeholders})`)
    .all(...skus)
    .map(productRow);

  res.json({ products });
});

// ─── GET /api/products/:skuId ───────────────────────────────────
router.get('/api/products/:skuId', (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE sku_id = ?').get(req.params.skuId);
  if (!row) return res.status(404).json({ error: 'Product not found' });
  res.json(productRow(row));
});

export default router;
