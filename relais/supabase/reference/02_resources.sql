-- FICHIER GÉNÉRÉ par scripts/generate-reference-sql.mjs à partir de src/content/emergency-resources.json. Ne pas modifier.

-- Fiches de départ, toutes « à vérifier ». Les modifications faites ensuite par l'admin sont conservées.
insert into public.resources
    (slug, category, name, organization, phone, sms, url, description, hours, source_url, sort_order)
values
    ('urgence-911', 'emergency'::public.resource_category, 'Urgence 911', null, '911', null, null, 'Si quelqu''un est en danger, ou a besoin de soins urgents.', '24 h sur 24, 7 jours sur 7', null, 10),
    ('ligne-9-8-8', 'crisis_line'::public.resource_category, '9-8-8, prévention du suicide', null, '988', '988', null, 'Si vous pensez au suicide, ou si vous êtes inquiet ou inquiète pour quelqu''un. Par appel ou par texto.', '24 h sur 24, 7 jours sur 7', null, 20),
    ('info-social-811', 'psychosocial_line'::public.resource_category, 'Info-Social 811', null, '811', null, null, 'Pour parler à une intervenante ou un intervenant psychosocial. Choisissez l''option 2.', '24 h sur 24, 7 jours sur 7', null, 30),
    ('info-sante-811', 'health_line'::public.resource_category, 'Info-Santé 811', null, '811', null, null, 'Pour une question de santé, parler à une infirmière ou un infirmier. Choisissez l''option 1.', '24 h sur 24, 7 jours sur 7', null, 40)
on conflict (slug) do nothing;
