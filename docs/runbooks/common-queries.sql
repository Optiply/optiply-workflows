-- Common queries on the Optiply Workflows database (production or the local stack).
-- All read-only: run them as ow_readonly through the IAP tunnel (docs/runbooks/deploy.md, "Looking at the data").
-- In a database app, run one query at a time; in psql, `\i common-queries.sql` runs them all.
-- Times are UTC. Change the values in quotes ('…') to look up something specific.


-- ============================================================================================================
-- 1. People and access
-- ============================================================================================================

-- 1.1 Everyone, newest first: status (active, pending, invited, rejected), disabled, last sign-in, how they sign in.
select u.name,
       u.email,
       u.status,
       u.disabled_at is not null                          as disabled,
       u.last_login_at,
       case when u.oidc_subject is not null then 'google'
            when u.password_hash is not null then 'password'
            else 'never signed in' end                    as sign_in,
       u.created_at
from users u
order by u.created_at desc;

-- 1.2 Waiting for approval (Settings → Users → Waiting for approval).
select name, email, requested_at
from users
where status = 'pending'
order by requested_at;

-- 1.3 Admins: members of the Admins group. Only @optiply.nl addresses get admin powers (session 54).
select u.name, u.email, u.status, u.email ilike '%@optiply.nl' as has_admin_powers
from group_members gm
join groups g on g.id = gm.group_id and g.system_kind = 'admins'
join users u on u.id = gm.user_id
order by u.email;

-- 1.4 Groups with their members.
select g.name                                              as group_name,
       count(gm.user_id)                                   as members,
       string_agg(u.email, ', ' order by u.email)          as emails
from groups g
left join group_members gm on gm.group_id = g.id
left join users u on u.id = gm.user_id
group by g.id, g.name
order by g.name;

-- 1.5 One person's groups (change the email).
select g.name as group_name, gm.created_at as member_since
from users u
join group_members gm on gm.user_id = u.id
join groups g on g.id = gm.group_id
where u.email = 'someone@optiply.nl'
order by g.name;

-- 1.6 Who has access to what: every grant, to a group or a person, with the object's name where it has one.
select coalesce(g.name, u.email)                           as granted_to,
       case when p.group_id is not null then 'group' else 'person' end as subject,
       p.object_type,
       coalesce(w.name, a.name, r.name, f.name, '(all of this kind)') as object,
       p.level,
       e.slug                                              as environment
from permissions p
left join groups g on g.id = p.group_id
left join users u on u.id = p.user_id
left join workflows w on p.object_type = 'workflow' and w.id = p.object_id
left join apps a on p.object_type = 'app' and a.id = p.object_id
left join resources r on p.object_type = 'resource' and r.id = p.object_id
left join folders f on f.id = p.object_id
left join environments e on e.id = p.environment_id
order by granted_to, p.object_type, object;

-- 1.7 Who is signed in now (open sessions), by person.
select u.email, count(*) as sessions, max(s.created_at) as latest_sign_in, max(s.expires_at) as expires
from sessions s
join users u on u.id = s.user_id
where s.expires_at > now()
group by u.email
order by latest_sign_in desc;

-- 1.8 Personal access tokens and API keys still usable (not revoked, not expired).
select 'access token' as kind, u.email as owner, t.name, t.prefix, t.last_used_at, t.expires_at
from personal_access_tokens t
join users u on u.id = t.user_id
where t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
union all
select 'API key', u.email, k.name, k.prefix, k.last_used_at, k.expires_at
from api_keys k
left join users u on u.id = k.created_by
where k.revoked_at is null and (k.expires_at is null or k.expires_at > now())
order by kind, owner;


-- ============================================================================================================
-- 2. Workflows and runs
-- ============================================================================================================

-- 2.1 Workflows: live version, last change, who changed it, runs in the last 30 days.
select w.name,
       w.slug,
       wr.version                                          as live_version,
       w.updated_at,
       u.email                                             as updated_by,
       (select count(*) from workflow_runs r
        where r.workflow_id = w.id and r.created_at > now() - interval '30 days') as runs_30d
