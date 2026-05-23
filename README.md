# AI Backend — Agent Management & RAG Platform

**Production-ready backend platform for managing AI agents, knowledge bases, and LLM inference.** Powers the Screen Pilot embeddable AI assistant with agent validation, RAG vector search, OpenAI proxy, and usage analytics.

## Features

- 🤖 **Agent Management** — CRUD operations, API keys, model configuration
- 📚 **RAG Pipeline** — CSV/JSON ingestion, vector embeddings, semantic search (sqlite-vec)
- 🔑 **Multi-Agent Support** — Each agent has its own API key, model config, and knowledge bases
- 🧠 **OpenAI Proxy** — Forward to OpenAI Responses API with server-side key management
- 📊 **Usage Analytics** — Token counting, daily reports, per-agent statistics
- 🗄️ **SQLite + Vectors** — Embedded database with vector extension for scaling
- 🛡️ **Security** — Server-side key enforcement, agent validation, RAG injection
- 📡 **RESTful API** — Standard HTTP endpoints for all operations
- 💻 **Dashboard** — Web UI for agent creation, KB upload, analytics

## Quick Start

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your OpenAI API key

# Start server
npm start

# Server runs on http://localhost:3456
# Dashboard: http://localhost:3456/dashboard
```

## Environment Variables

```env
# OpenAI
OPENAI_API_KEY=sk-...

# Server
PORT=3456
NODE_ENV=development

# Database
DB_PATH=./data/screen-pilot.db

# Optional: CORS
CORS_ORIGIN=*
```

## API Endpoints

### Chat / Inference

#### `POST /api/ai/responses`

Main endpoint for chat messages and tool execution.

**Headers:**
```
x-agent-key: agent_abc123
```

**Body:**
```json
{
  "input": "Help me find a moisturizer for dry skin",
  "tools": [/* tool definitions sent from frontend */],
  "previous_response_id": "resp_xyz"  // optional, for multi-turn
}
```

**Response:**
```json
{
  "id": "resp_123",
  "content": [
    {
      "type": "function_call",
      "name": "show_recommended_products",
      "id": "call_456",
      "arguments": "{\"sku_ids\": [\"123\", \"456\"]}"
    }
  ]
}
```

### Agents

#### `POST /api/agents`
Create a new agent.

**Body:**
```json
{
  "name": "Sephora Assistant",
  "description": "AI assistant for Sephora e-commerce",
  "model": "gpt-4o",
  "api_key": "sk-...",
  "system_prompt": "You are a helpful beauty consultant..."
}
```

**Response:**
```json
{
  "id": 1,
  "agent_key": "agent_abc123",
  "key_preview": "agent_abc...xyz",
  "created_at": "2025-01-15T10:30:00Z"
}
```

#### `GET /api/agents/:id`
Get agent details.

#### `PUT /api/agents/:id`
Update agent configuration.

#### `DELETE /api/agents/:id`
Delete agent.

### Knowledge Bases

#### `POST /api/agents/:agent_id/knowledge-bases`
Create a knowledge base for an agent.

**Body:**
```json
{
  "name": "Product Catalog",
  "description": "All Sephora products",
  "file_name": "products.csv"
}
```

#### `POST /api/agents/:agent_id/upload`
Upload and index a CSV or JSON file.

**Form Data:**
```
file: <multipart file>
kb_id: <knowledge_base_id>
```

**Response:**
```json
{
  "status": "indexing",
  "message": "Knowledge base indexing started. Check back later for completion."
}
```

#### `GET /api/agents/:agent_id/knowledge-bases`
List all knowledge bases for an agent.

#### `GET /api/agents/:agent_id/knowledge-bases/:kb_id/status`
Get indexing status.

**Response:**
```json
{
  "id": 1,
  "status": "ready",
  "total_chunks": 2847,
  "indexed_chunks": 2847,
  "created_at": "2025-01-15T10:00:00Z"
}
```

### Analytics

#### `GET /api/agents/:agent_id/usage`
Get usage statistics for an agent.

**Query params:**
- `days` — Number of days to report (default: 7)

**Response:**
```json
{
  "agent_id": 1,
  "summary": {
    "total_requests": 542,
    "total_input_tokens": 125000,
    "total_output_tokens": 87000,
    "average_tokens_per_request": 399
  },
  "daily": [
    {
      "date": "2025-01-15",
      "requests": 100,
      "input_tokens": 25000,
      "output_tokens": 17000
    }
  ]
}
```

## Database Schema

```sql
-- Agents
CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  agent_key TEXT UNIQUE NOT NULL,
  api_key TEXT NOT NULL,
  key_preview TEXT,
  model TEXT DEFAULT 'gpt-4o',
  system_prompt TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Knowledge Bases
