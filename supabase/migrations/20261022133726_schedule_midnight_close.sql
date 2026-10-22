-- Evaluate Berlin dates each minute: DST-safe midnight plus downtime catch-up.
-- Only the postgres job owner can invoke the private closure function.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'timestone-midnight-close',
  '* * * * *',
  'select timestone_private.close_open_attendance();'
);
