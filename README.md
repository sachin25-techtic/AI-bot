# AI Chatbot: Next.js + NestJS + Ollama (+ RAG over your documents)

A local chatbot built in two phases:

1. **Foundations (week 1).** A React chat UI talks to a NestJS API, which calls a local LLM through
   Ollama's **OpenAI-compatible API**. Replies stream word by word over **server-sent events**. A
   **"Summarise text"** button returns **schema-validated JSON** (title, summary, three keywords), and
   invalid JSON is retried. Timeouts, retries and an Ollama that isn't running all give friendly errors.
   **Chat history works like ChatGPT**: chats are saved in Postgres, listed in a sidebar, named by the
   LLM, and each one has its own URL.
2. **RAG (weeks 2–3).** Add PDFs, Word files or web pages. The app extracts the text, chunks it, embeds
   it with `nomic-embed-text`, stores it in pgvector, retrieves the relevant chunks for each question
   and answers with citations like `[1]` that show the document and page. If nothing relevant is
   found, it says so instead of making something up. Re-uploading a document replaces it, with no
   duplicate chunks.

Nothing leaves your machine (except when you add a web page by URL). The LLM, the embeddings and the database all run locally.

```
Browser (Next.js :3000)  ──HTTP/SSE──▶  NestJS API (:3001)  ──OpenAI-compatible API──▶  Ollama (:11434)
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
docker exec aibot-ollama ollama pull nomic-embed-text   # embedding model

# 3. Backend
cd backend
cp .env.example .env      # first time only
npm install
npm run start:dev         # http://localhost:3001/api
npm test                  # unit tests (summarise validation + retry)

# 4. Frontend (in a second terminal)
cd frontend
cp .env.example .env.local   # first time only
npm install
npm run dev               # http://localhost:3000
```

Postgres is mapped to host port **5433** so it doesn't clash with a local Postgres on 5432.
All settings (model, temperature, timeouts, relevance threshold) are in [backend/.env.example](backend/.env.example).

---

## Week 1: Foundations

| Topic | Where |
| --- | --- |
| #3 Calling the model through the OpenAI-compatible API | [ollama.service.ts](backend/src/ollama/ollama.service.ts): `POST /v1/chat/completions`, `/v1/embeddings` |
| #1 Temperature, context window | Temperature selector in the chat UI. The history cap is `MAX_HISTORY_MESSAGES` in [chat.service.ts](backend/src/chat/chat.service.ts) |
| #4 Streaming with server-sent events | [chat.controller.ts](backend/src/chat/chat.controller.ts) (sends) and `streamChat()` in [api.ts](frontend/src/lib/api.ts) (reads) |
| #5 Structured JSON + schema validation | [summary.schema.ts](backend/src/summarise/summary.schema.ts) and [summarise.service.ts](backend/src/summarise/summarise.service.ts) |
| #6 Timeouts, retries, model not running | `post()` / `postOnce()` in [ollama.service.ts](backend/src/ollama/ollama.service.ts), [ollama.errors.ts](backend/src/ollama/ollama.errors.ts), `GET /api/health` |

### Concepts in one paragraph each

- **Tokens.** Models read and write text as tokens: word pieces of about 4 characters in English.
  Limits and cost are counted in tokens. The reply streams to you token by token.
- **Context window.** The most tokens the model can see at once: system prompt + history + question + answer.
  The model is **stateless**: its "memory" is us re-sending the conversation every time. That's why
  history is capped at 20 messages, and why RAG sends only the few relevant chunks, not whole documents.
- **Temperature.** When the model picks the next token, temperature controls randomness. At 0 it
  always takes the most likely token (repeatable, good for facts and JSON). At 0.7 it varies its
  wording (natural for chat). Above 1 it gets creative but drifts. Try "What's a good name for a cat?"
  at 0 and at 1.5.
- **Hallucination.** The model predicts plausible text; it has no built-in notion of "true". With no
  facts in its context, it produces a fluent guess. RAG reduces this by putting the facts in the
  prompt, and the relevance threshold stops it from answering when there are no facts.

### What one chat message does

1. The browser sends `POST /api/chat {"conversationId": "...", "message": "What's my name?", "temperature": 0.7}`.
2. NestJS sends Ollama the **whole conversation**:
   ```json
   { "model": "llama3.2:3b", "stream": true, "temperature": 0.7, "messages": [
       { "role": "system",    "content": "You are a helpful, friendly assistant..." },
       { "role": "user",      "content": "Hi, I'm Sam" },
       { "role": "assistant", "content": "Hello Sam!" },
       { "role": "user",      "content": "What's my name?" } ] }
   ```
3. Ollama streams back SSE: `data: {"choices":[{"delta":{"content":"Your"}}]}` … `data: [DONE]`.
4. NestJS forwards each piece to the browser as its own SSE event:
   ```
   event: token
   data: {"content":"Your"}
   ```
   React appends it to the bubble.
