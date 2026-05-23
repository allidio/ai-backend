import * as sqliteVec from 'sqlite-vec';
import { db } from './db.js';

// Load sqlite-vec extension
sqliteVec.load(db);

// ─── Schema ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_bases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    file_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    total_chunks INTEGER DEFAULT 0,
    indexed_chunks INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS kb_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kb_id INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_vec USING vec0(embedding float[1536]);
`);

// ─── Migration: add agent_id column if missing ───────────────────
try {
  db.prepare('SELECT agent_id FROM knowledge_bases LIMIT 0').run();
} catch {
  // Column doesn't exist — add it (default 0 for any orphaned rows)
  db.exec('ALTER TABLE knowledge_bases ADD COLUMN agent_id INTEGER NOT NULL DEFAULT 0');
}

// ─── Helpers ─────────────────────────────────────────────────────
function embeddingToBuffer(arr) {
  return Buffer.from(new Float32Array(arr).buffer);
}

// ─── Knowledge Base CRUD (scoped by agent) ───────────────────────
function createKnowledgeBase(agentId, name, description = '') {
  const result = db.prepare(
    'INSERT INTO knowledge_bases (agent_id, name, description) VALUES (?, ?, ?)'
  ).run(agentId, name, description);
  return db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(result.lastInsertRowid);
}

function getKnowledgeBase(id) {
  return db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id) || null;
}

function getKnowledgeBasesByAgent(agentId) {
  return db.prepare('SELECT * FROM knowledge_bases WHERE agent_id = ? ORDER BY updated_at DESC').all(agentId);
}

function getAllKnowledgeBases() {
  return db.prepare('SELECT * FROM knowledge_bases ORDER BY updated_at DESC').all();
}

function updateKnowledgeBaseStatus(id, status, { totalChunks, indexedChunks, errorMessage } = {}) {
  const kb = db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id);
  if (!kb) return null;

  db.prepare(`
    UPDATE knowledge_bases
    SET status = ?,
        total_chunks = COALESCE(?, total_chunks),
        indexed_chunks = COALESCE(?, indexed_chunks),
        error_message = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(status, totalChunks ?? null, indexedChunks ?? null, errorMessage ?? null, id);

  return db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id);
}

function deleteKnowledgeBase(id) {
  // Delete vector entries first (not covered by CASCADE)
  const chunkIds = db.prepare('SELECT id FROM kb_chunks WHERE kb_id = ?').all(id);
  if (chunkIds.length > 0) {
    const deleteVec = db.prepare('DELETE FROM kb_chunks_vec WHERE rowid = ?');
    for (const { id: chunkId } of chunkIds) {
      deleteVec.run(BigInt(chunkId));
    }
  }
  db.prepare('DELETE FROM kb_chunks WHERE kb_id = ?').run(id);
  db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id);
}

// ─── Chunk operations ───────────────────────────────────────────
function insertChunk(kbId, chunkText, metadata = {}) {
  const result = db.prepare(
    'INSERT INTO kb_chunks (kb_id, chunk_text, metadata) VALUES (?, ?, ?)'
  ).run(kbId, chunkText, JSON.stringify(metadata));
  return result.lastInsertRowid;
}

function insertChunkEmbedding(chunkId, embeddingArray) {
  db.prepare(
    'INSERT INTO kb_chunks_vec (rowid, embedding) VALUES (?, ?)'
  ).run(BigInt(chunkId), embeddingToBuffer(embeddingArray));
}

function getChunks(kbId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const chunks = db.prepare(
    'SELECT id, chunk_text, metadata, created_at FROM kb_chunks WHERE kb_id = ? ORDER BY id LIMIT ? OFFSET ?'
  ).all(kbId, limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM kb_chunks WHERE kb_id = ?').get(kbId).count;

  return { chunks, total, page, limit };
}

// ─── Similarity search ─────────────────────────────────────────
function searchSimilarChunks(queryEmbedding, limit = 5, kbIds = null) {
  const queryBuf = embeddingToBuffer(queryEmbedding);

  if (kbIds && kbIds.length > 0) {
    const placeholders = kbIds.map(() => '?').join(',');
    return db.prepare(`
      SELECT c.id, c.chunk_text, c.metadata, c.kb_id, v.distance
      FROM kb_chunks_vec v
      JOIN kb_chunks c ON c.id = v.rowid
      WHERE v.embedding MATCH ?
        AND k = ?
        AND c.kb_id IN (${placeholders})
      ORDER BY v.distance
    `).all(queryBuf, limit, ...kbIds);
  }

  return db.prepare(`
    SELECT c.id, c.chunk_text, c.metadata, c.kb_id, v.distance
    FROM kb_chunks_vec v
    JOIN kb_chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH ?
      AND k = ?
    ORDER BY v.distance
  `).all(queryBuf, limit);
}

function getReadyKnowledgeBaseIds(agentId) {
  return db.prepare("SELECT id FROM knowledge_bases WHERE agent_id = ? AND status = 'ready'")
    .all(agentId)
    .map(r => r.id);
}

function getReadyKnowledgeBaseSummaries(agentId) {
  return db.prepare("SELECT name, description FROM knowledge_bases WHERE agent_id = ? AND status = 'ready'")
    .all(agentId);
}

function getReadyKnowledgeBaseIdsByNames(agentId, names) {
  const placeholders = names.map(() => '?').join(',');
  return db.prepare(
    `SELECT id FROM knowledge_bases WHERE agent_id = ? AND status = 'ready' AND name IN (${placeholders})`
  ).all(agentId, ...names).map(r => r.id);
}

export {
  createKnowledgeBase,
  getKnowledgeBase,
  getKnowledgeBasesByAgent,
  getAllKnowledgeBases,
  updateKnowledgeBaseStatus,
  deleteKnowledgeBase,
  insertChunk,
  insertChunkEmbedding,
  getChunks,
  searchSimilarChunks,
  getReadyKnowledgeBaseIds,
  getReadyKnowledgeBaseIdsByNames,
  getReadyKnowledgeBaseSummaries,
  embeddingToBuffer,
};
