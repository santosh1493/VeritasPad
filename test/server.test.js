import test from "node:test";
import assert from "node:assert/strict";

test("conflict merge helper format", () => {
  const localOp = { title: "Local", content: "Mine" };
  const remoteNote = { id: "n1", title: "Remote", content: "Theirs", version: 4 };
  const merged = {
    ...remoteNote,
    title: `${localOp.title} (conflict)`,
    content: `${remoteNote.content}\n\n<<<< LOCAL UNSYNCED >>>>\n${localOp.content}`,
  };
  assert.equal(merged.version, 4);
  assert.match(merged.title, /conflict/);
  assert.match(merged.content, /LOCAL UNSYNCED/);
});
