-- db/schema.sql
create table if not exists pages (
  id          bigserial primary key,
  property    text        not null,
  url         text        not null unique,
  title       text,
  description text,
  content     text        not null default '',
  lastmod     timestamptz,
  status      int         not null default 0,
  indexed_at  timestamptz not null default now(),
  tsv tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored
);

create index if not exists pages_tsv_idx      on pages using gin (tsv);
create index if not exists pages_property_idx on pages (property);
create index if not exists pages_lastmod_idx  on pages (lastmod desc nulls last);
