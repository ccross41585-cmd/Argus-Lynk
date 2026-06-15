-- Command delivery lifecycle tracking for Field Lynk controls.
-- Adds stage timestamps and client correlation id so the PWA can show
-- delivery confidence from phone -> Supabase -> gateway -> field node.

alter table if exists public.device_commands
  add column if not exists client_command_id text null,
  add column if not exists gateway_received_at timestamptz null,
  add column if not exists sent_to_node_at timestamptz null,
  add column if not exists node_acknowledged_at timestamptz null,
  add column if not exists verified_at timestamptz null,
  add column if not exists failed_at timestamptz null;

create index if not exists idx_device_commands_client_command_id
  on public.device_commands (client_command_id);
