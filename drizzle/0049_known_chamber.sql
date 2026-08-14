-- Pre-flight. Migrations run automatically at boot (instrumentation.ts →
-- runMigrations()), so a bare CREATE UNIQUE INDEX on a table that already holds
-- duplicates would leave an upgraded instance refusing to START, with a raw Postgres
-- constraint error and no indication of which rows to look at.
--
-- array_agg is not decoration: each duplicate may own its own set of
-- catalog:<install id> connectors, skills and bundled files, so the merge is manual and
-- the operator needs the ids to inspect them. Nothing is deleted automatically.
DO $$
DECLARE
  report text;
BEGIN
  SELECT string_agg(line, E'\n')
    INTO report
    FROM (
      SELECT format(
               '  plugin "%s" (marketplace %s, scope %s, owner %s) → install ids: %s',
               plugin_name, marketplace_id, scope, coalesce(user_id, 'none'),
               array_to_string(array_agg(id ORDER BY id), ', ')
             ) AS line
        FROM plugin_installs
       GROUP BY marketplace_id, plugin_name, scope, user_id
      HAVING count(*) > 1
    ) duplicates;

  IF report IS NOT NULL THEN
    RAISE EXCEPTION E'Capka cannot make plugin installs unique per (marketplace, plugin, scope, owner): duplicates already exist.\n%\n\nEach of these installs may own its own connectors, skills and bundled files (tagged catalog:<install id>), so they cannot be merged automatically and nothing has been deleted. Open Extensions, uninstall the duplicates you do not want to keep, then start Capka again.', report;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "capability_policies" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_plugin_installs_system" ON "plugin_installs" USING btree ("marketplace_id","plugin_name","scope") WHERE user_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_plugin_installs_user" ON "plugin_installs" USING btree ("marketplace_id","plugin_name","scope","user_id") WHERE user_id is not null;
