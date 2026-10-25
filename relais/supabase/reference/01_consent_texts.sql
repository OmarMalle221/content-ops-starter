-- FICHIER GÉNÉRÉ par scripts/generate-reference-sql.mjs à partir de src/content/consent-texts.fr.json. Ne pas modifier.

create temporary table _expected_consent_texts (
    consent_type public.consent_type, version text, sha256 text, published_on date
) on commit drop;

insert into _expected_consent_texts values
    ('privacy_policy'::public.consent_type, '2026-10-26', '62ca9cf317f42fa4ccfac58489b01e8a83675197147d29b8f10c63a282257660', '2026-10-26'::date),
    ('health_information'::public.consent_type, '2026-10-26', '85dea6553720aed432a97d689a96713bf7a7b25a01aa4b78a88a11eadef369c0', '2026-10-26'::date),
    ('email_reminders'::public.consent_type, '2026-10-26', 'b3747ce8de2ba3aac54be45cc9f37abe92503c503fb7caf0734aad6f8d7b6dfc', '2026-10-26'::date),
    ('pilot_evaluation'::public.consent_type, '2026-10-26', 'e5e88f2f8c320bc9787fc34d4369bfdff268c65f6124f30ece985ec5b8e8a048', '2026-10-26'::date),
    ('care_recipient_data'::public.consent_type, '2026-10-27', 'f54e3b2cdac0a1603e6f41166c073c7e9ba43ec657a78289468dd2381a1e9204', '2026-10-27'::date);

insert into public.consent_texts (consent_type, version, sha256, published_on)
select consent_type, version, sha256, published_on from _expected_consent_texts
on conflict (consent_type, version) do nothing;

do $$
begin
    if exists (
        select 1 from public.consent_texts t
        join _expected_consent_texts e using (consent_type, version)
        where t.sha256 <> e.sha256
    ) then
        raise exception 'a published consent text changed without a new version';
    end if;
end;
$$;
