-- Session 40: the default row limit of SQL resources goes from 10,000 to 1,000,000 (the user's word). Configs still
-- on the old default are raised; a limit someone chose (anything else) stays.
UPDATE "resource_configs" AS c
SET "config" = jsonb_set(c."config", '{maxRows}', '1000000'::jsonb), "updated_at" = now()
FROM "resources" AS r
WHERE r."id" = c."resource_id"
  AND r."type" IN ('postgres', 'mysql', 'bigquery')
  AND c."config" ->> 'maxRows' = '10000';
