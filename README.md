# VeritasPad

VeritasPad is an **offline-first collaborative note-taking app** with a **server-authoritative consistency model**.

## Features

- Offline editing with local persistence (IndexedDB).
- Background sync queue that retries when connectivity returns.
- Real-time collaboration updates over Server-Sent Events (SSE).
- Version-checked writes (`baseVersion`) for strongly ordered server commits.
- Conflict handling that preserves unsynced local content.
- Service worker app-shell caching for resilient startup while offline.

## Consistency model

- The server is the **single source of truth** and serializes all accepted writes.
- Each write includes a `baseVersion`; mismatches return `409 version_conflict`.
- Clients rebase conflicted edits before retrying, so all replicas converge to server-committed history.

## Run

```bash
npm start
```

Open `http://localhost:3000` in one or more browser tabs/devices.

## Test

```bash
npm test
```
