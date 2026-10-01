-- À exécuter dans Supabase : Dashboard > SQL Editor > New query > colle tout ça > Run

-- 1. Active l'extension pgvector (nécessaire pour stocker et comparer les embeddings)
create extension if not exists vector;

-- 2. Table principale du catalogue
create table if not exists items (
  id uuid default gen_random_uuid() primary key,
  name text,
  shop text not null,
  address text,
  size text,
  price text not null,
  category text,
  image_url text,
  embedding vector(512),
  created_at timestamptz default now()
);

-- 3. Fonction de recherche par similarité (distance cosinus)
create or replace function match_items(query_embedding vector(512), match_count int)
returns table (
  id uuid,
  name text,
  shop text,
  address text,
  size text,
  price text,
  category text,
  image_url text,
  similarity float
)
language sql stable
as $$
  select id, name, shop, address, size, price, category, image_url,
         1 - (embedding <=> query_embedding) as similarity
  from items
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- 4. Bucket de stockage public pour les photos
insert into storage.buckets (id, name, public)
values ('items', 'items', true)
on conflict (id) do nothing;

-- 5. Autorise la lecture publique des photos du bucket
create policy if not exists "Public read access"
on storage.objects for select
using (bucket_id = 'items');
