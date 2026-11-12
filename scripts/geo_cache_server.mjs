import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const CACHE_PATH = resolve(process.env.GEO_CACHE_PATH ?? '.cache/geo-shared-cache.json');
const QUERY_TTL_MS = Number.parseInt(process.env.GEO_QUERY_CACHE_TTL_MS ?? String(10 * 60 * 1000), 10);
const ACCESSION_TTL_MS = Number.parseInt(process.env.GEO_ACCESSION_CACHE_TTL_MS ?? String(30 * 60 * 1000), 10);
const QUERY_MAX_ENTRIES = Number.parseInt(process.env.GEO_QUERY_CACHE_MAX_ENTRIES ?? '128', 10);
const ACCESSION_MAX_ENTRIES = Number.parseInt(process.env.GEO_ACCESSION_CACHE_MAX_ENTRIES ?? '2048', 10);
const CACHE_PERSIST_DEBOUNCE_MS = Number.parseInt(process.env.GEO_CACHE_PERSIST_DEBOUNCE_MS ?? '220', 10);
const MAX_CACHE_KEY_LENGTH = 160;
const MAX_LOOKUP_BATCH_SIZE = 300;

let persistTimer = null;

function ensureCacheDir() {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
}

function loadCacheStore() {
  ensureCacheDir();
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    return {
      queries: parsed?.queries && typeof parsed.queries === 'object' ? parsed.queries : {},
      accessions: parsed?.accessions && typeof parsed.accessions === 'object' ? parsed.accessions : {},
    };
  } catch {
    return { queries: {}, accessions: {} };
  }
}

const store = loadCacheStore();

function persistStore() {
  ensureCacheDir();
  persistTimer = null;
  writeFileSync(CACHE_PATH, JSON.stringify(store), 'utf8');
}

function now() {
  return Date.now();
}

function withCors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(response, statusCode, payload) {
  withCors(response);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(payload));
}

function normalizeCacheKey(rawKey) {
  if (typeof rawKey !== 'string') {
    return '';
  }
  const normalized = rawKey.trim();
  if (!normalized || normalized.length > MAX_CACHE_KEY_LENGTH) {
    return '';
  }
  return normalized;
}

function touchEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return;
  }
  entry.lastAccessedAt = now();
}

function enforceCacheLimits(entries, maxEntries) {
  const keys = Object.keys(entries);
  if (keys.length <= maxEntries) {
    return false;
  }
  keys
    .sort((left, right) => {
      const leftEntry = entries[left] || {};
      const rightEntry = entries[right] || {};
      const leftTouched = Number(leftEntry.lastAccessedAt ?? leftEntry.expiresAt ?? 0);
      const rightTouched = Number(rightEntry.lastAccessedAt ?? rightEntry.expiresAt ?? 0);
      return leftTouched - rightTouched;
    })
    .slice(0, Math.max(0, keys.length - maxEntries))
    .forEach((key) => {
      delete entries[key];
    });
  return true;
}

function cleanExpiredEntries() {
  const current = now();
  let mutated = false;
  for (const [key, entry] of Object.entries(store.queries)) {
    if (!entry || entry.expiresAt <= current) {
      delete store.queries[key];
      mutated = true;
    }
  }
  for (const [key, entry] of Object.entries(store.accessions)) {
    if (!entry || entry.expiresAt <= current) {
      delete store.accessions[key];
      mutated = true;
    }
  }
  if (enforceCacheLimits(store.queries, Math.max(1, QUERY_MAX_ENTRIES))) {
    mutated = true;
  }
  if (enforceCacheLimits(store.accessions, Math.max(1, ACCESSION_MAX_ENTRIES))) {
    mutated = true;
  }
  return mutated;
}

function schedulePersistStore() {
  if (persistTimer !== null) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistStore();
  }, Math.max(0, CACHE_PERSIST_DEBOUNCE_MS));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let buffer = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 2_000_000) {
        reject(new Error('Request body too large'));
      }
    });
    request.on('end', () => {
      resolveBody(buffer ? JSON.parse(buffer) : {});
    });
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  if (cleanExpiredEntries()) {
    schedulePersistStore();
  }

  if (!request.url) {
    sendJson(response, 400, { error: 'Missing request URL.' });
    return;
  }

  if (request.method === 'OPTIONS') {
    withCors(response);
    response.statusCode = 204;
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/geo-cache/query') {
    const key = normalizeCacheKey(url.searchParams.get('key') ?? '');
    const entry = store.queries[key];
    if (!key || !entry) {
      sendJson(response, 404, { response: null });
      return;
    }
    touchEntry(entry);
    sendJson(response, 200, { response: entry.response });
    return;
  }

  if (request.method === 'PUT' && url.pathname === '/api/geo-cache/query') {
    try {
      const key = normalizeCacheKey(url.searchParams.get('key') ?? '');
      const body = await readBody(request);
      if (!key || !body?.response) {
        sendJson(response, 400, { error: 'Missing query cache key or response payload.' });
        return;
      }
      store.queries[key] = {
        expiresAt: now() + QUERY_TTL_MS,
        lastAccessedAt: now(),
        response: body.response,
      };
      enforceCacheLimits(store.queries, Math.max(1, QUERY_MAX_ENTRIES));
      schedulePersistStore();
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid request body.' });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/geo-cache/accessions/lookup') {
    try {
      const body = await readBody(request);
      const accessions = Array.isArray(body?.accessions) ? body.accessions.slice(0, MAX_LOOKUP_BATCH_SIZE) : [];
      const items = {};
      let touched = false;
      accessions.forEach((accession) => {
        const key = normalizeCacheKey(accession);
        if (!key) {
          return;
        }
        const entry = store.accessions[key];
        if (entry) {
          touchEntry(entry);
          items[key] = entry.result;
          touched = true;
        }
      });
      if (touched) {
        schedulePersistStore();
      }
      sendJson(response, 200, { items });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid request body.' });
    }
    return;
  }

  if (request.method === 'PUT' && url.pathname === '/api/geo-cache/accession') {
    try {
      const key = normalizeCacheKey(url.searchParams.get('key') ?? '');
      const body = await readBody(request);
      if (!key || !body?.result) {
        sendJson(response, 400, { error: 'Missing accession cache key or result payload.' });
        return;
      }
      store.accessions[key] = {
        expiresAt: now() + ACCESSION_TTL_MS,
        lastAccessedAt: now(),
        result: body.result,
      };
      enforceCacheLimits(store.accessions, Math.max(1, ACCESSION_MAX_ENTRIES));
      schedulePersistStore();
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid request body.' });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
});

function flushAndExit(signalName) {
  try {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
      persistStore();
    }
  } catch {
    // Exit regardless of write failures during shutdown.
  }
  process.exit(signalName === 'SIGINT' ? 130 : 143);
}

process.on('SIGINT', () => {
  flushAndExit('SIGINT');
});
process.on('SIGTERM', () => {
  flushAndExit('SIGTERM');
});
process.on('beforeExit', () => {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistStore();
  }
});

server.listen(PORT, () => {
  console.log(`GEO shared cache server listening on http://127.0.0.1:${PORT}`);
  console.log(`Cache file: ${CACHE_PATH}`);
  console.log(
    `Limits: queries=${Math.max(1, QUERY_MAX_ENTRIES)} accessions=${Math.max(1, ACCESSION_MAX_ENTRIES)} ` +
    `persistDebounceMs=${Math.max(0, CACHE_PERSIST_DEBOUNCE_MS)}`,
  );
});
