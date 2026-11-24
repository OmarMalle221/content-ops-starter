-- Site exportateur : schéma initial.
--
-- Modèle aligné sur l'ERP CargoFlow (tenant_id, shipments, shipment_events).
-- Sécurité : RLS activé partout, AUCUNE policy. Les rôles `anon` et
-- `authenticated` n'ont accès à rien ; seules les fonctions Netlify lisent et
-- écrivent, avec la clé de service (qui contourne RLS).

-- Cette migration ne touche qu'à ses propres objets : elle peut être appliquée
-- dans un projet dédié comme dans celui de l'ERP, à côté des tables existantes.

create schema if not exists extensions;
create extension if not exists citext with schema extensions;

-- ── Statuts normalisés, dans l'ordre du parcours ───────────────────────────
-- Garder cette liste identique à `src/lib/statuses.ts`.
create domain shipment_status as text check (value in (
  'received_at_warehouse',   -- Reçu à l'entrepôt
  'loaded_in_container',     -- Chargé en conteneur
  'delivered_to_port',       -- Livré au port
  'on_board',                -- À bord
  'arrived_at_destination',  -- Arrivé au port de destination
  'available_delivered'      -- Disponible / Livré
));

-- ── Demandes de devis ──────────────────────────────────────────────────────
create sequence quote_ref_seq start 1001;

create table quote_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  -- Numéro communiqué au visiteur, ex. DV-26-01001.
  reference       text not null unique
                  default 'DV-' || to_char(now(), 'YY') || '-' || lpad(nextval('quote_ref_seq')::text, 5, '0'),
  full_name       text not null,
  phone           text not null,
  email           citext not null,
  shipment_type   text not null check (shipment_type in ('vehicle', 'full_container', 'groupage', 'other')),
  vehicle_make    text,
  vehicle_model   text,
  vehicle_year    smallint check (vehicle_year between 1950 and 2100),
  vehicle_running boolean,
  container_size  text check (container_size in ('20', '40')),
  destination     text not null,
  desired_date    date,
  message         text,
  locale          text not null default 'fr',
  -- Loi 25 : sans consentement explicite, l'insertion est refusée.
  consent_given   boolean not null check (consent_given),
  consent_at      timestamptz not null default now(),
  consent_policy_version text not null,
  status          text not null default 'new' check (status in ('new', 'contacted', 'quoted', 'won', 'lost')),
  created_at      timestamptz not null default now()
);
create index quote_requests_tenant_created_idx on quote_requests (tenant_id, created_at desc);

-- ── Expéditions ────────────────────────────────────────────────────────────
create table shipments (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  reference        text not null,              -- numéro de dossier, en majuscules
  container_number text,                       -- en majuscules, sans espace
  origin_port      text not null,
  destination_port text not null,
  eta              date,
  current_status   shipment_status not null default 'received_at_warehouse',
  internal_note    text,                       -- usage interne, jamais renvoyé par le suivi public
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, reference)
);
create index shipments_tenant_container_idx on shipments (tenant_id, container_number);
create index shipments_tenant_created_idx on shipments (tenant_id, created_at desc);

create table shipment_events (
  id          uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments (id) on delete cascade,
  status      shipment_status not null,
  occurred_at timestamptz not null default now(),
  location    text,
  source      text not null default 'manual' check (source in ('manual', 'carrier_api')),
  raw_payload jsonb,                           -- réponse brute de l'API du transporteur, le cas échéant
  created_at  timestamptz not null default now()
);
create index shipment_events_shipment_idx on shipment_events (shipment_id, occurred_at);

-- `shipments.current_status` suit toujours l'étape la plus récente, y compris
-- après la correction ou la suppression d'une étape saisie par erreur.
create function sync_shipment_status() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_shipment_id uuid := coalesce(new.shipment_id, old.shipment_id);
begin
  update shipments s
     set current_status = coalesce(
           (select e.status
              from shipment_events e
             where e.shipment_id = v_shipment_id
             order by e.occurred_at desc, e.created_at desc
             limit 1),
           s.current_status
         ),
         updated_at = now()
   where s.id = v_shipment_id;
  return null;
end;
$$;

create trigger trg_sync_shipment_status
  after insert or update or delete on shipment_events
  for each row execute function sync_shipment_status();

-- ── Accès à l'administration ───────────────────────────────────────────────
-- Seuls les courriels listés ici peuvent se connecter à /admin.
create table admin_users (
  email      citext primary key,
  tenant_id  uuid not null,
  created_at timestamptz not null default now()
);

-- ── Limite de débit ────────────────────────────────────────────────────────
-- Les fonctions Netlify n'ont pas de mémoire entre deux appels : le compteur vit ici.
create table rate_limits (
  bucket       text not null,          -- 'quote' | 'track' | 'admin-auth'
  key_hash     text not null,          -- SHA-256(IP + sel) : jamais l'adresse IP en clair
  window_start timestamptz not null,
  hits         integer not null default 1,
  primary key (bucket, key_hash, window_start)
);

-- Compte un appel et dit s'il est autorisé : `true` tant que le nombre d'appels
-- de la fenêtre courante ne dépasse pas `p_max`.
create function check_rate_limit(p_bucket text, p_key_hash text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits   integer;
begin
  insert into rate_limits as r (bucket, key_hash, window_start)
  values (p_bucket, p_key_hash, v_window)
  on conflict (bucket, key_hash, window_start) do update set hits = r.hits + 1
  returning r.hits into v_hits;

  -- Ménage occasionnel des fenêtres expirées.
  if random() < 0.02 then
    delete from rate_limits where window_start < now() - interval '1 day';
  end if;

  return v_hits <= p_max;
end;
$$;

-- ── Sécurité ───────────────────────────────────────────────────────────────
alter table quote_requests  enable row level security;
alter table shipments       enable row level security;
alter table shipment_events enable row level security;
alter table admin_users     enable row level security;
alter table rate_limits     enable row level security;

-- Uniquement les objets de cette migration : les droits des autres tables du
-- projet (celles de l'ERP, par exemple) ne sont pas modifiés.
revoke all on table quote_requests, shipments, shipment_events, admin_users, rate_limits from anon, authenticated;
revoke all on sequence quote_ref_seq from anon, authenticated;
revoke execute on function check_rate_limit(text, text, integer, integer) from public, anon, authenticated;
revoke execute on function sync_shipment_status() from public, anon, authenticated;
grant  execute on function check_rate_limit(text, text, integer, integer) to service_role;
