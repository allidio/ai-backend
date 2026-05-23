import {
  insertChunk,
  insertChunkEmbedding,
  updateKnowledgeBaseStatus,
} from './rag-db.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100; // OpenAI allows up to 2048, but 100 is practical

// ─── Chunking ───────────────────────────────────────────────────

function chunkCSV(csvString) {
  const lines = csvString.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);
  const chunks = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === 0 || (values.length === 1 && !values[0])) continue;

    const metadata = {};
    const parts = [];
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j].trim();
      const val = (values[j] || '').trim();
      if (key && val) {
        metadata[key] = val;
        parts.push(`${key}: ${val}`);
      }
    }

    if (parts.length > 0) {
      chunks.push({ text: parts.join(', '), metadata });
    }
  }

  return chunks;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function chunkJSON(jsonArray) {
  if (!Array.isArray(jsonArray)) return [];

  return jsonArray
    .filter(obj => obj && typeof obj === 'object')
    .map(obj => {
      const parts = [];
      for (const [key, val] of Object.entries(obj)) {
        if (val !== null && val !== undefined && val !== '') {
          parts.push(`${key}: ${val}`);
        }
      }
      return { text: parts.join(', '), metadata: obj };
    })
    .filter(c => c.text.length > 0);
}

// ─── Embedding API ──────────────────────────────────────────────

async function getEmbeddings(texts, apiKey) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API error: ${response.status} ${err}`);
  }

  const data = await response.json();
  // Sort by index to ensure order matches input
  return data.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

// ─── Indexing orchestrator ──────────────────────────────────────

async function indexKnowledgeBase(kbId, rawData, fileType, apiKey) {
  try {
    // Parse into chunks
    let chunks;
    if (fileType === 'csv') {
      chunks = chunkCSV(rawData);
    } else {
      const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
      chunks = chunkJSON(parsed);
    }

    if (chunks.length === 0) {
      updateKnowledgeBaseStatus(kbId, 'error', { errorMessage: 'No data found in file' });
      return;
    }

    if (!apiKey) {
      updateKnowledgeBaseStatus(kbId, 'error', { errorMessage: 'No API key provided for embeddings' });
      return;
    }

    updateKnowledgeBaseStatus(kbId, 'indexing', { totalChunks: chunks.length, indexedChunks: 0 });

    // Process in batches
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map(c => c.text);

      // Insert chunk text rows first
      const chunkIds = batch.map(c => insertChunk(kbId, c.text, c.metadata));

      // Get embeddings for the batch
      const embeddings = await getEmbeddings(texts, apiKey);

      // Insert embeddings
      for (let j = 0; j < chunkIds.length; j++) {
        insertChunkEmbedding(chunkIds[j], embeddings[j]);
      }

      updateKnowledgeBaseStatus(kbId, 'indexing', { indexedChunks: Math.min(i + BATCH_SIZE, chunks.length) });
    }

    updateKnowledgeBaseStatus(kbId, 'ready', { indexedChunks: chunks.length });
    console.log(`Knowledge base ${kbId} indexed: ${chunks.length} chunks`);
  } catch (err) {
    console.error(`Indexing error for KB ${kbId}:`, err.message);
    updateKnowledgeBaseStatus(kbId, 'error', { errorMessage: err.message });
  }
}

export { chunkCSV, chunkJSON, getEmbeddings, indexKnowledgeBase };
