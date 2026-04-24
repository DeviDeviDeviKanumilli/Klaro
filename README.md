# Klaro

Voice assistant monorepo: **server** (API + agents), **electron** (desktop), optional **client** (web).

## Setup

1. Copy `server/.env.example` to `server/.env` and add your API keys.
2. Install dependencies in each app you use (`npm install` in `server/`, `electron/`, and/or `client/`).

## Run

**Server** (default port `3001`):

```bash
cd server && npm run dev
```

**Electron** (after the server is up, or use its embedded server unless `KLARO_SKIP_EMBEDDED_SERVER=1`):

```bash
cd electron && npm run dev
```

**Next.js client** (optional):

```bash
cd client && npm run dev
```

## Documentation

See the [`docs/`](docs/) folder for architecture and feature notes. For a hackathon-style narrative, read [**How we built it**](docs/HOW_WE_BUILT_IT.md).
