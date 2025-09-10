create table if not exists public.rides (
  id text primary key,
  pickup_lat double precision not null,
  pickup_lng double precision not null,
  dropoff_lat double precision not null,
  dropoff_lng double precision not null,
  ride_type text not null check (ride_type in ('standard','premium','xl')),
  status text not null check (status in ('requested','matched','accepted','in_progress','completed','cancelled')),
  quote_usd numeric(10,2),
  driver_id text,
  payment_intent_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rides_status_idx on public.rides(status);
create index if not exists rides_created_at_idx on public.rides(created_at desc);
