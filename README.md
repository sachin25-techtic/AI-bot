# AI Chatbot: Next.js + NestJS + Ollama (+ RAG over PDFs)

A local chatbot built in two phases:

1. **Basic chatbot.** A React chat UI talks to a NestJS API, which talks to a local LLM in Ollama. Replies stream in token by token, and the conversation history is kept.
2. **RAG.** Upload PDFs. The app extracts the text, splits it into chunks, embeds the chunks, stores them in pgvector, retrieves the relevant ones for each question, and answers with citations like `[1]` that link to the file and page.

Nothing leaves your machine. The LLM, the embeddings and the database all run locally.

```
Browser (Next.js :3000)  ──HTTP──▶  NestJS API (:3001)  ──HTTP──▶  Ollama (:11434)
                                          │
                                          └──SQL──▶  Postgres + pgvector (:5433)
```

## Running it

Prerequisites: Node 20+ and Docker.

```bash
# 1. Start Ollama and Postgres (pgvector)
docker compose up -d

# 2. Download the models (one time, about 2.3 GB)
docker exec aibot-ollama ollama pull llama3.2:3b        # chat model
docker exec aibot-ollama ollama pull nomic-embed-text   # embedding model (phase 2)

# 3. Backend
cd backend
cp .env.example .env      # first time only
npm install
npm run start:dev         # http://localhost:3001/api

# 4. Frontend (in a second terminal)
cd frontend
cp .env.example .env.local   # first time only
npm install
npm run dev               # http://localhost:3000
```

Postgres is mapped to host port **5433** so it doesn't clash with a local Postgres on 5432.
To use a different model, pull it and change `OLLAMA_CHAT_MODEL` in `backend/.env`.

---

## Phase 1: how the app talks to the LLM

| File | Role |
| --- | --- |
| [backend/src/ollama/ollama.service.ts](backend/src/ollama/ollama.service.ts) | The **only** code that calls the LLM. A `fetch` POST to Ollama's `/api/chat`. |
| [backend/src/chat/chat.service.ts](backend/src/chat/chat.service.ts) | Builds the message list (system prompt + history + new message) and saves each turn. |
| [backend/src/chat/conversation.store.ts](backend/src/chat/conversation.store.ts) | In-memory history per conversation id. |
| [backend/src/chat/chat.controller.ts](backend/src/chat/chat.controller.ts) | `POST /api/chat`: streams the reply to the browser. |
| [frontend/src/lib/api.ts](frontend/src/lib/api.ts) | Browser side: sends the message and reads the stream. |
| [frontend/src/components/Chat.tsx](frontend/src/components/Chat.tsx) | Chat UI. |

### What one message does

1. You type "What's my name?" and the browser sends
   `POST /api/chat {"conversationId": "...", "message": "What's my name?"}`.
2. NestJS looks up that conversation's history and sends Ollama **the whole conversation**:
   ```json
   { "model": "llama3.2:3b", "stream": true, "messages": [
       { "role": "system",    "content": "You are a helpful, friendly assistant..." },
       { "role": "user",      "content": "Hi, I'm Sam" },
       { "role": "assistant", "content": "Hello Sam!" },
       { "role": "user",      "content": "What's my name?" } ] }
   ```
3. Ollama streams back NDJSON, one JSON object per generated piece of text:
   `{"message":{"content":"Your"},"done":false}` …
4. NestJS forwards each piece to the browser as `{"type":"token","content":"Your"}`, and React appends it to the bubble.
5. When the reply is finished, NestJS saves both the question and the answer to the history.

**Key idea: the model is stateless.** It has no memory between requests. The "memory" is the
app re-sending the history every time. That is also why history is capped
(`MAX_HISTORY_MESSAGES`): every model has a limited context window.

Try it without the UI:

```bash
curl -N localhost:3001/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"Hi, I am Sam"}'
# copy the conversationId from the first line, then:
curl -N localhost:3001/api/chat -H 'Content-Type: application/json' \
  -d '{"conversationId":"<id>","message":"What is my name?"}'
```

You can also call Ollama directly to see the raw API the backend wraps:

```bash
curl localhost:11434/api/chat -d '{"model":"llama3.2:3b","stream":false,
  "messages":[{"role":"user","content":"Say hi"}]}'
```