from workflows w
left join workflow_releases wr on wr.id = w.live_release_id
left join users u on u.id = w.updated_by
order by w.updated_at desc;

-- 2.2 Triggers that start workflows: webhooks and schedules, on or off, next and last fire.
select w.name as workflow, t.kind, t.name, t.enabled, t.next_fire_at, t.last_fired_at, e.slug as environment
from workflow_triggers t
join workflows w on w.id = t.workflow_id
left join environments e on e.id = t.environment_id
order by w.name, t.kind, t.name;

-- 2.3 The latest 50 runs: workflow, status, how it started, how long it took.
select r.created_at,
       w.name                                              as workflow,
       r.status,
       r.trigger_type,
       e.slug                                              as environment,
       r.finished_at - r.started_at                        as duration,
       r.error ->> 'message'                               as error
from workflow_runs r
join workflows w on w.id = r.workflow_id
left join environments e on e.id = r.environment_id
order by r.created_at desc
limit 50;

-- 2.4 Failed runs in the last 7 days, with their error.
select r.created_at, w.name as workflow, r.trigger_type, r.error ->> 'message' as error, r.id as run_id
from workflow_runs r
join workflows w on w.id = r.workflow_id
where r.status = 'failed' and r.created_at > now() - interval '7 days'
order by r.created_at desc;

-- 2.5 Runs per workflow and day, last 14 days: total, failed, average duration.
select date_trunc('day', r.created_at)::date               as day,
       w.name                                              as workflow,
       count(*)                                            as runs,
       count(*) filter (where r.status = 'failed')         as failed,
       avg(r.finished_at - r.started_at)                   as avg_duration
from workflow_runs r
join workflows w on w.id = r.workflow_id
where r.created_at > now() - interval '14 days'
group by 1, 2
order by 1 desc, 2;

-- 2.6 Runs waiting or under way now (queued, running, waiting on a task or a timer).
select r.created_at, w.name as workflow, r.status, r.trigger_type, r.started_at, r.lease_owner
from workflow_runs r
join workflows w on w.id = r.workflow_id
where r.status not in ('succeeded', 'failed', 'cancelled')
order by r.created_at;

-- 2.7 One run's blocks and log (change the run id; copy it from 2.3 or 2.4).
select b.block_key, b.status, b.attempt, b.started_at, b.finished_at, b.error ->> 'message' as error
from block_runs b
where b.run_id = '00000000-0000-0000-0000-000000000000'
order by b.started_at nulls last;

select l.at, l.block_key, l.level, l.message
from run_logs l
where l.run_id = '00000000-0000-0000-0000-000000000000'
order by l.id;

-- 2.8 Inbox: open User Tasks and who they're assigned to.
select t.created_at, w.name as workflow, t.title, t.status, t.due_at,
       (select string_agg(u.email, ', ') from users u where u.id = any (t.assignee_user_ids)) as assigned_people,
       (select string_agg(g.name, ', ') from groups g where g.id = any (t.assignee_group_ids)) as assigned_groups
from user_tasks t
join workflows w on w.id = t.workflow_id
where t.status = 'open'
order by t.created_at;


-- ============================================================================================================
-- 3. Apps
-- ============================================================================================================

-- 3.1 Apps: published or draft only, live version, last change.
select a.name,
       a.slug,
       ar.version                                          as live_version,
       a.live_release_id is not null                       as published,
       a.draft_revision,
       a.updated_at,
       u.email                                             as updated_by
from apps a
left join app_releases ar on ar.id = a.live_release_id
left join users u on u.id = a.updated_by
order by a.name;

-- 3.2 Release history of apps and workflows, newest first.
select 'app' as kind, a.name, r.version, r.notes, u.email as published_by, r.created_at
from app_releases r join apps a on a.id = r.app_id left join users u on u.id = r.created_by
union all
select 'workflow', w.name, r.version, r.notes, u.email, r.created_at
from workflow_releases r join workflows w on w.id = r.workflow_id left join users u on u.id = r.created_by
order by created_at desc
limit 50;


