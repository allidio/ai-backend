import { Router } from 'express';
import multer from 'multer';
import { db, getAgentWithKey } from './db.js';
import {
  createKnowledgeBase,
  getKnowledgeBase,
  getKnowledgeBasesByAgent,
  deleteKnowledgeBase,
  getChunks,
  searchSimilarChunks,
} from './rag-db.js';
import { getEmbeddings, indexKnowledgeBase } from './embeddings.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// All KB routes are nested under /api/agents/:agentId/knowledge-bases

// ─── List knowledge bases for agent ─────────────────────────────
router.get('/api/agents/:agentId/knowledge-bases', (req, res) => {
  const agentId = Number(req.params.agentId);
  res.json(getKnowledgeBasesByAgent(agentId));
});

// ─── Create knowledge base for agent ────────────────────────────
router.post('/api/agents/:agentId/knowledge-bases', (req, res) => {
  const agentId = Number(req.params.agentId);
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const kb = createKnowledgeBase(agentId, name.trim(), description || '');
  res.status(201).json(kb);
});

// ─── Search across all agent's ready KBs ────────────────────────
router.get('/api/agents/:agentId/knowledge-bases/search/all', async (req, res) => {
  const agentId = Number(req.params.agentId);
  const query = req.query.q;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }

  const agent = getAgentWithKey(agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const kbs = getKnowledgeBasesByAgent(agentId).filter(kb => kb.status === 'ready');
    if (kbs.length === 0) {
      return res.json([]);
    }
    const kbIds = kbs.map(kb => kb.id);
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
    const [queryEmbedding] = await getEmbeddings([query.trim()], agent.api_key);
    const results = searchSimilarChunks(queryEmbedding, limit, kbIds);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
});

// ─── Get single knowledge base ──────────────────────────────────
router.get('/api/agents/:agentId/knowledge-bases/:kbId', (req, res) => {
  const kb = getKnowledgeBase(Number(req.params.kbId));
  if (!kb || kb.agent_id !== Number(req.params.agentId)) {
    return res.status(404).json({ error: 'Knowledge base not found' });
  }
  res.json(kb);
});

// ─── Delete knowledge base ──────────────────────────────────────
router.delete('/api/agents/:agentId/knowledge-bases/:kbId', (req, res) => {
  const kb = getKnowledgeBase(Number(req.params.kbId));
  if (!kb || kb.agent_id !== Number(req.params.agentId)) {
    return res.status(404).json({ error: 'Knowledge base not found' });
  }
  deleteKnowledgeBase(kb.id);
  res.json({ success: true });
});

// ─── Upload data to knowledge base ──────────────────────────────
router.post('/api/agents/:agentId/knowledge-bases/:kbId/upload', upload.single('file'), (req, res) => {
  const agentId = Number(req.params.agentId);
  const kb = getKnowledgeBase(Number(req.params.kbId));
  if (!kb || kb.agent_id !== agentId) {
    return res.status(404).json({ error: 'Knowledge base not found' });
  }
  if (kb.status === 'indexing') {
    return res.status(409).json({ error: 'Knowledge base is currently being indexed' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const agent = getAgentWithKey(agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const fileName = req.file.originalname || 'upload';
  const ext = fileName.split('.').pop().toLowerCase();
  if (!['csv', 'json'].includes(ext)) {
    return res.status(400).json({ error: 'Only CSV and JSON files are supported' });
  }

  const rawData = req.file.buffer.toString('utf-8');

  db.prepare("UPDATE knowledge_bases SET file_name = ?, updated_at = datetime('now') WHERE id = ?").run(fileName, kb.id);

  // Fire and forget — indexing runs in background, using the agent's API key
  indexKnowledgeBase(kb.id, rawData, ext, agent.api_key);

  res.status(202).json({ message: 'Indexing started', kbId: kb.id, fileName });
});

// ─── Get chunks (paginated) ────────────────────────────────────
router.get('/api/agents/:agentId/knowledge-bases/:kbId/chunks', (req, res) => {
  const kb = getKnowledgeBase(Number(req.params.kbId));
  if (!kb || kb.agent_id !== Number(req.params.agentId)) {
    return res.status(404).json({ error: 'Knowledge base not found' });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  res.json(getChunks(kb.id, { page, limit }));
});

// ─── Search single knowledge base ──────────────────────────────
router.get('/api/agents/:agentId/knowledge-bases/:kbId/search', async (req, res) => {
  const agentId = Number(req.params.agentId);
  const kb = getKnowledgeBase(Number(req.params.kbId));
  if (!kb || kb.agent_id !== agentId) {
    return res.status(404).json({ error: 'Knowledge base not found' });
  }
  if (kb.status !== 'ready') {
    return res.status(400).json({ error: 'Knowledge base is not ready for search' });
  }

  const query = req.query.q;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }

  const agent = getAgentWithKey(agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
    const [queryEmbedding] = await getEmbeddings([query.trim()], agent.api_key);
    const results = searchSimilarChunks(queryEmbedding, limit, [kb.id]);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
});

export default router;
