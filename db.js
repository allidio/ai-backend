import Database from 'better-sqlite3';
import crypto from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'data.db'));

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// ─── Schema ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    agent_key TEXT NOT NULL UNIQUE,
    api_key TEXT NOT NULL,
    key_preview TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'gpt-4o',
    system_prompt TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );
`);

// ─── Migration: rename key_id → agent_id if old schema exists ────
try {
  db.prepare("SELECT key_id FROM usage_log LIMIT 0").run();
  // Old schema exists — recreate
  db.exec(`
    DROP TABLE IF EXISTS usage_log;
    CREATE TABLE usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );
  `);
} catch {
  // Column doesn't exist — already migrated or fresh
}

// Drop old api_keys table if it exists
db.exec('DROP TABLE IF EXISTS api_keys');

// ─── Helpers ─────────────────────────────────────────────────────
function maskKey(key) {
  if (key.length <= 8) return '****';
  return key.slice(0, 5) + '...' + key.slice(-4);
}

function generateAgentKey() {
  return 'agent_' + crypto.randomUUID().replace(/-/g, '');
}

function sanitizeAgent(row) {
  if (!row) return null;
  const { api_key, ...rest } = row;
  return rest;
}

// ─── Agent operations ────────────────────────────────────────────
function createAgent(name, apiKey, { description = '', model = 'gpt-4o', systemPrompt = '' } = {}) {
  const agentKey = generateAgentKey();
  const stmt = db.prepare(
    'INSERT INTO agents (name, description, agent_key, api_key, key_preview, model, system_prompt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(name, description, agentKey, apiKey, maskKey(apiKey), model, systemPrompt);
  return sanitizeAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(result.lastInsertRowid));
}

function getAgent(id) {
  return sanitizeAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id));
}

function getAgentWithKey(id) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) || null;
}

function getAgentByAgentKey(agentKey) {
  return db.prepare('SELECT * FROM agents WHERE agent_key = ?').get(agentKey) || null;
}

function getAllAgents() {
  return db.prepare(
    'SELECT id, name, description, agent_key, key_preview, model, system_prompt, created_at, updated_at FROM agents ORDER BY updated_at DESC'
  ).all();
}

function updateAgent(id, { name, description, apiKey, model, systemPrompt } = {}) {
  const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  if (!existing) return null;

  const newName = name ?? existing.name;
  const newDesc = description ?? existing.description;
  const newApiKey = apiKey ?? existing.api_key;
  const newPreview = apiKey ? maskKey(apiKey) : existing.key_preview;
  const newModel = model ?? existing.model;
  const newPrompt = systemPrompt ?? existing.system_prompt;

  db.prepare(`
    UPDATE agents
    SET name = ?, description = ?, api_key = ?, key_preview = ?, model = ?, system_prompt = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newName, newDesc, newApiKey, newPreview, newModel, newPrompt, id);

  return sanitizeAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id));
}

function deleteAgent(id) {
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function regenerateAgentKey(id) {
  const newKey = generateAgentKey();
  db.prepare("UPDATE agents SET agent_key = ?, updated_at = datetime('now') WHERE id = ?").run(newKey, id);
  return sanitizeAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id));
}

// ─── Usage operations ───────────────────────────────────────────
function logUsage(agentId, model, inputTokens, outputTokens) {
  db.prepare(
    'INSERT INTO usage_log (agent_id, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?)'
  ).run(agentId, model, inputTokens, outputTokens);
}

function getUsageStats(agentId = null, days = 7) {
  const agentFilter = agentId ? ' AND agent_id = ?' : '';
  const params = [`-${days} days`];
  if (agentId) params.push(agentId);

  const summary = db.prepare(`
    SELECT
      model,
      COUNT(*) as request_count,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(input_tokens + output_tokens) as total_tokens
    FROM usage_log
    WHERE created_at >= datetime('now', ?)${agentFilter}
    GROUP BY model
    ORDER BY total_tokens DESC
  `).all(...params);

  const daily = db.prepare(`
    SELECT
      date(created_at) as date,
      COUNT(*) as request_count,
      SUM(input_tokens + output_tokens) as total_tokens
    FROM usage_log
    WHERE created_at >= datetime('now', ?)${agentFilter}
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(...params);

  const totalRequests = db.prepare(`
    SELECT COUNT(*) as c FROM usage_log WHERE created_at >= datetime('now', ?)${agentFilter}
  `).get(...params).c;

  return { summary, daily, totalRequests, days };
}

export {
  db,
  createAgent,
  getAgent,
  getAgentWithKey,
  getAgentByAgentKey,
  getAllAgents,
  updateAgent,
  deleteAgent,
  regenerateAgentKey,
  logUsage,
  getUsageStats,
};
