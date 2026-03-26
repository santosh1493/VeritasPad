import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATA_DIR = path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "notes.json");
const PUBLIC_DIR = path.join(process.cwd(), "public");

const state = {
  notes: new Map(),
  globalVersion: 0,
  clients: new Set(),
  appliedOps: new Set(),
};

async function ensureStorage() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    await writeFile(DB_FILE, JSON.stringify({ globalVersion: 0, notes: [] }, null, 2));
  }
  const raw = await readFile(DB_FILE, "utf8");
  const parsed = JSON.parse(raw);
  state.globalVersion = parsed.globalVersion ?? 0;
  for (const note of parsed.notes ?? []) {
    state.notes.set(note.id, note);
  }
}

async function persist() {
  const payload = {
    globalVersion: state.globalVersion,
    notes: [...state.notes.values()],
  };
  await writeFile(DB_FILE, JSON.stringify(payload, null, 2));
}

function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const txt = Buffer.concat(chunks).toString("utf8");
  return txt ? JSON.parse(txt) : {};
}

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of state.clients) client.write(line);
}

function getNote(id) {
  if (!state.notes.has(id)) {
    state.notes.set(id, {
      id,
      title: id,
      content: "",
      version: 0,
      updatedAt: new Date().toISOString(),
      updatedBy: "system",
    });
  }
  return state.notes.get(id);
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

async function serveStatic(req, res) {
  const incoming = req.url === "/" ? "/index.html" : req.url;
  const normalized = path.normalize(incoming).replace(/^\.+/, "");
  const full = path.join(PUBLIC_DIR, normalized);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const file = await readFile(full);
    res.writeHead(200, { "Content-Type": contentType(full) });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

await ensureStorage();

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) return json(res, 400, { error: "bad request" });

  if (req.url === "/api/snapshot" && req.method === "GET") {
    return json(res, 200, {
      globalVersion: state.globalVersion,
      notes: [...state.notes.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    });
  }

  if (req.url === "/api/stream" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-store",
    });
    res.write(`data: ${JSON.stringify({ type: "hello", globalVersion: state.globalVersion })}\n\n`);
    state.clients.add(res);
    req.on("close", () => state.clients.delete(res));
    return;
  }

  if (req.url.startsWith("/api/notes/") && req.method === "PUT") {
    const id = decodeURIComponent(req.url.split("/").pop());
    const payload = await parseBody(req);
    const opId = payload.opId || randomUUID();

    if (state.appliedOps.has(opId)) {
      return json(res, 200, { ok: true, deduped: true, note: getNote(id) });
    }

    const note = getNote(id);
    if (payload.baseVersion !== note.version) {
      return json(res, 409, {
        error: "version_conflict",
        note,
      });
    }

    const next = {
      ...note,
      title: payload.title ?? note.title,
      content: payload.content ?? note.content,
      version: note.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: payload.clientId ?? "unknown",
    };
    state.notes.set(id, next);
    state.globalVersion += 1;
    state.appliedOps.add(opId);
    if (state.appliedOps.size > 10000) {
      state.appliedOps = new Set([...state.appliedOps].slice(-5000));
    }
    await persist();
    const event = { type: "note_updated", note: next, globalVersion: state.globalVersion, opId };
    broadcast(event);
    return json(res, 200, { ok: true, note: next, globalVersion: state.globalVersion });
  }

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`VeritasPad listening on http://localhost:${PORT}`);
});
