import { exchangeConnections, userBots } from "../src/db/schema";
import { db } from "../src/db/index";
import { sql } from "drizzle-orm";
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

export interface BotStateRecord {
  id: number;
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  updated_at: number;
  previous_status: string;
  action: string;
  reason: string;
  active_processes_running: number;
  metadata?: string;
}

export interface AuditLogRecord {
  id?: number;
  timestamp: number;
  event: string;
  status: string;
  action?: string;
  reason?: string;
  ip?: string;
  user_agent?: string;
  error?: string;
  metadata?: string;
}

export interface ExchangeConnectionRecord {
  id: string;
  user_id: string;
  exchange: string; // 'binance' | 'bybit' | 'bitget'
  encrypted_api_key: string;
  encrypted_api_secret: string;
  encrypted_api_passphrase?: string | null;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  created_at: number;
  updated_at: number;
  capital_mode?: 'AUTO_SYNC' | 'FIXED_ALLOCATION';
  configured_allocation?: number;
  latest_balance?: number;
  latest_available_balance?: number;
  last_sync_time?: number;
  sync_status?: 'SYNCED' | 'STALE' | 'ERROR' | 'PENDING';
  sync_error?: string | null;
  is_live_trading_enabled?: number; // 0 or 1
}

export interface BotRecord {
  id: string;
  user_id: string;
  exchange_connection_id: string;
  name: string;
  strategy: string;
  trading_pair: string;
  capital_allocation: number;
  risk_settings: string;
  status: 'STOPPED' | 'RUNNING' | 'PAUSED';
  created_at: number;
  updated_at: number;
}

// Ensure data directory exists
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.error('[DATABASE] Error creating data directory:', err);
  }
}

function resolveDatabasePath(): string {
  const raw = process.env.DATABASE_URL || '';
  let clean = raw.trim().replace(/^['"]|['"]$/g, '');
  if (clean.startsWith('sqlite:///')) {
    clean = clean.replace('sqlite:///', '');
  } else if (clean.startsWith('sqlite://')) {
    clean = clean.replace('sqlite://', '');
  } else if (clean.startsWith('sqlite:')) {
    clean = clean.replace('sqlite:', '');
  } else if (clean.startsWith('file:')) {
    clean = clean.replace('file:', '');
  }

  const targetPath = clean ? path.resolve(process.cwd(), clean) : path.join(DATA_DIR, 'novaquant.db');
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      console.error('[DATABASE] Error creating database directory:', err);
    }
  }
  return targetPath;
}

const DB_FILE_PATH = resolveDatabasePath();

const JSON_BACKUP_PATH = path.join(DATA_DIR, 'bot_state.json');
const CONNECTIONS_BACKUP_PATH = path.join(DATA_DIR, 'exchange_connections.json');
const BOTS_BACKUP_PATH = path.join(DATA_DIR, 'bots.json');

let sqliteDb: DatabaseSync | null = null;

// Initialize native SQLite with graceful fallback
try {
  sqliteDb = new DatabaseSync(DB_FILE_PATH);
  console.log(`[DATABASE] SQLite engine initialized successfully at ${DB_FILE_PATH}`);
} catch (err: any) {
  // If target path failed, try fallback path in DATA_DIR
  try {
    const fallbackPath = path.join(DATA_DIR, 'novaquant.db');
    sqliteDb = new DatabaseSync(fallbackPath);
    console.log(`[DATABASE] SQLite engine initialized using fallback at ${fallbackPath}`);
  } catch (fallbackErr: any) {
    console.warn('[DATABASE] Native node:sqlite not available or failed to load, using durable JSON storage:', err?.message || err);
  }
}