---

## Phase 2: RAG (Retrieval-Augmented Generation)

| Step | File |
| --- | --- |
| 1. Upload a PDF (`POST /api/documents`) | [documents.controller.ts](backend/src/documents/documents.controller.ts) |
| 2. Extract the text of each page | [pdf-text.ts](backend/src/documents/pdf-text.ts) |
| 3a. Split into ~1000-character chunks with overlap | [chunking.ts](backend/src/documents/chunking.ts) |
| 3b. Embed the chunks (Ollama `/api/embed`) | [ollama.service.ts](backend/src/ollama/ollama.service.ts) `embed()` |
| 4. Store them in pgvector | [database.service.ts](backend/src/database/database.service.ts) (schema), [documents.service.ts](backend/src/documents/documents.service.ts) `ingest()` |
| 5. Retrieve relevant chunks | [documents.service.ts](backend/src/documents/documents.service.ts) `search()` |
| 6. Generate an answer with citations | [chat.service.ts](backend/src/chat/chat.service.ts) `buildRagPrompt()` + [MessageBubble.tsx](frontend/src/components/MessageBubble.tsx) |

### Ingestion (on upload)

```
PDF ─▶ text per page ─▶ chunks (each keeps its page number) ─▶ embeddings (768 numbers each) ─▶ rows in `chunks` table
```

An **embedding** is a list of numbers that represents a text's meaning. Texts about similar
things get vectors that point in similar directions. That's what lets search work by meaning:
"How much holiday do I get?" finds a chunk about "27 days of paid annual leave" even though
the two share almost no words.

### Answering (with "Answer from my PDFs" on)

1. Embed the question with the same embedding model.
2. Ask Postgres for the closest chunks:
   ```sql
   SELECT ..., 1 - (embedding <=> $1) AS score   -- <=> is cosine distance
   FROM chunks ORDER BY embedding <=> $1 LIMIT 5;
   ```
3. Drop chunks that score far below the best match (`MAX_SCORE_GAP_FROM_BEST`).
4. Paste the chunks into the prompt as numbered sources and ask the model to cite them:
   ```
   Sources:
   [1] (handbook.pdf, page 2)
   Full-time employees receive 27 days of paid annual leave...
   ---
   Question: How much leave do I get?
   Answer using only the sources above. After each sentence, cite the source...
   ```
5. Stream the answer. The backend first sends `{"type":"sources", ...}`, so the UI can turn each `[n]` into a link to its source card (file, page, match score, and the chunk text).

That's all RAG is: **the model only "knows" your PDF because the relevant parts were put in its prompt.**

### Things to experiment with

- **Chunk size and overlap** (`chunkText()`): smaller chunks give more precise matches but less context.
- **`RETRIEVAL_TOP_K` / `MAX_SCORE_GAP_FROM_BEST`**: how many chunks reach the model.
- **A bigger chat model** (e.g. `llama3.1:8b`, `qwen2.5:7b`): the 3B default is fast on CPU but sometimes
  cites the wrong number or rambles. Larger models follow the citation rules more reliably.
- **Follow-up questions**: retrieval uses only the latest message, so "and how long is it?" may retrieve
  poorly. A common fix is to have the LLM rewrite the question into a standalone one before retrieving.

## Limitations (kept simple on purpose)

- Conversation history is stored in memory and lost when the backend restarts. Documents persist in Postgres.
- Scanned PDFs have no text layer, so they would need OCR first.
- Uploading embeds the whole PDF before responding, so very large PDFs make the request slow.
  A real app would process uploads in a background job.
- There is no authentication: every user sees every document.

## API reference

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/api/chat` | `{ message, conversationId?, useDocuments? }` → NDJSON stream of `meta`, `sources`, `token`, `done` / `error` events |
| GET | `/api/chat/:conversationId` | Stored history |
| DELETE | `/api/chat/:conversationId` | Forget a conversation |
| POST | `/api/documents` | multipart `file` (PDF, max 25 MB) |
| GET | `/api/documents` | List uploaded PDFs |
| DELETE | `/api/documents/:id` | Delete a PDF and its chunks |
