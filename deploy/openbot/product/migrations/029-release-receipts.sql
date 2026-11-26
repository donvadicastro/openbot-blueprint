-- Once recorded, an effect receipt and its independent verification cannot change.
create or replace function bp_preserve_release_receipt() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception 'release effects cannot be deleted' using errcode='23514';
  end if;
  if tg_op='UPDATE' and (old.state='Confirmed' or
      (old.receipt is not null and new.receipt is distinct from old.receipt) or
      (old.verification is not null and new.verification is distinct from old.verification)) then
    raise exception 'confirmed release evidence cannot be changed' using errcode='23514';
  end if;
  if new.state='Confirmed' and (new.receipt is null or new.verification is null) then
    raise exception 'a confirmed release requires a receipt and verification' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists bp_release_receipt_immutable on bp_release_effects;
create trigger bp_release_receipt_immutable before insert or update or delete on bp_release_effects
  for each row execute function bp_preserve_release_receipt();