// Initialize tables
export function initDatabase(): {
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  lastUpdated: number;
  activeProcessesRunning: boolean;
} {
  console.log('[DATABASE] Running schema bootstrap on production store...');

  if (sqliteDb) {
    try {
      sqliteDb.exec(`
        CREATE TABLE IF NOT EXISTS bot_status (
          id INTEGER PRIMARY KEY,
          status TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          previous_status TEXT,
          action TEXT,
          reason TEXT,
          active_processes_running INTEGER NOT NULL DEFAULT 1,
          metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS bot_audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          event TEXT NOT NULL,
          status TEXT NOT NULL,
          action TEXT,
          reason TEXT,
          ip TEXT,
          user_agent TEXT,
          error TEXT,
          metadata TEXT
        );

        CREATE TABLE IF NOT EXISTS risk_settings (
          id INTEGER PRIMARY KEY,
          settings_json TEXT NOT NULL,
          trading_mode TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS exchange_connections (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          exchange TEXT NOT NULL,
          encrypted_api_key TEXT NOT NULL,
          encrypted_api_secret TEXT NOT NULL,
          encrypted_api_passphrase TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_exchange_conn_user ON exchange_connections(user_id);

        CREATE TABLE IF NOT EXISTS bots (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          exchange_connection_id TEXT NOT NULL,
          name TEXT NOT NULL,
          strategy TEXT NOT NULL,
          trading_pair TEXT NOT NULL,
          capital_allocation REAL NOT NULL,
          risk_settings TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id);
      `);

      // Ensure all columns exist in bot_status if table was pre-created
      const tableInfo = sqliteDb.prepare("PRAGMA table_info(bot_status)").all() as Array<{ name: string }>;
      const colNames = new Set(tableInfo.map((c) => c.name));

      if (!colNames.has('action')) {
        sqliteDb.exec('ALTER TABLE bot_status ADD COLUMN action TEXT;');
      }
      if (!colNames.has('previous_status')) {
        sqliteDb.exec('ALTER TABLE bot_status ADD COLUMN previous_status TEXT;');
      }
      if (!colNames.has('active_processes_running')) {
        sqliteDb.exec('ALTER TABLE bot_status ADD COLUMN active_processes_running INTEGER NOT NULL DEFAULT 1;');
      }
      if (!colNames.has('metadata')) {
        sqliteDb.exec('ALTER TABLE bot_status ADD COLUMN metadata TEXT;');
      }

      // Ensure capital sync columns exist in exchange_connections
      const connTableInfo = sqliteDb.prepare("PRAGMA table_info(exchange_connections)").all() as Array<{ name: string }>;
      const connColNames = new Set(connTableInfo.map((c) => c.name));

      if (!connColNames.has('capital_mode')) {
        sqliteDb.exec("ALTER TABLE exchange_connections ADD COLUMN capital_mode TEXT NOT NULL DEFAULT 'AUTO_SYNC';");
      }
      if (!connColNames.has('configured_allocation')) {
        sqliteDb.exec("ALTER TABLE exchange_connections ADD COLUMN configured_allocation REAL NOT NULL DEFAULT 0;");
      }
      if (!connColNames.has('latest_balance')) {
        sqliteDb.exec("ALTER TABLE exchange_connections ADD COLUMN latest_balance REAL NOT NULL DEFAULT 0;");
      }
      if (!connColNames.has('latest_available_balance')) {
        sqliteDb.exec("ALTER TABLE exchange_connections ADD COLUMN latest_available_balance REAL NOT NULL DEFAULT 0;");
      }
      if (!connColNames.has('last_sync_time')) {
        sqliteDb.exec("ALTER TABLE exchange_connections ADD COLUMN last_sync_time INTEGER NOT NULL DEFAULT 0;");
      }
      if (!connColNames.has('sync_status')) {
        sqliteDb.exec("ALTER TABLE exchange_connections ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'PENDING';");
      }
      if (!connColNames.has('sync_error')) {
        sqliteDb.exec("ALTER TABLE exchange_connections ADD COLUMN sync_error TEXT;");
      }
      if (!connColNames.has('is_live_trading_enabled')) {
        sqliteDb.exec("ALTER TABLE exchange_connections ADD COLUMN is_live_trading_enabled INTEGER NOT NULL DEFAULT 0;");
      }

      console.log('[DATABASE] Tables verified and migrated: bot_status, bot_audit_logs, risk_settings, exchange_connections, bots');
    } catch (dbErr: any) {
      console.error('[DATABASE ERROR] Failed bootstrapping SQLite tables:', dbErr?.message || dbErr);
    }
  }

  // Load existing status from SQLite or JSON backup
  let currentRecord: BotStateRecord | null = null;

  if (sqliteDb) {
    try {
      const selectStmt = sqliteDb.prepare('SELECT * FROM bot_status WHERE id = 1');
      const row = selectStmt.get() as unknown as BotStateRecord | undefined;
      if (row) {
        currentRecord = row;
        console.log(`[DATABASE] Loaded persistent bot state from SQLite: Status=${row.status}, UpdatedAt=${new Date(row.updated_at).toISOString()}`);
      }
    } catch (readErr: any) {
      console.error('[DATABASE ERROR] Failed to query bot_status table:', readErr?.message || readErr);
    }
  }

  // Check JSON backup if SQLite had no row
  if (!currentRecord && fs.existsSync(JSON_BACKUP_PATH)) {
    try {
      const raw = fs.readFileSync(JSON_BACKUP_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.status) {
        currentRecord = parsed;
        console.log(`[DATABASE] Loaded persistent bot state from JSON fallback: Status=${parsed.status}`);
      }
    } catch (jsonErr: any) {
      console.warn('[DATABASE] Failed to read JSON backup:', jsonErr?.message);
    }
  }

  // If still no record, initialize with BOT_DEFAULT_STATUS (defaults to STOPPED per security directive)
  if (!currentRecord) {
    const envDefault = (process.env.BOT_DEFAULT_STATUS || 'stopped').toLowerCase();
    const defaultStatus: 'RUNNING' | 'PAUSED' | 'STOPPED' =
      envDefault === 'running' ? 'RUNNING' : envDefault === 'paused' ? 'PAUSED' : 'STOPPED';
    const now = Date.now();
    currentRecord = {
      id: 1,
      status: defaultStatus,
      updated_at: now,
      previous_status: 'INITIAL_BOOT',
      action: 'BOOT_INIT',
      reason: 'First system startup initialization (BOT_DEFAULT_STATUS=stopped)',
      active_processes_running: defaultStatus === 'RUNNING' ? 1 : 0,
      metadata: JSON.stringify({ initializedAt: now }),
    };

    saveBotStatusToStores(currentRecord);
    console.log(`[DATABASE] Initialized default bot record: Status=${defaultStatus}`);
  }

  seedSampleAuditLogsIfEmpty();

  return {
    status: currentRecord.status,
    lastUpdated: currentRecord.updated_at,
    activeProcessesRunning: currentRecord.active_processes_running === 1,
  };
}

