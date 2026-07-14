const runtimeConfigPath = "./runtime-config.json";
const validStorageBackends = new Set(["api", "browser"]);
const validLibraryKinds = new Set(["config", "sounds", "sequences"]);
const validLibraryFileName = /^[A-Za-z0-9_.-]+$/;
const defaultBrowserStorageName = "chopchae-webapp-library";
const textEncoder = new TextEncoder();

export const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  storageBackend: "api",
  apiBasePath: "",
  libraryLabel: "Embedded library",
  browserStorageName: defaultBrowserStorageName,
  seedLibraryUrl: "",
  seedLibrary: null
});

export class LibraryBackendError extends Error {
  constructor(message, statusCode = 0) {
    super(message);
    this.name = "LibraryBackendError";
    this.statusCode = statusCode;
  }
}

export async function loadRuntimeConfig(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (fetchImpl == null) {
    return normalizeRuntimeConfig({});
  }

  const baseUrl = options.baseUrl ?? globalThis.location?.href ?? import.meta.url;
  let response;
  try {
    response = await fetchImpl(new URL(runtimeConfigPath, baseUrl), { cache: "no-store" });
  } catch {
    return normalizeRuntimeConfig({});
  }

  if (!response.ok) {
    if (response.status === 404) {
      return normalizeRuntimeConfig({});
    }
    throw new LibraryBackendError(`Runtime config failed to load (${response.status}).`, response.status);
  }

  const text = await response.text();
  if (text.trim() === "" || isMissingConfigFallback(response, text)) {
    return normalizeRuntimeConfig({});
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const configError = new LibraryBackendError("Runtime config must be valid JSON.");
    configError.cause = error;
    throw configError;
  }

  return normalizeRuntimeConfig(parsed);
}

export function normalizeRuntimeConfig(rawConfig = {}) {
  if (rawConfig == null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new LibraryBackendError("Runtime config must be a JSON object.");
  }

  const storageBackend = stringSetting(rawConfig.storageBackend, DEFAULT_RUNTIME_CONFIG.storageBackend);
  if (!validStorageBackends.has(storageBackend)) {
    throw new LibraryBackendError(`Unsupported storageBackend "${storageBackend}".`);
  }

  const libraryLabel = stringSetting(
    rawConfig.libraryLabel,
    storageBackend === "browser" ? "Browser library" : DEFAULT_RUNTIME_CONFIG.libraryLabel
  );

  return {
    storageBackend,
    apiBasePath: normalizeApiBasePath(stringSetting(rawConfig.apiBasePath, DEFAULT_RUNTIME_CONFIG.apiBasePath)),
    libraryLabel,
    browserStorageName: stringSetting(rawConfig.browserStorageName, defaultBrowserStorageName),
    seedLibraryUrl: stringSetting(rawConfig.seedLibraryUrl, ""),
    seedLibrary: rawConfig.seedLibrary ?? null
  };
}

export function createLibraryBackend(config, options = {}) {
  const normalizedConfig = normalizeRuntimeConfig(config);
  if (normalizedConfig.storageBackend === "api") {
    return createApiLibraryBackend(normalizedConfig, options);
  }

  return createBrowserLibraryBackend(normalizedConfig, options);
}

export function createUnavailableLibraryBackend(message) {
  const error = new LibraryBackendError(message);
  return {
    storageBackend: "unavailable",
    label: "Library",
    async listLibrary() {
      throw error;
    },
    async readFile() {
      throw error;
    },
    async writeFile() {
      throw error;
    }
  };
}

export function createApiLibraryBackend(config, options = {}) {
  const normalizedConfig = normalizeRuntimeConfig(config);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (fetchImpl == null) {
    return createUnavailableLibraryBackend("The API library backend requires fetch support.");
  }

  async function fetchJson(path, init) {
    const response = await fetchImpl(`${normalizedConfig.apiBasePath}${path}`, init);
    if (!response.ok) {
      throw new LibraryBackendError(await responseText(response), response.status);
    }
    return response.json();
  }

  return {
    storageBackend: "api",
    label: normalizedConfig.libraryLabel,
    async listLibrary() {
      return decorateLibraryIndex(await fetchJson("/api/library"), normalizedConfig);
    },
    async readFile(kind, name) {
      const query = `kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`;
      return fetchJson(`/api/library/file?${query}`);
    },
    async writeFile(kind, name, content) {
      return fetchJson("/api/library/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, name, content })
      });
    }
  };
}

