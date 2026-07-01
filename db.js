"use strict";

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "levels.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    guild_id INTEGER, user_id INTEGER,
    xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id               INTEGER PRIMARY KEY,
    levels_enabled         INTEGER DEFAULT 1,
    prefix                 TEXT    DEFAULT '!',
    levelup_enabled        INTEGER DEFAULT 1,
    levelup_channel        INTEGER,
    antispam_enabled       INTEGER DEFAULT 0,
    antispam_threshold     INTEGER DEFAULT 5,
    antispam_window        INTEGER DEFAULT 5,
    antispam_action        TEXT    DEFAULT 'warn',
    automod_action         TEXT    DEFAULT 'delete',
    antilink_enabled       INTEGER DEFAULT 0,
    antilink_exempt_roles  TEXT    DEFAULT '',
    welcome_channel        INTEGER,
    welcome_message        TEXT    DEFAULT '',
    leave_channel          INTEGER,
    leave_message          TEXT    DEFAULT '',
    auto_role_id           INTEGER,
    log_channel            INTEGER,
    ticket_channel         INTEGER,
    ticket_category        INTEGER,
    ticket_support_role    INTEGER,
    ticket_title           TEXT    DEFAULT '🎫 الدعم الفني',
    ticket_description     TEXT    DEFAULT 'اضغط الزر أدناه لفتح تكت دعم فني'
  );
  CREATE TABLE IF NOT EXISTS level_roles (
    guild_id INTEGER, level INTEGER, role_id INTEGER, role_name TEXT DEFAULT '',
    PRIMARY KEY (guild_id, level)
  );
  CREATE TABLE IF NOT EXISTS auto_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER, trigger TEXT, response TEXT,
    match_type TEXT DEFAULT 'contains',
    UNIQUE(guild_id, trigger)
  );
  CREATE TABLE IF NOT EXISTS warn_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER, user_id INTEGER, moderator_id INTEGER,
    reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
  );
  CREATE TABLE IF NOT EXISTS banned_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER, word TEXT,
    UNIQUE(guild_id, word)
  );
`);

// Migrate older schemas safely
const migrations = [
  ["levelup_enabled", "INTEGER DEFAULT 1"],
  ["levelup_channel", "INTEGER"],
  ["antispam_enabled", "INTEGER DEFAULT 0"],
  ["antispam_threshold", "INTEGER DEFAULT 5"],
  ["antispam_window", "INTEGER DEFAULT 5"],
  ["antispam_action", "TEXT DEFAULT 'warn'"],
  ["automod_action", "TEXT DEFAULT 'delete'"],
  ["antilink_enabled", "INTEGER DEFAULT 0"],
  ["antilink_exempt_roles", "TEXT DEFAULT ''"],
  ["welcome_channel", "INTEGER"],
  ["welcome_message", "TEXT DEFAULT ''"],
  ["leave_channel", "INTEGER"],
  ["leave_message", "TEXT DEFAULT ''"],
  ["auto_role_id", "INTEGER"],
  ["log_channel", "INTEGER"],
  ["ticket_channel", "INTEGER"],
  ["ticket_category", "INTEGER"],
  ["ticket_support_role", "INTEGER"],
  ["ticket_title", "TEXT DEFAULT '🎫 الدعم الفني'"],
  ["ticket_description", "TEXT DEFAULT 'اضغط الزر أدناه لفتح تكت دعم فني'"],
];
for (const [col, defn] of migrations) {
  try {
    db.exec(`ALTER TABLE guild_settings ADD COLUMN ${col} ${defn}`);
  } catch {
    /* already exists */
  }
}

console.log("[DB] ✅ initialized:", DB_PATH);

module.exports = db;