// Internal helper to persist to both SQLite and JSON file
function saveBotStatusToStores(record: BotStateRecord): void {
  // 1. Save to SQLite
  if (sqliteDb) {
    try {
      const upsertStmt = sqliteDb.prepare(`
        INSERT OR REPLACE INTO bot_status (
          id, status, updated_at, previous_status, action, reason, active_processes_running, metadata
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      `);
      upsertStmt.run(
        record.status,
        record.updated_at,
        record.previous_status,
        record.action,
        record.reason,
        record.active_processes_running,
        record.metadata || ''
      );
      console.log(`[DATABASE SUCCESS] SQLite updated: id=1, status=${record.status}, active_processes=${record.active_processes_running}`);
    } catch (sqliteErr: any) {
      console.error('[DATABASE ERROR] SQLite upsert failed:', sqliteErr?.message || sqliteErr);
      throw sqliteErr;
    }
  }

  // 2. Synchronous write to durable JSON backup
  try {
    fs.writeFileSync(JSON_BACKUP_PATH, JSON.stringify(record, null, 2), 'utf-8');
  } catch (fsErr: any) {
    console.error('[DATABASE ERROR] Failed writing JSON backup:', fsErr?.message || fsErr);
  }
}

// Get current bot status directly from database
export function getBotStatusFromDb(): {
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  lastUpdated: number;
  previousStatus: string;
  activeProcessesRunning: boolean;
  reason: string;
} {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('SELECT * FROM bot_status WHERE id = 1');
      const row = stmt.get() as unknown as BotStateRecord | undefined;
      if (row) {
        return {
          status: row.status,
          lastUpdated: row.updated_at,
          previousStatus: row.previous_status,
          activeProcessesRunning: row.active_processes_running === 1,
          reason: row.reason,
        };
      }
    } catch (err: any) {
      console.error('[DATABASE ERROR] getBotStatusFromDb SQLite query failed:', err);
    }
  }

  // JSON fallback
  if (fs.existsSync(JSON_BACKUP_PATH)) {
    try {
      const raw = fs.readFileSync(JSON_BACKUP_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        status: parsed.status || 'RUNNING',
        lastUpdated: parsed.updated_at || Date.now(),
        previousStatus: parsed.previous_status || 'UNKNOWN',
        activeProcessesRunning: parsed.active_processes_running === 1,
        reason: parsed.reason || '',
      };
    } catch (err: any) {
      console.error('[DATABASE ERROR] getBotStatusFromDb JSON read failed:', err);
    }
  }

  return {
    status: 'RUNNING',
    lastUpdated: Date.now(),
    previousStatus: 'UNKNOWN',
    activeProcessesRunning: true,
    reason: 'Default state fallback',
  };
}

// Update bot status in database
export function updateBotStatusInDb(
  targetStatus: 'RUNNING' | 'PAUSED' | 'STOPPED',
  action: string,
  reason: string,
  meta?: { ip?: string; userAgent?: string; authorization?: string }
): {
  success: boolean;
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  lastUpdated: number;
  activeProcessesRunning: boolean;
  message: string;
} {
  const now = Date.now();
  const current = getBotStatusFromDb();
  const previousStatus = current.status;

  // Active trading processes are ONLY running when status is RUNNING
  const activeProcessesRunning = targetStatus === 'RUNNING' ? 1 : 0;

  console.log(`[DATABASE TRANSITION] Updating bot status in database: "${previousStatus}" -> "${targetStatus}" (Action: ${action}, Reason: ${reason})`);

  const record: BotStateRecord = {
    id: 1,
    status: targetStatus,
    updated_at: now,
    previous_status: previousStatus,
    action: action || targetStatus,
    reason: reason || `Updated via action ${action}`,
    active_processes_running: activeProcessesRunning,
    metadata: JSON.stringify({
      ip: meta?.ip || 'unknown',
      userAgent: meta?.userAgent || 'unknown',
      timestampIso: new Date(now).toISOString(),
    }),
  };

  try {
    saveBotStatusToStores(record);

    // Record audit log
    recordAuditLog({
      timestamp: now,
      event: 'BOT_STATUS_CHANGED',
      status: targetStatus,
      action: action || targetStatus,
      reason: reason || `Status set to ${targetStatus}`,
      ip: meta?.ip,
      user_agent: meta?.userAgent,
      metadata: JSON.stringify({ previousStatus, activeProcessesRunning }),
    });

    console.log(`[DATABASE AUDIT] Bot status successfully transitioned to "${targetStatus}" in persistent storage.`);

    return {
      success: true,
      status: targetStatus,
      lastUpdated: now,
      activeProcessesRunning: activeProcessesRunning === 1,
      message: `Bot status updated to ${targetStatus} and saved to database`,
    };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    console.error(`[DATABASE CRITICAL] Failed updating bot status in database:`, err);

    recordAuditLog({
      timestamp: now,
      event: 'BOT_STATUS_CHANGE_ERROR',
      status: targetStatus,
      action: action || targetStatus,
      reason: reason,
      ip: meta?.ip,
      user_agent: meta?.userAgent,
      error: errorMsg,
    });

    throw new Error(`Database error while updating bot status to ${targetStatus}: ${errorMsg}`);
  }
}