-- ============================================================================================================
-- 4. Resources, environments and config vars (no secret values: those are encrypted and never shown)
-- ============================================================================================================

-- 4.1 Resources and which environments have settings for them.
select r.name,
       r.slug,
       r.type,
       r.system_kind,
       string_agg(e.slug, ', ' order by e.slug)            as configured_in,
       max(c.updated_at)                                   as settings_changed
from resources r
left join resource_configs c on c.resource_id = r.id
left join environments e on e.id = c.environment_id
group by r.id, r.name, r.slug, r.type, r.system_kind
order by r.type, r.name;

-- 4.2 Resources that reach a database through an SSH tunnel, and where to (host or IAP VM).
select r.slug, r.type, e.slug as environment,
       c.config -> 'ssh' -> 'hops' -> 0 -> 'iap' ->> 'instance' as iap_vm,
       c.config -> 'ssh' -> 'hops' -> 0 ->> 'host'               as ssh_host
from resources r
join resource_configs c on c.resource_id = r.id
join environments e on e.id = c.environment_id
where c.config ? 'ssh'
order by r.slug;

-- 4.3 Environments.
select slug, name, is_default, created_at from environments order by is_default desc, slug;

-- 4.4 Config vars: which environments set them (secret ones show only whether they're set).
select v.name,
       v.is_secret,
       e.slug                                              as environment,
       case when v.is_secret then (cv.value_encrypted is not null)::text else cv.value end as value_or_set
from config_vars v
left join config_var_values cv on cv.config_var_id = v.id
left join environments e on e.id = cv.environment_id
order by v.name, e.slug;


-- ============================================================================================================
-- 5. Activity (audit log)
-- ============================================================================================================

-- 5.1 The latest 100 actions: who did what, on what.
select a.at, u.email as who, a.action, a.object_type, a.metadata ->> 'name' as name, a.ip
from audit_events a
left join users u on u.id = a.actor_user_id
order by a.at desc
limit 100;

-- 5.2 Sign-ins and sign-in requests, last 30 days.
select a.at, coalesce(u.email, a.metadata ->> 'email') as who, a.action, a.ip
from audit_events a
left join users u on u.id = a.actor_user_id
where (a.action like 'auth.%' or a.action like 'user.%')
  and a.at > now() - interval '30 days'
order by a.at desc;

-- 5.3 Everything one person did (change the email).
select a.at, a.action, a.object_type, a.metadata
from audit_events a
join users u on u.id = a.actor_user_id
where u.email = 'someone@optiply.nl'
order by a.at desc
limit 200;

-- 5.4 Actions per person and type, last 30 days.
select u.email as who, a.action, count(*) as times
from audit_events a
left join users u on u.id = a.actor_user_id
where a.at > now() - interval '30 days'
group by 1, 2
order by 1, 3 desc;


-- ============================================================================================================
-- 6. Size and health of the database
-- ============================================================================================================

-- 6.1 The biggest tables (run history and logs usually lead; RUN_RETENTION_DAYS prunes them, 30 days).
select n.nspname                                           as schema,
       c.relname                                           as table_name,
       c.reltuples::bigint                                 as approx_rows,
       pg_size_pretty(pg_total_relation_size(c.oid))       as size
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname in ('public', 'owdb_production', 'owdb_staging')
order by pg_total_relation_size(c.oid) desc
limit 20;

-- 6.2 The whole database's size.
select pg_size_pretty(pg_database_size(current_database())) as database_size;

-- 6.3 Your apps' Database tables (the app's Database section), with rough row counts.
select n.nspname as schema, c.relname as table_name, c.reltuples::bigint as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname like 'owdb_%'
order by 1, 2;

-- 6.4 Migrations applied (the last one shows the schema version).
select id, to_timestamp(created_at / 1000) as applied_at, left(hash, 12) as hash from drizzle.__drizzle_migrations order by id desc limit 5;