export function createBrowserLibraryBackend(config, options = {}) {
  const normalizedConfig = normalizeRuntimeConfig(config);
  const storage = options.storage ?? createIndexedDbLibraryStorage(
    normalizedConfig.browserStorageName,
    options.indexedDB ?? globalThis.indexedDB
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  let seedPromise = null;

  async function ensureSeeded() {
    if (seedPromise == null) {
      seedPromise = seedBrowserLibrary(normalizedConfig, storage, fetchImpl);
    }
    await seedPromise;
  }

  return {
    storageBackend: "browser",
    label: normalizedConfig.libraryLabel,
    async listLibrary() {
      await ensureSeeded();
      return makeBrowserLibraryIndex(await storage.listRecords(), normalizedConfig);
    },
    async readFile(kind, name) {
      await ensureSeeded();
      const [normalizedKind, normalizedName] = normalizeLibraryRequest(kind, name);
      const record = await storage.readRecord(libraryRecordId(normalizedKind, normalizedName));
      if (record == null) {
        throw new LibraryBackendError(`Library file "${normalizedName}" was not found.`, 404);
      }
      return {
        kind: normalizedKind,
        name: normalizedName,
        content: record.content
      };
    },
    async writeFile(kind, name, content) {
      await ensureSeeded();
      if (typeof content !== "string") {
        throw new LibraryBackendError("Library file content must be a string.");
      }
      const [normalizedKind, normalizedName] = normalizeLibraryRequest(kind, name);
      const record = makeLibraryRecord(normalizedKind, normalizedName, content);
      await storage.writeRecord(record);
      return describeBrowserFile(record);
    }
  };
}

export function createMemoryLibraryStorage(initialRecords = []) {
  const records = new Map();
  for (const record of initialRecords) {
    records.set(record.id, { ...record });
  }

  return {
    async listRecords() {
      return [...records.values()].map((record) => ({ ...record }));
    },
    async readRecord(id) {
      const record = records.get(id);
      return record == null ? null : { ...record };
    },
    async writeRecord(record) {
      records.set(record.id, { ...record });
    },
    async writeRecords(nextRecords) {
      for (const record of nextRecords) {
        records.set(record.id, { ...record });
      }
    },
    async countRecords() {
      return records.size;
    }
  };
}

export function normalizeLibraryRequest(kind, name) {
  if (!validLibraryKinds.has(kind)) {
    throw new LibraryBackendError(`Invalid library file kind "${kind}".`);
  }

  if (kind === "config") {
    return [kind, "chopchae_config.txt"];
  }

  if (!isSafeLibraryFileName(name)) {
    throw new LibraryBackendError(`Invalid library file name "${name}".`);
  }

  return [kind, name];
}

export function isSafeLibraryFileName(name) {
  return (
    typeof name === "string"
    && name.length > 0
    && name.length <= 128
    && !name.startsWith(".")
    && !name.endsWith("~")
    && validLibraryFileName.test(name)
  );
}

export function formatLibraryBackendError(error) {
  if (error instanceof LibraryBackendError) {
    return error.message;
  }

  return error?.message ?? String(error);
}

function createIndexedDbLibraryStorage(databaseName, indexedDb) {
  if (indexedDb == null) {
    throw new LibraryBackendError("The browser library backend requires IndexedDB support.");
  }

  let databasePromise = null;
  const getDatabase = () => {
    if (databasePromise == null) {
      databasePromise = openIndexedDb(indexedDb, databaseName);
    }
    return databasePromise;
  };

  return {
    async listRecords() {
      return runObjectStoreRequest(await getDatabase(), "readonly", (store) => store.getAll());
    },
    async readRecord(id) {
      return runObjectStoreRequest(await getDatabase(), "readonly", (store) => store.get(id));
    },
    async writeRecord(record) {
      await runObjectStoreTransaction(await getDatabase(), "readwrite", (store) => {
        store.put(record);
      });
    },
    async writeRecords(records) {
      await runObjectStoreTransaction(await getDatabase(), "readwrite", (store) => {
        for (const record of records) {
          store.put(record);
        }
      });
    },
    async countRecords() {
      return runObjectStoreRequest(await getDatabase(), "readonly", (store) => store.count());
    }
  };
}

function openIndexedDb(indexedDb, databaseName) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(databaseName, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("files")) {
        database.createObjectStore("files", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new LibraryBackendError("IndexedDB open failed."));
  });
}