// Record an audit log entry
export function recordAuditLog(log: AuditLogRecord): void {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare(`
        INSERT INTO bot_audit_logs (timestamp, event, status, action, reason, ip, user_agent, error, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        log.timestamp,
        log.event,
        log.status,
        log.action || '',
        log.reason || '',
        log.ip || '',
        log.user_agent || '',
        log.error || '',
        log.metadata || ''
      );
    } catch (auditErr: any) {
      console.error('[DATABASE ERROR] Failed writing audit log:', auditErr?.message || auditErr);
    }
  }
}

// Get recent audit logs
export function getRecentAuditLogs(limit: number = 50): AuditLogRecord[] {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('SELECT * FROM bot_audit_logs ORDER BY timestamp DESC LIMIT ?');
      return stmt.all(limit) as unknown as AuditLogRecord[];
    } catch (err) {
      console.error('[DATABASE ERROR] Failed retrieving audit logs:', err);
    }
  }
  return [];
}

// Get filtered audit logs with query params
export function getFilteredAuditLogs(params: {
  limit?: number;
  event?: string;
  search?: string;
}): AuditLogRecord[] {
  const limit = params.limit || 100;
  if (!sqliteDb) return [];

  try {
    let query = 'SELECT * FROM bot_audit_logs WHERE 1=1';
    const queryParams: any[] = [];

    if (params.event && params.event !== 'ALL') {
      query += ' AND event = ?';
      queryParams.push(params.event);
    }

    if (params.search && params.search.trim().length > 0) {
      const searchTerm = `%${params.search.trim().toLowerCase()}%`;
      query += ' AND (LOWER(action) LIKE ? OR LOWER(reason) LIKE ? OR LOWER(event) LIKE ? OR LOWER(metadata) LIKE ?)';
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    queryParams.push(limit);

    const stmt = sqliteDb.prepare(query);
    return stmt.all(...queryParams) as unknown as AuditLogRecord[];
  } catch (err) {
    console.error('[DATABASE ERROR] Failed filtering audit logs:', err);
    return getRecentAuditLogs(limit);
  }
}

// Clear or purge audit logs
export function clearAllAuditLogs(): boolean {
  if (sqliteDb) {
    try {
      sqliteDb.exec('DELETE FROM bot_audit_logs');
      return true;
    } catch (err) {
      console.error('[DATABASE ERROR] Failed clearing audit logs:', err);
    }
  }
  return false;
}

// Ensure audit log subsystem is operational without inserting fake mock records
export function seedSampleAuditLogsIfEmpty(): void {
  // Real audit events only - do not seed fake trades or mock entries
}

/* =========================================================================
   MULTI-USER EXCHANGE CONNECTIONS CRUD OPERATIONS
   ========================================================================= */

function readConnectionsBackup(): ExchangeConnectionRecord[] {
  if (fs.existsSync(CONNECTIONS_BACKUP_PATH)) {
    try {
      const raw = fs.readFileSync(CONNECTIONS_BACKUP_PATH, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

function writeConnectionsBackup(records: ExchangeConnectionRecord[]): void {
  try {
    fs.writeFileSync(CONNECTIONS_BACKUP_PATH, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DATABASE] Failed writing connections backup:', err);
  }
}

/**
 * Saves or updates an exchange connection for a specific user.
 * Strictly associates the connection with user_id.
 */
export function saveUserExchangeConnection(data: {
  id?: string;
  user_id: string;
  exchange: string;
  encrypted_api_key: string;
  encrypted_api_secret: string;
  encrypted_api_passphrase?: string | null;
  status?: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
}): ExchangeConnectionRecord {
  const now = Date.now();
  const normalizedExchange = data.exchange.toLowerCase();
  
  // Find existing connection for this user and exchange if id not provided
  let connId = data.id;
  if (!connId) {
    const existing = getUserExchangeConnectionByExchange(data.user_id, normalizedExchange);
    connId = existing ? existing.id : `conn_${normalizedExchange}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  const record: ExchangeConnectionRecord = {
    id: connId,
    user_id: data.user_id,
    exchange: normalizedExchange,
    encrypted_api_key: data.encrypted_api_key,
    encrypted_api_secret: data.encrypted_api_secret,
    encrypted_api_passphrase: data.encrypted_api_passphrase || null,
    status: data.status || 'CONNECTED',
    created_at: now,
    updated_at: now,
  };

  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare(`
        INSERT INTO exchange_connections (
          id, user_id, exchange, encrypted_api_key, encrypted_api_secret, encrypted_api_passphrase, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          encrypted_api_key = excluded.encrypted_api_key,
          encrypted_api_secret = excluded.encrypted_api_secret,
          encrypted_api_passphrase = excluded.encrypted_api_passphrase,
          status = excluded.status,
          updated_at = excluded.updated_at;
      `);
      stmt.run(
        record.id,
        record.user_id,
        record.exchange,
        record.encrypted_api_key,
        record.encrypted_api_secret,
        record.encrypted_api_passphrase,
        record.status,
        record.created_at,
        record.updated_at
      );
      console.log(`[DATABASE] Saved exchange connection: id=${record.id}, user_id=${record.user_id}, exchange=${record.exchange}`);
    } catch (err: any) {
      console.error('[DATABASE ERROR] Failed saving exchange connection in SQLite:', err);
    }
  }

  // Durable JSON sync
  const allConns = readConnectionsBackup();
  const idx = allConns.findIndex((c) => c.id === record.id);
  if (idx >= 0) {
    record.created_at = allConns[idx].created_at;
    allConns[idx] = record;
  } else {
    allConns.push(record);
  }
  writeConnectionsBackup(allConns);

  // Cloud SQL PostgreSQL Persistent Synchronization
  (async () => {
    try {
      const { exchangeConnections } = await import('../src/db/schema.ts');
      const { db } = await import('../src/db/index.ts');
      const { eq, and } = await import('drizzle-orm');

      const rawKey = record.encrypted_api_key || '';
      const masked = rawKey.length > 8 ? `${rawKey.slice(0, 4)}••••••••${rawKey.slice(-4)}` : '••••••••';

      const existing = await db.select().from(exchangeConnections)
        .where(and(eq(exchangeConnections.userId, record.user_id), eq(exchangeConnections.exchange, record.exchange)))
        .limit(1);

      if (existing.length > 0) {
        await db.update(exchangeConnections)
          .set({
            encryptedApiKey: record.encrypted_api_key,
            encryptedSecretKey: record.encrypted_api_secret,
            encryptedPassphrase: record.encrypted_api_passphrase,
            apiKeyMasked: masked,
            status: record.status,
            updatedAt: new Date(),
          })
          .where(eq(exchangeConnections.id, existing[0].id));
      } else {
        await db.insert(exchangeConnections).values({
          id: record.id,
          userId: record.user_id,
          exchange: record.exchange,
          encryptedApiKey: record.encrypted_api_key,
          encryptedSecretKey: record.encrypted_api_secret,
          encryptedPassphrase: record.encrypted_api_passphrase,
          apiKeyMasked: masked,
          status: record.status,
        });
      }
      console.log(`[POSTGRESQL SYNC] Exchange connection ${record.exchange} synced for user ${record.user_id}`);
    } catch (pgErr) {
      console.warn('[POSTGRESQL SYNC NOTICE] Failed syncing exchange connection to PostgreSQL:', pgErr);
    }
  })();

  return record;
}

