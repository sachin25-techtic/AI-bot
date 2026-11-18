# AI Chatbot: Next.js + NestJS + Ollama + RAG

A local AI chatbot. The LLM, the embeddings and the database all run on your machine.

- **Streaming chat** through Ollama's OpenAI-compatible API, sent to the browser over server-sent events (SSE), with a temperature control
- **Chat history like ChatGPT**: saved chats in a sidebar, AI-generated titles, rename, delete and search, and a URL per chat (`/c/<id>`)
- **Summarise text**: returns JSON (title, summary, 3 keywords) validated against a schema, and retried if the model's output is invalid
- **Chat with your documents (RAG)**: PDF, DOCX and web pages, with citations showing the document and page, a "not found" answer when nothing relevant is found, and re-uploads that replace the old version instead of duplicating it
- **Clear errors**: timeouts, retries, and a friendly message when Ollama isn't running

```
Browser (Next.js :3000) ──SSE──▶ NestJS API (:3001) ──▶ Ollama (:11434)
                                       └──▶ Postgres + pgvector (:5433)
```

## Running it

Prerequisites: Node 20+ and Docker.

```bash
docker compose up -d                                    # Ollama + Postgres
docker exec aibot-ollama ollama pull llama3.2:3b        # chat model (one time)
docker exec aibot-ollama ollama pull nomic-embed-text   # embedding model (one time)

cd backend && cp .env.example .env && npm install && npm run start:dev   # http://localhost:3001/api
# in a second terminal, from the project root:
cd frontend && cp .env.example .env.local && npm install && npm run dev  # http://localhost:3000
```

Run the backend tests with `npm test` in `backend/`. All settings (model, temperature, timeouts, `RAG_MIN_SCORE`) are in [backend/.env.example](backend/.env.example).

## How RAG answers a question

```
question ──embed──▶ pgvector: 5 closest chunks
   ├─ drop chunks scoring below 0.6
   ├─ none left? ──▶ "I couldn't find that in the uploaded documents." (no LLM call)
   └─ else ──▶ prompt with numbered sources ──LLM──▶ "Employees get 27 days [1]." ──▶ [1] = handbook.pdf · page 2
```

On upload, the text is extracted, split into chunks of about 1000 characters with a 200-character overlap, embedded and stored in pgvector.
A re-upload with the same name replaces the old chunks. If the text hasn't changed, it is skipped.

## Project structure

| Area | Files |
| --- | --- |
| LLM calls, retries, timeouts | [ollama.service.ts](backend/src/ollama/ollama.service.ts), [ollama.errors.ts](backend/src/ollama/ollama.errors.ts) |
| Chat, RAG prompt, titles | [chat.service.ts](backend/src/chat/chat.service.ts), [chat.controller.ts](backend/src/chat/chat.controller.ts) |
| Chat history | [conversation.store.ts](backend/src/chat/conversation.store.ts), [conversations.controller.ts](backend/src/chat/conversations.controller.ts) |
| Documents | [documents.service.ts](backend/src/documents/documents.service.ts), [chunking.ts](backend/src/documents/chunking.ts), [pdf-text.ts](backend/src/documents/pdf-text.ts), [docx-text.ts](backend/src/documents/docx-text.ts), [web-text.ts](backend/src/documents/web-text.ts) |
| Summarise | [summary.schema.ts](backend/src/summarise/summary.schema.ts), [summarise.service.ts](backend/src/summarise/summarise.service.ts) |
| Database schema | [database.service.ts](backend/src/database/database.service.ts) |
| Frontend | [Chat.tsx](frontend/src/components/Chat.tsx), [ChatSidebar.tsx](frontend/src/components/ChatSidebar.tsx), [DocumentsPanel.tsx](frontend/src/components/DocumentsPanel.tsx), [api.ts](frontend/src/lib/api.ts) |

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/chat` | `{ message, conversationId?, useDocuments?, temperature? }` → SSE stream |
| GET / PATCH / DELETE | `/api/conversations[/:id]` | List, open, rename and delete chats |
| POST | `/api/summarise` | `{ text }` → `{ summary: { title, summary, keywords }, attempts }` |
| POST | `/api/documents` | Upload a PDF or DOCX (max 25 MB) |
| POST | `/api/documents/url` | `{ url }`: add a web page |
| GET / DELETE | `/api/documents[/:id]` | List and delete documents |
| GET | `/api/health` | Status of Ollama, the models and the database |

