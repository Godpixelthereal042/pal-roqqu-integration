-- Roqqu payment links for invoices (hackathon integration, test mode).
--
-- Members read their workspace's links; owner/admin/member create them, like
-- invoices. Only the service role changes a link's status (from the Roqqu
-- webhook), so no browser can mark a payment as paid.

create table public.invoice_payment_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  invoice_id text not null references public.invoices (id) on delete cascade,
  payment_reference text not null unique check (payment_reference ~ '^[A-Za-z0-9]{1,20}$'),
  refid text not null,
  payment_link text not null check (payment_link like 'https://%'),
  amount_required text not null,
  amount_currency text not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  transaction_hash text,
  expires_at timestamptz not null,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at bigint not null default public.epoch_ms_now(),
  updated_at bigint not null default public.epoch_ms_now()
);

create index invoice_payment_links_workspace_idx on public.invoice_payment_links (workspace_id, created_at desc);
create index invoice_payment_links_invoice_idx on public.invoice_payment_links (invoice_id);

create trigger invoice_payment_links_set_updated_at before update on public.invoice_payment_links
  for each row execute function private.set_updated_at();

alter table public.invoice_payment_links enable row level security;

revoke all on public.invoice_payment_links from anon, authenticated;
grant all on public.invoice_payment_links to service_role;
grant select, insert on public.invoice_payment_links to authenticated;

create policy invoice_payment_links_select_member on public.invoice_payment_links
  for select to authenticated using (app_security.is_workspace_member(workspace_id));
create policy invoice_payment_links_insert_contributor on public.invoice_payment_links
  for insert to authenticated
  with check (
    app_security.has_workspace_role(workspace_id, array['owner', 'admin', 'member']::public.workspace_role[])
    and created_by = (select auth.uid())
    and status = 'pending'
    and exists (
      select 1 from public.invoices i
      where i.id = invoice_id and i.workspace_id = invoice_payment_links.workspace_id
    )
  );

select private.assert_security_invariants();