/**
 * Retrieves all exchange connections strictly belonging to the given user_id.
 */
export function getUserExchangeConnections(userId: string): ExchangeConnectionRecord[] {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('SELECT * FROM exchange_connections WHERE user_id = ? ORDER BY created_at DESC');
      return stmt.all(userId) as unknown as ExchangeConnectionRecord[];
    } catch (err) {
      console.error('[DATABASE ERROR] Failed querying user exchange connections:', err);
    }
  }
  return readConnectionsBackup().filter((c) => c.user_id === userId);
}

/**
 * Retrieves a single connection by ID, ensuring user_id ownership matches.
 */
export function getUserExchangeConnectionById(userId: string, connectionId: string): ExchangeConnectionRecord | null {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('SELECT * FROM exchange_connections WHERE id = ? AND user_id = ?');
      const row = stmt.get(connectionId, userId) as unknown as ExchangeConnectionRecord | undefined;
      if (row) return row;
    } catch (err) {
      console.error('[DATABASE ERROR] Failed querying exchange connection by ID:', err);
    }
  }
  const match = readConnectionsBackup().find((c) => c.id === connectionId && c.user_id === userId);
  return match || null;
}

/**
 * Persistent cross-instance lookup for an exchange connection.
 * SQLite is checked first for local performance; PostgreSQL is the
 * authoritative shared fallback for Cloud Run instances.
 *
 * Ownership is ALWAYS enforced by both connection ID and user ID.
 */
export async function getUserExchangeConnectionByIdPersistent(
  userId: string,
  connectionId: string
): Promise<ExchangeConnectionRecord | null> {
  const local = getUserExchangeConnectionById(userId, connectionId);
  if (local) return local;

  try {
    const { eq, and } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(exchangeConnections)
      .where(
        and(
          eq(exchangeConnections.id, connectionId),
          eq(exchangeConnections.userId, userId)
        )
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const record: ExchangeConnectionRecord = {
      id: row.id,
      user_id: row.userId,
      exchange: row.exchange,
      encrypted_api_key: row.encryptedApiKey,
      encrypted_api_secret: row.encryptedSecretKey,
      encrypted_api_passphrase: row.encryptedPassphrase || null,
      status: row.status as ExchangeConnectionRecord['status'],
      is_live_trading_enabled: Number(row.isLiveTradingEnabled || 0),
      created_at: row.createdAt ? new Date(row.createdAt).getTime() : Date.now(),
      updated_at: row.updatedAt ? new Date(row.updatedAt).getTime() : Date.now(),
    };

    // Rehydrate the local instance so subsequent requests are fast.
    if (sqliteDb) {
      try {
        sqliteDb.prepare(`
          INSERT INTO exchange_connections (
            id, user_id, exchange, encrypted_api_key, encrypted_api_secret,
            encrypted_api_passphrase, status, is_live_trading_enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            exchange = excluded.exchange,
            encrypted_api_key = excluded.encrypted_api_key,
            encrypted_api_secret = excluded.encrypted_api_secret,
            encrypted_api_passphrase = excluded.encrypted_api_passphrase,
            status = excluded.status,
            is_live_trading_enabled = excluded.is_live_trading_enabled,
            updated_at = excluded.updated_at
        `).run(
          record.id,
          record.user_id,
          record.exchange,
          record.encrypted_api_key,
          record.encrypted_api_secret,
          record.encrypted_api_passphrase,
          record.status,
          record.is_live_trading_enabled ?? 0,
          record.created_at,
          record.updated_at
        );
      } catch (cacheErr) {
        console.warn('[DATABASE CACHE NOTICE] Failed rehydrating exchange connection:', cacheErr);
      }
    }

    console.log(
      `[POSTGRESQL LOOKUP] Recovered exchange connection id=${record.id}, user_id=${record.user_id}, exchange=${record.exchange}`
    );

    return record;
  } catch (err) {
    console.error('[POSTGRESQL LOOKUP ERROR] Failed persistent exchange connection lookup:', err);
    return null;
  }
}

/**
 * Persistent cross-instance lookup for a bot.
 * SQLite is checked first; PostgreSQL is the shared fallback.
 * Ownership is always enforced by bot ID + user ID.
 */
export async function getUserBotByIdPersistent(
  userId: string,
  botId: string
): Promise<BotRecord | null> {
  const local = getUserBotById(userId, botId);
  if (local) return local;

  try {
    const { eq, and } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(userBots)
      .where(
        and(
          eq(userBots.id, botId),
          eq(userBots.userId, userId)
        )
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    const record: BotRecord = {
      id: row.id,
      user_id: row.userId,
      exchange_connection_id: row.exchange,
      name: row.name,
      strategy: row.strategy,
      trading_pair: row.pair,
      capital_allocation: Number(row.capital) || 0,
      risk_settings: JSON.stringify({}),
      status: (row.status === 'RUNNING' || row.status === 'PAUSED' ? row.status : 'STOPPED'),
      created_at: Date.now(),
      updated_at: row.updatedAt ? new Date(row.updatedAt).getTime() : Date.now(),
    };

    if (sqliteDb) {
      try {
        sqliteDb.prepare(`
          INSERT INTO bots (
            id, user_id, exchange_connection_id, name, strategy,
            trading_pair, capital_allocation, risk_settings,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            exchange_connection_id = excluded.exchange_connection_id,
            name = excluded.name,
            strategy = excluded.strategy,
            trading_pair = excluded.trading_pair,
            capital_allocation = excluded.capital_allocation,
            status = excluded.status,
            updated_at = excluded.updated_at
        `).run(
          record.id,
          record.user_id,
          record.exchange_connection_id,
          record.name,
          record.strategy,
          record.trading_pair,
          record.capital_allocation,
          record.risk_settings,
          record.status,
          record.created_at,
          record.updated_at
        );
      } catch (cacheErr) {
        console.warn('[DATABASE CACHE NOTICE] Failed rehydrating bot:', cacheErr);
      }
    }

    console.log(
      `[POSTGRESQL LOOKUP] Recovered bot id=${record.id}, user_id=${record.user_id}`
    );

    return record;
  } catch (err) {
    console.error('[POSTGRESQL LOOKUP ERROR] Failed persistent bot lookup:', err);
    return null;
  }
}


/**
 * Retrieves a connection for a user by exchange name.
 */
export function getUserExchangeConnectionByExchange(userId: string, exchange: string): ExchangeConnectionRecord | null {
  const norm = exchange.toLowerCase();
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('SELECT * FROM exchange_connections WHERE user_id = ? AND LOWER(exchange) = ?');
      const row = stmt.get(userId, norm) as unknown as ExchangeConnectionRecord | undefined;
      if (row) return row;
    } catch (err) {
      console.error('[DATABASE ERROR] Failed querying connection by exchange:', err);
    }
  }
  const match = readConnectionsBackup().find((c) => c.user_id === userId && c.exchange.toLowerCase() === norm);
  return match || null;
}