5. When the reply is finished, NestJS saves the question and the answer to Postgres and sends `event: done`.
6. For a new chat it then asks the LLM for a short title and sends `event: title`.

### Chat history (like ChatGPT)

| Piece | Where |
| --- | --- |
| Tables `conversations` and `messages` | [database.service.ts](backend/src/database/database.service.ts) |
| Saving and loading chats | [conversation.store.ts](backend/src/chat/conversation.store.ts) |
| Sidebar API: list, open, rename, delete | [conversations.controller.ts](backend/src/chat/conversations.controller.ts) |
| AI-generated titles | `generateTitleIfNeeded()` in [chat.service.ts](backend/src/chat/chat.service.ts) |
| Sidebar UI: grouped by date, search, rename, delete | [ChatSidebar.tsx](frontend/src/components/ChatSidebar.tsx) |
| URLs `/` (new chat) and `/c/<id>` | [app/[[...slug]]/page.tsx](frontend/src/app/[[...slug]]/page.tsx), `openConversation()` in [Chat.tsx](frontend/src/components/Chat.tsx) |

- A chat is created by its first message. Until the first answer is saved, it's titled with the start of the question.
  The LLM then names it (structured output, validated like the summaries). A name you choose with rename is never overwritten.
- A question and its answer are saved together, in one transaction, only when the answer is complete.
  A stopped or failed turn is not saved. A chat whose very first answer failed is never listed, and it's cleaned up after a day.
- The model still sees only the last 20 messages (the context window), but the sidebar keeps everything.
- Switching chats while an answer is streaming cancels that answer, like pressing Stop.

### Structured output: the "Summarise text" button

`POST /api/summarise {"text": "..."}` → `{"summary": {"title", "summary", "keywords": [3]}, "attempts": 1}`

1. One [zod schema](backend/src/summarise/summary.schema.ts) is converted to JSON Schema and sent as
   `response_format: {type: "json_schema"}`. Ollama then constrains its output to that shape.
2. Constrained output is **not** guaranteed valid: it can be cut off, and some rules (like "the 3
   keywords must be different") can't be expressed in JSON Schema. So the reply is parsed and
   validated with the same zod schema.
3. If it's invalid, the model gets its bad reply plus the exact error and is asked again (3 attempts
   in total). After 3 failures the user gets a clean error, never broken JSON.

To watch the retry happen, set `SUMMARISE_DEBUG_BREAK_FIRST_ATTEMPT=true` in `backend/.env`. This cuts
the first reply in half, so the UI shows "valid JSON after 2 attempts" and the backend logs the
failure. The unit tests in [summarise.service.spec.ts](backend/src/summarise/summarise.service.spec.ts)
cover the same paths.

### When things go wrong

| Situation | What happens |
| --- | --- |
| Ollama not running | Retried twice (0.5 s, 1.5 s). Then: *"The AI model isn't reachable… Start it with docker compose up -d"*. A yellow banner also appears, from `GET /api/health`. |
| Model not downloaded | *"The model "x" isn't downloaded yet. Run: docker exec aibot-ollama ollama pull x"* |
| Ollama too slow to start answering | Times out after `OLLAMA_TIMEOUT_MS` (120 s, which allows for loading the model on CPU). |
| Stream stalls mid-answer | Times out after 30 s with no new token. |
| Ollama stops mid-answer | *"The connection to the AI model was lost while it was answering."* It is not retried, so you never see the same answer start over twice. |
| Backend not running | *"Can't reach the backend. Is it running?"* |

Try it: `docker stop aibot-ollama`, send a message, then `docker start aibot-ollama`.

---

## Weeks 2–3: RAG (Retrieval-Augmented Generation)

### RAG vs. fine-tuning vs. a longer prompt

- **Longer prompt** (paste the whole document): fine for a few pages, but it won't fit once you have
  10 PDFs. It is also slow, and small models lose details in long prompts.
- **Fine-tuning** (retrain the model on your documents): teaches style and format well, but it is bad
  at memorising facts reliably. It can't cite sources, and every document change means retraining.
- **RAG** (look up the relevant passages and put only those in the prompt): updating a document is
  just re-indexing it. Answers can cite the exact document and page, and "not found" is detectable.
  It's the right default for "chat with our documents".

### The pipeline

