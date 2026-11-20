import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

const API_KEY_CACHE_TTL_MS = 3000;
const API_KEY_CACHE_MAX = 128;
let _keyCache = { db: null, byKey: new Map() };

export function invalidateApiKeysCache() {
  _keyCache.byKey.clear();
}

function cloneKeyRecord(record) {
  if (!record) return null;
  return {
    ...record,
    access: record.access
      ? { restricted: !!record.access.restricted, allow: [...(record.access.allow || [])] }
      : { restricted: false, allow: [] },
  };
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = await db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return (rows || []).map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = await db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const now = Date.now();
  if (_keyCache.db === db) {
    const cached = _keyCache.byKey.get(key);
    if (cached && (now - cached.ts) < API_KEY_CACHE_TTL_MS) {
      return cloneKeyRecord(cached.record);
    }
  } else {
    _keyCache = { db, byKey: new Map() };
  }
  const row = await db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  const record = rowToKey(row);
  if (record) {
    if (_keyCache.byKey.size >= API_KEY_CACHE_MAX) {
      _keyCache.byKey.delete(_keyCache.byKey.keys().next().value);
    }
    _keyCache.byKey.set(key, { record, ts: now });
  }
  return cloneKeyRecord(record);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  await db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, cols.accessRestricted, cols.accessAllow]
  );
  invalidateApiKeysCache();
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  await db.transaction(async () => {
    const row = await db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    const cols = keyAccessToColumns(merged.access);
    await db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(await db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  invalidateApiKeysCache();
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = await db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  invalidateApiKeysCache();
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  if (!key) return false;
  const record = await getApiKeyByKey(key);
  return record ? record.isActive === true : false;
}
