import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
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
} from './db.js';
import { getReadyKnowledgeBaseIds, getReadyKnowledgeBaseIdsByNames, getReadyKnowledgeBaseSummaries, searchSimilarChunks } from './rag-db.js';
import { getEmbeddings } from './embeddings.js';
import ragRoutes from './rag-routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─── Serve dashboard frontend ────────────────────────────────────
app.use('/dashboard', express.static(join(__dirname, 'dashboard')));

// ─── Health check ────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const agents = getAllAgents();
  res.json({
    status: 'ok',
    agentCount: agents.length,
  });
});

// ─── Base system prompt (always injected) ────────────────────────
const BASE_SYSTEM_PROMPT = `You are an AI assistant embedded in a web application. You help users understand, navigate, and interact with the app.

TOOL SELECTION PRIORITY — Follow this order strictly:
1. DOMAIN TOOLS FIRST: If the user's request matches a domain-specific tool (product search, cart actions, data lookups), ALWAYS use that tool. Never fall back to generic UI tools for tasks that have a dedicated tool.
2. UI TOOLS SECOND: Only use browser/UI tools (find_elements, click_element, get_page_structure, etc.) for navigating the interface, locating UI controls, or answering questions about what's visible on screen.
3. NEVER use find_elements, get_visible_text, or get_interactive_elements to search for products, look up inventory, or find recommendations. These are UI inspection tools, not data search tools.

INTENT CLASSIFICATION:
- "find me X", "recommend X", "suggest X", "show me X", "what X do you have" → PRODUCT SEARCH. Use the product/recommendation tool with SKU IDs from your knowledge base context.
- "add to cart", "buy this", "remove from cart", "what's in my cart" → CART ACTION. Use the cart tool.
- "how do I...", "where is the...", "show me how to..." → UI GUIDANCE. Use point_to_element to highlight the relevant UI element and explain.
- "click X", "go to X", "fill in X" → UI ACTION. Use click_element, navigate_to, or fill_input.

OTHER GUIDELINES:
- After performing an action, briefly confirm what you did.
- Be concise. Don't list raw tool output — summarize it naturally.
- If a tool returns an error, explain what went wrong and suggest alternatives.`;

// ─── RAG: extract user message from Responses API input ─────────
function extractUserMessage(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i--) {
      const item = input[i];
      if (typeof item === 'string') return item;
      if (item.role === 'user') {
        if (typeof item.content === 'string') return item.content;
        if (Array.isArray(item.content)) {
          const text = item.content.filter(c => c.type === 'input_text').map(c => c.text).join(' ');
          if (text) return text;
        }
      }
    }
  }
  return null;
}

// ─── RAG pipelines: list available knowledge bases for an agent ──
app.get('/api/ai/rag-pipelines', (req, res) => {
  const agentKey = req.headers['x-agent-key'];
  if (!agentKey) {
    return res.status(400).json({ error: 'Missing x-agent-key header.' });
  }
  const agent = getAgentByAgentKey(agentKey);
  if (!agent) {
    return res.status(401).json({ error: 'Invalid agent key.' });
  }
  const pipelines = getReadyKnowledgeBaseSummaries(agent.id);
  res.json({ pipelines });
});

// ─── Proxy: OpenAI Responses API (agent-scoped with RAG) ────────
app.post('/api/ai/responses', async (req, res) => {
  const agentKey = req.headers['x-agent-key'];
  if (!agentKey) {
    return res.status(400).json({ error: 'Missing x-agent-key header. Pass your agent key to identify which agent to use.' });
  }

  const agent = getAgentByAgentKey(agentKey);
  if (!agent) {
    return res.status(401).json({ error: 'Invalid agent key.' });
  }

  try {
    const body = { ...req.body };
    const ragScope = body.rag;
    delete body.rag;

    // Backend is the source of truth — always use agent's model and instructions
    body.model = agent.model;
    body.instructions = [agent.system_prompt, BASE_SYSTEM_PROMPT]
      .filter(Boolean)
      .join('\n\n');

    // RAG augmentation: search this agent's knowledge bases
    let readyKbIds;
    if (ragScope === false) {
      readyKbIds = [];
    } else if (Array.isArray(ragScope)) {
      readyKbIds = getReadyKnowledgeBaseIdsByNames(agent.id, ragScope);
    } else {
      readyKbIds = getReadyKnowledgeBaseIds(agent.id);
    }
    if (readyKbIds.length > 0) {
      const userMessage = extractUserMessage(body.input);
      if (userMessage) {
        try {
          const [queryEmbedding] = await getEmbeddings([userMessage], agent.api_key);
          const chunks = searchSimilarChunks(queryEmbedding, 5, readyKbIds);

          if (chunks.length > 0) {
            const contextBlock = chunks.map(c => c.chunk_text).join('\n\n---\n\n');
            const ragContext = `Use the following knowledge base context to help answer the user's question. If the context is not relevant to the question, ignore it.\n\n${contextBlock}`;

            if (body.instructions) {
              body.instructions = ragContext + '\n\n' + body.instructions;
            } else {
              body.instructions = ragContext;
            }
          }
        } catch (ragErr) {
          console.error('RAG augmentation failed (continuing without):', ragErr.message);
        }
      }
    }

    const openaiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agent.api_key}`,
      },
      body: JSON.stringify(body),
    });

    const data = await openaiRes.json();

    // Log usage
    const model = body.model || 'unknown';
    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    logUsage(agent.id, model, inputTokens, outputTokens);

    if (!openaiRes.ok) {
      return res.status(openaiRes.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Failed to reach OpenAI', detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// AGENT CRUD API
// ═══════════════════════════════════════════════════════════════════

// List all agents
app.get('/api/agents', (_req, res) => {
  res.json(getAllAgents());
});

// Create agent
app.post('/api/agents', (req, res) => {
  const { name, apiKey, description, model, systemPrompt } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!apiKey || !apiKey.startsWith('sk-')) {
    return res.status(400).json({ error: 'Invalid API key format. Must start with sk-' });
  }
  const agent = createAgent(name.trim(), apiKey, {
    description: description || '',
    model: model || 'gpt-4o',
    systemPrompt: systemPrompt || '',
  });
  res.status(201).json(agent);
});

// Get single agent
app.get('/api/agents/:id', (req, res) => {
  const agent = getAgent(Number(req.params.id));
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

// Update agent
app.patch('/api/agents/:id', (req, res) => {
  const { name, description, apiKey, model, systemPrompt } = req.body;
  const agent = updateAgent(Number(req.params.id), { name, description, apiKey, model, systemPrompt });
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

// Delete agent
app.delete('/api/agents/:id', (req, res) => {
  deleteAgent(Number(req.params.id));
  res.json({ success: true });
});

// Regenerate agent key
app.post('/api/agents/:id/regenerate-key', (req, res) => {
  const agent = regenerateAgentKey(Number(req.params.id));
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

// Agent usage stats
app.get('/api/agents/:id/usage', (req, res) => {
  const days = Number(req.query?.days) || 7;
  res.json(getUsageStats(Number(req.params.id), days));
});

// Global usage stats
app.get('/api/usage', (req, res) => {
  const days = Number(req.query?.days) || 7;
  res.json(getUsageStats(null, days));
});

// ─── Knowledge base routes (nested under agents) ─────────────────
app.use(ragRoutes);

// ─── Start ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  AI Agent Builder running at http://localhost:${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`  Proxy:      POST http://localhost:${PORT}/api/ai/responses`);
  console.log(`  (pass x-agent-key header to identify agent)\n`);
});