| Step | File |
| --- | --- |
| 1. Add a document: `POST /api/documents` (PDF/DOCX) or `POST /api/documents/url` | [documents.controller.ts](backend/src/documents/documents.controller.ts) |
| 2. Extract text: PDF per page, DOCX, web page (menus/footers stripped) | [pdf-text.ts](backend/src/documents/pdf-text.ts), [docx-text.ts](backend/src/documents/docx-text.ts), [web-text.ts](backend/src/documents/web-text.ts) |
| 3a. Split into ~1000-character chunks with 200 characters of overlap, cut at sentence breaks | [chunking.ts](backend/src/documents/chunking.ts) |
| 3b. Embed the chunks (`/v1/embeddings`, nomic-embed-text, 768 numbers each) | [ollama.service.ts](backend/src/ollama/ollama.service.ts) `embed()` |
| 4. Store in pgvector (replacing the old version if it's a re-upload) | [database.service.ts](backend/src/database/database.service.ts), [documents.service.ts](backend/src/documents/documents.service.ts) `ingest()` |
| 5. Retrieve the closest chunks and drop the irrelevant ones | [documents.service.ts](backend/src/documents/documents.service.ts) `search()`, [chat.service.ts](backend/src/chat/chat.service.ts) `retrieve()` |
| 6. Build the prompt with numbered sources, answer and cite | [chat.service.ts](backend/src/chat/chat.service.ts) `buildRagPrompt()`, [MessageBubble.tsx](frontend/src/components/MessageBubble.tsx) |

### From question to answer (the whiteboard version)

```
question ──embed──▶ query vector ──pgvector: ORDER BY embedding <=> query LIMIT 5──▶ 5 closest chunks
     │
     ├─ drop chunks scoring below RAG_MIN_SCORE (0.6) or far below the best match
     │
     ├─ none left? ──▶ "I couldn't find that in the uploaded documents."   (the LLM is never called)
     │
     └─ else ──▶ prompt = rules + "[1] (handbook.pdf, page 2) <chunk text>" + … + question
                     ──LLM (temperature 0.1)──▶ "Employees get 27 days [1]." ──UI──▶ [1] → handbook.pdf · page 2
```

An **embedding** is a list of numbers that represents a text's meaning. Texts about similar things
get vectors pointing in similar directions. That's how "How much holiday do I get?" finds a chunk
about "27 days of paid annual leave" even though they share almost no words.

**Why a minimum score?** pgvector always returns the 5 *closest* chunks, even for "What is the capital
of France?". Measured on the sample documents, questions the documents answer scored **0.70–0.83**,
and unrelated questions scored at most **0.51**. So chunks below 0.6 are treated as "nothing relevant",
and the app answers "not found" without asking the model at all. Tune `RAG_MIN_SCORE` if you change
the embedding model or your documents.

### Re-uploading a changed document

Documents are identified by **file name** (uploads) or **URL** (web pages), and fingerprinted by a
SHA-256 hash of their extracted text:

- Same name, same text: `unchanged`. Nothing is done, and the slow embedding step is skipped.
- Same name, different text: `updated`. The old chunks are deleted and the new ones inserted **in one
  transaction**, keeping the same document id. Nobody ever sees a half-indexed document or duplicate chunks.
- New name: `created`.

### Page numbers

PDFs keep a page number per chunk, so citations say "handbook.pdf · page 2". Word files store
paragraphs, not pages (Word decides the pages when it lays the document out), and web pages have no
pages either, so their citations show the document name (and a link for web pages).

### Things to experiment with

- **Chunk size and overlap** (`chunkText()`): smaller chunks give more precise matches but less context.
- **`RETRIEVAL_TOP_K`, `MAX_SCORE_GAP_FROM_BEST`, `RAG_MIN_SCORE`**: how many chunks reach the model.
- **A bigger chat model** (e.g. `llama3.1:8b`, `qwen2.5:7b`): the 3B default is fast on CPU but sometimes
  cites the wrong number. Larger models follow the citation rules more reliably.
- **Follow-up questions**: retrieval uses only the latest message, so "and how long is it?" may retrieve
  poorly. A common fix is to have the LLM rewrite the question into a standalone one before retrieving.

## Limitations (kept simple on purpose)

- One shared chat history: there are no user accounts, so everyone using this backend sees the same chats.
- Scanned PDFs have no text layer and would need OCR first.
- Adding a document embeds it before responding, so very large documents make the request slow.
  A real app would process uploads in a background job.
- There is no authentication: every user sees every document.
- Adding a URL makes the backend download that address. That's fine on your own machine, but on a
  shared server you would block internal addresses (SSRF protection).

## API reference

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/api/chat` | `{ message, conversationId?, useDocuments?, temperature? }` → SSE stream of `meta`, `sources`, `token`, `done`, `title` / `error` events. Omit `conversationId` to start a new chat |
| GET | `/api/conversations` | Saved chats, most recent first: `[{ id, title, createdAt, updatedAt }]` |
| GET | `/api/conversations/:id` | One chat with its `messages` (including the `sources` of RAG answers) |
| PATCH | `/api/conversations/:id` | `{ title }`: rename |
| DELETE | `/api/conversations/:id` | Delete a chat and its messages |
| POST | `/api/summarise` | `{ text }` (50–20,000 chars) → `{ summary: { title, summary, keywords[3] }, attempts }` |
| GET | `/api/health` | `{ ok, problems[], ollama, database, models }` |
| POST | `/api/documents` | multipart `file` (PDF or DOCX, max 25 MB) → document + `status`: `created` / `updated` / `unchanged` |
| POST | `/api/documents/url` | `{ url }` → same as above |
| GET | `/api/documents` | List documents |
| DELETE | `/api/documents/:id` | Delete a document and its chunks |