function runObjectStoreRequest(database, mode, callback) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("files", mode);
    const store = transaction.objectStore("files");
    const request = callback(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new LibraryBackendError("IndexedDB request failed."));
    transaction.onabort = () => reject(transaction.error ?? new LibraryBackendError("IndexedDB transaction aborted."));
  });
}

function runObjectStoreTransaction(database, mode, callback) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("files", mode);
    const store = transaction.objectStore("files");

    callback(store);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new LibraryBackendError("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new LibraryBackendError("IndexedDB transaction aborted."));
  });
}

async function seedBrowserLibrary(config, storage, fetchImpl) {
  if (await storage.countRecords() > 0) {
    return;
  }

  let seedLibrary = config.seedLibrary;
  if (seedLibrary == null && config.seedLibraryUrl !== "") {
    if (fetchImpl == null) {
      throw new LibraryBackendError("A seedLibraryUrl requires fetch support.");
    }
    const response = await fetchImpl(config.seedLibraryUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new LibraryBackendError(`Seed library failed to load (${response.status}).`, response.status);
    }
    seedLibrary = await response.json();
  }

  if (seedLibrary == null) {
    return;
  }

  const records = recordsFromSeedLibrary(seedLibrary);
  if (records.length > 0) {
    await storage.writeRecords(records);
  }
}

function recordsFromSeedLibrary(seedLibrary) {
  if (seedLibrary == null || typeof seedLibrary !== "object" || Array.isArray(seedLibrary)) {
    throw new LibraryBackendError("seedLibrary must be a JSON object.");
  }

  const records = [];
  const configSeed = seedLibrary.config;
  if (typeof configSeed === "string") {
    records.push(makeLibraryRecord("config", "chopchae_config.txt", configSeed));
  } else if (configSeed != null) {
    records.push(seedEntryToRecord("config", configSeed));
  }

  for (const kind of ["sounds", "sequences"]) {
    const entries = seedLibrary[kind] ?? [];
    if (!Array.isArray(entries)) {
      throw new LibraryBackendError(`seedLibrary.${kind} must be an array.`);
    }
    for (const entry of entries) {
      records.push(seedEntryToRecord(kind, entry));
    }
  }

  return records;
}

function seedEntryToRecord(kind, entry) {
  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new LibraryBackendError("Seed library entries must be JSON objects.");
  }

  if (typeof entry.content !== "string") {
    throw new LibraryBackendError("Seed library entry content must be a string.");
  }

  const [normalizedKind, normalizedName] = normalizeLibraryRequest(kind, entry.name);
  return makeLibraryRecord(normalizedKind, normalizedName, entry.content);
}

function makeBrowserLibraryIndex(records, config) {
  const sortedRecords = [...records].sort((left, right) => left.name.localeCompare(right.name));
  const configRecord = sortedRecords.find((record) => record.id === libraryRecordId("config", "chopchae_config.txt"));

  return {
    root: config.libraryLabel,
    envVar: "storageBackend",
    source: "browser",
    backend: "browser",
    label: config.libraryLabel,
    exists: true,
    files: {
      config: configRecord == null
        ? { name: "chopchae_config.txt", bytes: 0, exists: false }
        : describeBrowserFile(configRecord),
      sounds: sortedRecords.filter((record) => record.kind === "sounds").map(describeBrowserFile),
      sequences: sortedRecords.filter((record) => record.kind === "sequences").map(describeBrowserFile)
    }
  };
}

function makeLibraryRecord(kind, name, content) {
  return {
    id: libraryRecordId(kind, name),
    kind,
    name,
    content
  };
}

function libraryRecordId(kind, name) {
  return `${kind}/${name}`;
}

function describeBrowserFile(record) {
  return {
    name: record.name,
    bytes: textEncoder.encode(record.content).byteLength,
    exists: true
  };
}

function decorateLibraryIndex(index, config) {
  return {
    ...index,
    backend: "api",
    label: config.libraryLabel
  };
}

function normalizeApiBasePath(path) {
  if (path === "" || path === "/") {
    return path === "/" ? "" : path;
  }

  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function stringSetting(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function isMissingConfigFallback(response, text) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  return contentType.includes("text/html") && text.trimStart().toLowerCase().startsWith("<!doctype");
}

async function responseText(response) {
  try {
    return await response.text();
  } catch {
    return `Request failed with status ${response.status}.`;
  }
}
