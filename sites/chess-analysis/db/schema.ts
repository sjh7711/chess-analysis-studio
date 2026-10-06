import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

export const players = sqliteTable('players', {
  userId:text('user_id').primaryKey(), nickname:text('nickname').notNull(),
  friendCode:text('friend_code').notNull(), createdAt:integer('created_at').notNull(),
},t=>[uniqueIndex('players_friend_code').on(t.friendCode)]);
export const games = sqliteTable('games', {
  id:text('id').primaryKey(),ownerUser:text('owner_user').notNull(),guestUser:text('guest_user'),targetUser:text('target_user'),
  status:text('status').notNull(),revision:integer('revision').notNull().default(0),stateJson:text('state_json').notNull(),
  createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),
},t=>[index('games_owner_updated').on(t.ownerUser,t.updatedAt),index('games_guest_updated').on(t.guestUser,t.updatedAt),index('games_target_status').on(t.targetUser,t.status)]);
export const friends = sqliteTable('friends', {
  ownerUser:text('owner_user').notNull().references(()=>players.userId),
  friendUser:text('friend_user').notNull().references(()=>players.userId),
  createdAt:integer('created_at').notNull(),
},t=>[primaryKey({columns:[t.ownerUser,t.friendUser]})]);

export const accounts = sqliteTable('accounts', {
  userId:text('user_id').primaryKey(), nicknameKey:text('nickname_key').notNull(),
  passwordHash:text('password_hash').notNull(), chatgptId:text('chatgpt_id'),
  version:integer('version').notNull().default(1), createdAt:integer('created_at').notNull(),
},t=>[uniqueIndex('accounts_nickname').on(t.nicknameKey),uniqueIndex('accounts_chatgpt').on(t.chatgptId)]);
export const sessions = sqliteTable('account_sessions', {
  tokenHash:text('token_hash').primaryKey(), userId:text('user_id').notNull(),
  version:integer('version').notNull(), method:text('method').notNull(),
  createdAt:integer('created_at').notNull(), expiresAt:integer('expires_at').notNull(),
},t=>[index('sessions_user').on(t.userId),index('sessions_expiry').on(t.expiresAt)]);
export const authLimits = sqliteTable('auth_limits', {
  key:text('key').primaryKey(), startedAt:integer('started_at').notNull(), count:integer('count').notNull(),
});
export const authIntents = sqliteTable('auth_intents', {
  tokenHash:text('token_hash').primaryKey(), mode:text('mode').notNull(), userId:text('user_id'),
  expiresAt:integer('expires_at').notNull(),
});
