import { query } from '../config/db.js';

// Business contact details the admin edits in the dashboard. They are public by
// design: the storefront shows them in the footer and the legal pages.
const toDto = (row) => ({
  supportEmail: row?.support_email || '',
  supportPhone: row?.support_phone || '',
  postalAddress: row?.postal_address || '',
  updatedAt: row?.updated_at || null,
});

export async function getStoreSettings() {
  const { rows } = await query('select * from public.store_settings where id');
  return toDto(rows[0]);
}

/** Partial update; only the fields present in `changes` are written. */
export async function updateStoreSettings(adminId, changes) {
  const { rows } = await query(
    `insert into public.store_settings (id, support_email, support_phone, postal_address, updated_by)
     values (true, coalesce($1, ''), coalesce($2, ''), coalesce($3, ''), $4)
     on conflict (id) do update
       set support_email  = coalesce($1, public.store_settings.support_email),
           support_phone  = coalesce($2, public.store_settings.support_phone),
           postal_address = coalesce($3, public.store_settings.postal_address),
           updated_by     = $4
     returning *`,
    [changes.supportEmail ?? null, changes.supportPhone ?? null, changes.postalAddress ?? null, adminId],
  );
  return toDto(rows[0]);
}