/**
 * Deletes an exchange connection belonging to the user.
 */
export function deleteUserExchangeConnection(userId: string, connectionId: string): boolean {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('DELETE FROM exchange_connections WHERE id = ? AND user_id = ?');
      stmt.run(connectionId, userId);
      console.log(`[DATABASE] Deleted exchange connection: id=${connectionId}, user_id=${userId}`);
    } catch (err) {
      console.error('[DATABASE ERROR] Failed deleting exchange connection:', err);
    }
  }

  const allConns = readConnectionsBackup();
  const filtered = allConns.filter((c) => !(c.id === connectionId && c.user_id === userId));
  writeConnectionsBackup(filtered);
  return true;
}

/**
 * Updates status of an exchange connection.
 */
export function updateUserExchangeConnectionStatus(
  userId: string,
  connectionId: string,
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR'
): boolean {
  const now = Date.now();
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('UPDATE exchange_connections SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?');
      stmt.run(status, now, connectionId, userId);
      return true;
    } catch (err) {
      console.error('[DATABASE ERROR] Failed updating connection status:', err);
    }
  }

  const allConns = readConnectionsBackup();
  const conn = allConns.find((c) => c.id === connectionId && c.user_id === userId);
  if (conn) {
    conn.status = status;
    conn.updated_at = now;
    writeConnectionsBackup(allConns);
    return true;
  }
  return false;
}

/**
 * Updates capital sync fields for a connection.
 */
