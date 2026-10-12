import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  uid: text('uid').primaryKey(),
  email: text('email'),
  displayName: text('display_name'),
  photoUrl: text('photo_url'),
});

export const exchangeConnections = pgTable('exchange_connections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  exchange: text('exchange').notNull(),
  encryptedApiKey: text('encrypted_api_key').notNull(),
  encryptedSecretKey: text('encrypted_secret_key').notNull(),
  encryptedPassphrase: text('encrypted_passphrase'),
  apiKeyMasked: text('api_key_masked'),
  status: text('status').notNull(),
  isLiveTradingEnabled: integer('is_live_trading_enabled').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const userBots = pgTable('user_bots', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  exchange: text('exchange').notNull(),
  strategy: text('strategy').notNull(),
  pair: text('pair').notNull(),
  capital: real('capital').notNull(),
  status: text('status').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