CREATE TABLE knowledge_bases (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  file_name TEXT,
  status TEXT DEFAULT 'pending', -- pending, indexing, ready
  total_chunks INTEGER,
  indexed_chunks INTEGER,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Knowledge Base Chunks
CREATE TABLE kb_chunks (
  id INTEGER PRIMARY KEY,
  kb_id INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  metadata JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id)
);

-- Vector embeddings (sqlite-vec virtual table)
CREATE VIRTUAL TABLE kb_chunks_vec USING vec0(
  embedding float[1536]
);

-- Usage Log
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
```

## RAG Pipeline

### Ingestion

1. **Upload CSV/JSON** via dashboard or `/api/agents/:id/upload`
2. **Parse & Chunk** — Each row (CSV) or object (JSON) becomes a chunk
3. **Batch Embed** — Groups of 100 chunks → OpenAI text-embedding-3-small API
4. **Store Vectors** — Embeddings saved in sqlite-vec virtual table
5. **Status Update** — KB marked as "ready" when complete

### Query Time

1. **Receive message** from frontend with agent_key
2. **Embed query** using same embedding model
3. **Vector search** — sqlite-vec cosine similarity, top 5 chunks
4. **Augment prompt** — Inject RAG context into system prompt
5. **Forward to OpenAI** — With enriched context
6. **Log usage** — Token counts per agent

### Configuration

```javascript
// Default embedding model (can be overridden per agent)
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;

// Batch size for embeddings
const EMBEDDING_BATCH_SIZE = 100;

// RAG settings
const RAG_TOP_K = 5;  // Number of chunks to retrieve
const RAG_SIMILARITY_THRESHOLD = 0.5;  // Min cosine similarity
```

## Knowledge Base File Format

### CSV

```csv
brand,name,price,category,description
Sephora,Hydrating Cream,29.99,Skincare,Moisturizes dry skin
Clinique,Moisture Surge,42.00,Skincare,Lightweight gel moisturizer
```

Each row becomes one searchable chunk.

### JSON

```json
[
  {
    "id": "prod_001",
    "brand": "Sephora",
    "name": "Hydrating Cream",
    "price": 29.99,
    "category": "Skincare",
    "description": "Moisturizes dry skin"
  }
]
```

Each object becomes one searchable chunk.

## Security

- ✅ **API Key Server-Side** — Backend holds OpenAI keys, never sent to frontend
- ✅ **Agent Key Auth** — Every request validated via x-agent-key header
- ✅ **No Key Exposure** — Dashboard shows masked keys (key_preview)
- ✅ **RAG Context Injection** — Server-side only, frontend cannot override
- ✅ **Model Enforcement** — LLM model chosen by agent config, frontend cannot override
- ✅ **System Prompt Protection** — Agent system_prompt enforced server-side

## Deployment

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3456
CMD ["npm", "start"]
```

```bash
docker build -t ai-backend .
docker run -p 3456:3456 -e OPENAI_API_KEY=sk-... ai-backend
```

### Environment

- **Local Development** — `npm start` (port 3456)
- **Production** — Deploy to Heroku, AWS EC2, Railway, DigitalOcean, etc.
- **Database** — SQLite for small-to-medium, PostgreSQL + pgvector for scale

## Performance

| Operation | Time |
|-----------|------|
| Agent validation | <10ms |
| Vector search (1536-dim, ~10k chunks) | ~50ms |
| OpenAI API call | 500ms - 2s (depends on response) |
| CSV ingestion (1000 rows) | ~5s (parallel embedding) |

## Monitoring

Check `/health` endpoint:

```bash
curl http://localhost:3456/health
```

Response:
```json
{
  "status": "ok",
  "uptime": 3600,
  "agents": 5,
  "knowledge_bases": 12,
  "database": "healthy"
}
```

## License

MIT — See LICENSE file

## Contributing

We welcome contributions! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit changes (`git commit -m "Add feature"`)
4. Push to branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## Support

- 📖 **API Docs** — [See PRESENTATION.md](https://github.com/allidio/screen-pilot)
- 🐛 **Issues** — Report bugs [here](https://github.com/allidio/ai-backend/issues)
- 💬 **Discussions** — Ask questions [here](https://github.com/allidio/ai-backend/discussions)

---

**Screen Pilot** — Give your web application an AI that can see, understand, and act.