export function updateExchangeCapitalSync(
  userId: string,
  connectionId: string,
  data: {
    latest_balance?: number;
    latest_available_balance?: number;
    last_sync_time?: number;
    sync_status?: 'SYNCED' | 'STALE' | 'ERROR' | 'PENDING';
    sync_error?: string | null;
    capital_mode?: 'AUTO_SYNC' | 'FIXED_ALLOCATION';
    configured_allocation?: number;
  }
): boolean {
  const now = Date.now();
  if (sqliteDb) {
    try {
      const updates: string[] = ['updated_at = ?'];
      const values: any[] = [now];

      if (data.latest_balance !== undefined) {
        updates.push('latest_balance = ?');
        values.push(data.latest_balance);
      }
      if (data.latest_available_balance !== undefined) {
        updates.push('latest_available_balance = ?');
        values.push(data.latest_available_balance);
      }
      if (data.last_sync_time !== undefined) {
        updates.push('last_sync_time = ?');
        values.push(data.last_sync_time);
      }
      if (data.sync_status !== undefined) {
        updates.push('sync_status = ?');
        values.push(data.sync_status);
      }
      if (data.sync_error !== undefined) {
        updates.push('sync_error = ?');
        values.push(data.sync_error);
      }
      if (data.capital_mode !== undefined) {
        updates.push('capital_mode = ?');
        values.push(data.capital_mode);
      }
      if (data.configured_allocation !== undefined) {
        updates.push('configured_allocation = ?');
        values.push(data.configured_allocation);
      }

      values.push(connectionId, userId);
      const query = `UPDATE exchange_connections SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
      sqliteDb.prepare(query).run(...values);
    } catch (err) {
      console.error('[DATABASE ERROR] Failed updating exchange capital sync:', err);
    }
  }

  const allConns = readConnectionsBackup();
  const conn = allConns.find((c) => c.id === connectionId && c.user_id === userId);
  if (conn) {
    if (data.latest_balance !== undefined) conn.latest_balance = data.latest_balance;
    if (data.latest_available_balance !== undefined) conn.latest_available_balance = data.latest_available_balance;
    if (data.last_sync_time !== undefined) conn.last_sync_time = data.last_sync_time;
    if (data.sync_status !== undefined) conn.sync_status = data.sync_status;
    if (data.sync_error !== undefined) conn.sync_error = data.sync_error;
    if (data.capital_mode !== undefined) conn.capital_mode = data.capital_mode;
    if (data.configured_allocation !== undefined) conn.configured_allocation = data.configured_allocation;
    conn.updated_at = now;
    writeConnectionsBackup(allConns);
    return true;
  }
  return false;
}

/**
 * Updates live trading permission flag for a connection.
 */
async function ensurePostgresLiveTradingColumn(): Promise<void> {
  try {
    await db.execute(sql`
      ALTER TABLE exchange_connections
      ADD COLUMN IF NOT EXISTS is_live_trading_enabled INTEGER NOT NULL DEFAULT 0
    `);
  } catch (err) {
    console.error('[POSTGRESQL MIGRATION] Failed ensuring is_live_trading_enabled column:', err);
    throw err;
  }
}

export async function setExchangeLiveTrading(
  userId: string,
  connectionId: string,
  enabled: boolean
): Promise<boolean> {
  const now = Date.now();
  const flag = enabled ? 1 : 0;

  // Durable source of truth: persist the explicit user's live-trading choice
  // in PostgreSQL, scoped to BOTH connection ID and authenticated user ID.
  try {
    await ensurePostgresLiveTradingColumn();

    await db
      .update(exchangeConnections)
      .set({
        isLiveTradingEnabled: flag,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(exchangeConnections.id, connectionId),
          eq(exchangeConnections.userId, userId)
        )
      );

    console.log(
      `[POSTGRESQL LIVE TRADING] ${enabled ? 'ENABLED' : 'DISABLED'} connection=${connectionId} user=${userId}`
    );
  } catch (err) {
    console.error('[POSTGRESQL LIVE TRADING] Failed persisting live trading state:', err);
    return false;
  }

  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('UPDATE exchange_connections SET is_live_trading_enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?');
      stmt.run(flag, now, connectionId, userId);
    } catch (err) {
      console.error('[DATABASE ERROR] Failed setting exchange live trading status:', err);
    }
  }

  const allConns = readConnectionsBackup();
  const conn = allConns.find((c) => c.id === connectionId && c.user_id === userId);
  if (conn) {
    conn.is_live_trading_enabled = flag;
    conn.updated_at = now;
    writeConnectionsBackup(allConns);
    return true;
  }
  return false;
}

/* =========================================================================
   MULTI-USER BOTS CRUD OPERATIONS
   ========================================================================= */

function readBotsBackup(): BotRecord[] {
  if (fs.existsSync(BOTS_BACKUP_PATH)) {
    try {
      const raw = fs.readFileSync(BOTS_BACKUP_PATH, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

function writeBotsBackup(records: BotRecord[]): void {
  try {
    fs.writeFileSync(BOTS_BACKUP_PATH, JSON.stringify(records, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DATABASE] Failed writing bots backup:', err);
  }
}

/**
 * Creates a new bot tied to a specific user and their exchange connection.
 * Default status is STOPPED (BOT_DEFAULT_STATUS=stopped) to prevent unintended auto-trading.
 */
export function createUserBot(data: {
  id?: string;
  user_id: string;
  exchange_connection_id: string;
  name: string;
  strategy: string;
  trading_pair: string;
  capital_allocation: number;
  risk_settings: any;
  status?: 'STOPPED' | 'RUNNING' | 'PAUSED';
}): BotRecord {
  const now = Date.now();
  const botId = data.id || `bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  
  // Safe default: STOPPED
  const botStatus = data.status || 'STOPPED';
  const riskSettingsStr = typeof data.risk_settings === 'string' ? data.risk_settings : JSON.stringify(data.risk_settings);

  const record: BotRecord = {
    id: botId,
    user_id: data.user_id,
    exchange_connection_id: data.exchange_connection_id,
    name: data.name,
    strategy: data.strategy,
    trading_pair: data.trading_pair,
    capital_allocation: Number(data.capital_allocation) || 1000,
    risk_settings: riskSettingsStr,
    status: botStatus,
    created_at: now,
    updated_at: now,
  };

  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare(`
        INSERT INTO bots (
          id, user_id, exchange_connection_id, name, strategy, trading_pair, capital_allocation, risk_settings, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          exchange_connection_id = excluded.exchange_connection_id,
          name = excluded.name,
          strategy = excluded.strategy,
          trading_pair = excluded.trading_pair,
          capital_allocation = excluded.capital_allocation,
          risk_settings = excluded.risk_settings,
          status = excluded.status,
          updated_at = excluded.updated_at;
      `);
      stmt.run(
        record.id,
        record.user_id,
        record.exchange_connection_id,
        record.name,
        record.strategy,
        record.trading_pair,
        record.capital_allocation,
        record.risk_settings,
        record.status,
        record.created_at,
        record.updated_at
      );
      console.log(`[DATABASE] Created/Updated user bot: id=${record.id}, user_id=${record.user_id}, status=${record.status}`);
    } catch (err) {
      console.error('[DATABASE ERROR] Failed saving bot to SQLite:', err);
    }
  }

  const allBots = readBotsBackup();
  const idx = allBots.findIndex((b) => b.id === record.id);
  if (idx >= 0) {
    record.created_at = allBots[idx].created_at;
    allBots[idx] = record;
  } else {
    allBots.push(record);
  }
  writeBotsBackup(allBots);

  // Cloud SQL PostgreSQL Persistent Synchronization
  (async () => {
    try {
      const { userBots } = await import('../src/db/schema.ts');
      const { db } = await import('../src/db/index.ts');
      const { eq } = await import('drizzle-orm');

      const existing = await db.select().from(userBots).where(eq(userBots.id, record.id)).limit(1);
      if (existing.length > 0) {
        await db.update(userBots).set({
          name: record.name,
          exchange: record.exchange_connection_id,
          strategy: record.strategy,
          pair: record.trading_pair,
          capital: record.capital_allocation,
          status: record.status,
          updatedAt: new Date(),
        }).where(eq(userBots.id, record.id));
      } else {
        await db.insert(userBots).values({
          id: record.id,
          userId: record.user_id,
          name: record.name,
          exchange: record.exchange_connection_id,
          strategy: record.strategy,
          pair: record.trading_pair,
          capital: record.capital_allocation,
          status: record.status,
        });
      }
      console.log(`[POSTGRESQL SYNC] Bot ${record.id} synced to PostgreSQL for user ${record.user_id}`);
    } catch (pgErr) {
      console.warn('[POSTGRESQL SYNC NOTICE] Failed syncing bot to PostgreSQL:', pgErr);
    }
  })();

  return record;
}

