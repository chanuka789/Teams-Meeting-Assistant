// Postgres: users, sessions, competencies, documents, searchable chunks and usage.
// Migrations are idempotent and run at start-up.

import pg from 'pg';
import { SEED_COMPETENCIES } from './competencies.js';

const { Pool } = pg;

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Railway's private network does not use TLS; public URLs do
      ssl: /sslmode=require/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
      max: 10,
    })
  : null;

export async function q(text, params) {
  if (!pool) throw new Error('DATABASE_URL is not set.');
  return pool.query(text, params);
}

const MIGRATION = `
create table if not exists users (
  id serial primary key,
  username text unique not null,
  name text not null,
  password_hash text not null,
  role text not null default 'user' check (role in ('admin', 'user')),
  profile text not null default '',
  notes text not null default '',
  prefs jsonb not null default '{}',
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists sessions (
  token_hash text primary key,
  user_id int not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user on sessions(user_id);

create table if not exists competencies (
  id serial primary key,
  name text not null,
  category text not null check (category in ('mandatory', 'core', 'optional', 'general')),
  level smallint,
  sort int not null default 0
);

create table if not exists documents (
  id serial primary key,
  scope text not null check (scope in ('library', 'case_study')),
  competency_id int references competencies(id) on delete set null,
  owner_id int references users(id) on delete cascade,
  name text not null,
  mime text,
  size int not null default 0,
  storage_key text not null,
  chars int not null default 0,
  uploaded_by int references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists documents_scope on documents(scope, owner_id);

create table if not exists chunks (
  id bigserial primary key,
  document_id int not null references documents(id) on delete cascade,
  idx int not null,
  text text not null,
  tsv tsvector generated always as (to_tsvector('english', text)) stored
);
create index if not exists chunks_tsv on chunks using gin(tsv);
create index if not exists chunks_doc on chunks(document_id);

create table if not exists usage (
  id bigserial primary key,
  user_id int references users(id) on delete set null,
  kind text not null,
  cost double precision not null,
  at timestamptz not null default now()
);
create index if not exists usage_user_at on usage(user_id, at);

-- Full extracted text, so the chat viewer can show a document and highlight cited passages
alter table documents add column if not exists text text;

create table if not exists chats (
  id serial primary key,
  user_id int not null references users(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chats_user on chats(user_id, updated_at desc);

create table if not exists chat_messages (
  id bigserial primary key,
  chat_id int not null references chats(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb not null default '[]',
  model text,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_chat on chat_messages(chat_id, id);
alter table chats add column if not exists pinned boolean not null default false;
-- What OpenRouter charged for a chat reply (answer plus its follow-up suggestions), USD
alter table chat_messages add column if not exists cost double precision;
`;

export async function migrate() {
  await q(MIGRATION);
  const { rows } = await q('select count(*)::int as n from competencies');
  if (rows[0].n === 0) {
    for (const [i, c] of SEED_COMPETENCIES.entries()) {
      await q('insert into competencies (name, category, level, sort) values ($1, $2, $3, $4)', [c.name, c.category, c.level, i]);
    }
  }
  await q('delete from sessions where expires_at < now()');
}
