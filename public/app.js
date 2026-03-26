const byId = (id) => document.getElementById(id);
const ui = {
  notes: byId("notes"),
  title: byId("title"),
  content: byId("content"),
  newBtn: byId("new-note"),
  networkStatus: byId("network-status"),
  syncStatus: byId("sync-status"),
  noteTemplate: byId("note-item"),
};

const state = {
  clientId: localStorage.getItem("clientId") || crypto.randomUUID(),
  activeId: null,
  notes: new Map(),
  outbox: [],
  flushInFlight: false,
};
localStorage.setItem("clientId", state.clientId);

const DB_NAME = "veritaspad";
let db;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("notes", { keyPath: "id" });
      d.createObjectStore("outbox", { keyPath: "opId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

async function dbPut(store, value) {
  return new Promise((resolve, reject) => {
    const req = tx(store, "readwrite").put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store, "readwrite").delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbAll(store) {
  return new Promise((resolve, reject) => {
    const req = tx(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function render() {
  ui.notes.innerHTML = "";
  const list = [...state.notes.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const note of list) {
    const node = ui.noteTemplate.content.firstElementChild.cloneNode(true);
    node.textContent = `${note.title || "Untitled"} (v${note.version})`;
    if (note.id === state.activeId) node.classList.add("active");
    node.addEventListener("click", () => setActive(note.id));
    ui.notes.append(node);
  }
  const active = state.notes.get(state.activeId);
  ui.title.value = active?.title ?? "";
  ui.content.value = active?.content ?? "";
  ui.syncStatus.textContent = `${state.outbox.length} queued`;
}

function setActive(id) {
  state.activeId = id;
  render();
}

async function createNote() {
  const id = crypto.randomUUID();
  const note = {
    id,
    title: "Untitled",
    content: "",
    version: 0,
    updatedAt: new Date().toISOString(),
    updatedBy: state.clientId,
  };
  state.notes.set(id, note);
  await dbPut("notes", note);
  setActive(id);
}

function scheduleSave() {
  clearTimeout(scheduleSave.timer);
  scheduleSave.timer = setTimeout(saveActiveNote, 250);
}

async function enqueueOperation(note) {
  const op = {
    opId: crypto.randomUUID(),
    noteId: note.id,
    baseVersion: note.version,
    title: note.title,
    content: note.content,
    clientId: state.clientId,
    createdAt: new Date().toISOString(),
  };
  state.outbox.push(op);
  await dbPut("outbox", op);
  render();
  flushOutbox();
}

async function saveActiveNote() {
  const note = state.notes.get(state.activeId);
  if (!note) return;
  note.title = ui.title.value || "Untitled";
  note.content = ui.content.value;
  note.updatedAt = new Date().toISOString();
  state.notes.set(note.id, note);
  await dbPut("notes", note);
  await enqueueOperation({ ...note });
  render();
}

function mergeConflict(localOp, remoteNote) {
  return {
    ...remoteNote,
    title: `${localOp.title} (conflict)` ,
    content: `${remoteNote.content}\n\n<<<< LOCAL UNSYNCED >>>>\n${localOp.content}`,
  };
}

async function flushOutbox() {
  if (state.flushInFlight || !navigator.onLine || state.outbox.length === 0) return;
  state.flushInFlight = true;
  try {
    while (state.outbox.length && navigator.onLine) {
      const op = state.outbox[0];
      const res = await fetch(`/api/notes/${encodeURIComponent(op.noteId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(op),
      });
      if (res.status === 409) {
        const payload = await res.json();
        const merged = mergeConflict(op, payload.note);
        state.notes.set(merged.id, merged);
        await dbPut("notes", merged);
        state.outbox[0] = {
          ...op,
          baseVersion: payload.note.version,
          title: merged.title,
          content: merged.content,
        };
        await dbPut("outbox", state.outbox[0]);
        continue;
      }
      if (!res.ok) break;
      const payload = await res.json();
      state.notes.set(payload.note.id, payload.note);
      await dbPut("notes", payload.note);
      state.outbox.shift();
      await dbDelete("outbox", op.opId);
    }
  } catch {
    // keep queued for retry
  } finally {
    state.flushInFlight = false;
    render();
  }
}

async function applyRemote(note) {
  const local = state.notes.get(note.id);
  if (!local || note.version >= local.version) {
    state.notes.set(note.id, note);
    await dbPut("notes", note);
    render();
  }
}

async function bootstrap() {
  db = await openDb();
  const [localNotes, localOutbox] = await Promise.all([dbAll("notes"), dbAll("outbox")]);
  for (const n of localNotes) state.notes.set(n.id, n);
  state.outbox = localOutbox.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!state.activeId && state.notes.size) setActive([...state.notes.keys()][0]);

  if (navigator.onLine) {
    const snap = await fetch("/api/snapshot").then((r) => r.json());
    for (const note of snap.notes) {
      state.notes.set(note.id, note);
      await dbPut("notes", note);
    }
  }

  render();
  flushOutbox();
  connectStream();
}

function connectStream() {
  if (!navigator.onLine) return;
  const stream = new EventSource("/api/stream");
  stream.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "note_updated") await applyRemote(msg.note);
  };
  stream.onerror = () => {
    stream.close();
    setTimeout(connectStream, 1500);
  };
}

window.addEventListener("online", () => {
  ui.networkStatus.textContent = "online";
  flushOutbox();
  connectStream();
});
window.addEventListener("offline", () => {
  ui.networkStatus.textContent = "offline";
});
ui.networkStatus.textContent = navigator.onLine ? "online" : "offline";
ui.newBtn.addEventListener("click", createNote);
ui.title.addEventListener("input", scheduleSave);
ui.content.addEventListener("input", scheduleSave);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
bootstrap();