/**
 * Retrieves all bots owned by the given user.
 */
export function getUserBots(userId: string): BotRecord[] {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at DESC');
      return stmt.all(userId) as unknown as BotRecord[];
    } catch (err) {
      console.error('[DATABASE ERROR] Failed querying user bots:', err);
    }
  }
  return readBotsBackup().filter((b) => b.user_id === userId);
}

/**
 * Retrieves a single bot by ID, strictly verifying user ownership.
 */
export function getUserBotById(userId: string, botId: string): BotRecord | null {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?');
      const row = stmt.get(botId, userId) as unknown as BotRecord | undefined;
      if (row) return row;
    } catch (err) {
      console.error('[DATABASE ERROR] Failed querying user bot by ID:', err);
    }
  }
  const match = readBotsBackup().find((b) => b.id === botId && b.user_id === userId);
  return match || null;
}

/**
 * Updates a user bot with ownership check.
 */
export function updateUserBot(
  userId: string,
  botId: string,
  updates: Partial<Omit<BotRecord, 'id' | 'user_id' | 'created_at'>>
): BotRecord | null {
  const now = Date.now();
  if (sqliteDb) {
    try {
      const current = getUserBotById(userId, botId);
      if (!current) return null;
      const updated = { ...current, ...updates, updated_at: now };
      const stmt = sqliteDb.prepare(`
        UPDATE bots
        SET name = ?, strategy = ?, trading_pair = ?, capital_allocation = ?, risk_settings = ?, status = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `);
      stmt.run(
        updated.name,
        updated.strategy,
        updated.trading_pair,
        updated.capital_allocation,
        typeof updated.risk_settings === 'string' ? updated.risk_settings : JSON.stringify(updated.risk_settings),
        updated.status,
        now,
        botId,
        userId
      );
    } catch (err) {
      console.error('[DATABASE ERROR] Failed updating bot in SQLite:', err);
    }
  }

  const allBots = readBotsBackup();
  const idx = allBots.findIndex((b) => b.id === botId && b.user_id === userId);
  if (idx >= 0) {
    allBots[idx] = { ...allBots[idx], ...updates, updated_at: now };
    writeBotsBackup(allBots);
    return allBots[idx];
  }
  return null;
}

/**
 * Updates a user bot's status (STOPPED, RUNNING, PAUSED) with ownership check.
 */
export function updateUserBotStatus(userId: string, botId: string, status: 'STOPPED' | 'RUNNING' | 'PAUSED'): boolean {
  const now = Date.now();
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('UPDATE bots SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?');
      stmt.run(status, now, botId, userId);
      return true;
    } catch (err) {
      console.error('[DATABASE ERROR] Failed updating bot status in SQLite:', err);
    }
  }

  const allBots = readBotsBackup();
  const bot = allBots.find((b) => b.id === botId && b.user_id === userId);
  if (bot) {
    bot.status = status;
    bot.updated_at = now;
    writeBotsBackup(allBots);
    return true;
  }
  return false;
}

/**
 * Deletes a bot belonging to the user.
 */
export function deleteUserBot(userId: string, botId: string): boolean {
  if (sqliteDb) {
    try {
      const stmt = sqliteDb.prepare('DELETE FROM bots WHERE id = ? AND user_id = ?');
      stmt.run(botId, userId);
    } catch (err) {
      console.error('[DATABASE ERROR] Failed deleting bot from SQLite:', err);
    }
  }

  const allBots = readBotsBackup();
  const filtered = allBots.filter((b) => !(b.id === botId && b.user_id === userId));
  writeBotsBackup(filtered);
  return true;
}
