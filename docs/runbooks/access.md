# Runbook: access, approval and invitations

Session 44 reworked who gets in and what they see. This page is for admins: letting people in, giving access, and
finding out why someone can't see or open something.

## Who gets in

- **Everyone new waits for an admin.** The first sign-in of anyone (@optiply.nl included; through Optiply's Auth0 in production since 2026-11-18) makes an account
  that **waits for approval**: no session, the sign-in page says "Waiting for an admin's approval". Signing in again
  while waiting doesn't ask again.
- **Admins see who waits** in Settings → Users ("Waiting for approval (n)"), with a count on Settings in the sidebar
  and on the Users tab. **Approve…** asks which groups they go into (All Users always); **Reject** keeps them out
  (they can't sign in or ask again; Approve still works later).
- **People outside Optiply come in only by invitation.** Settings → Users → **Invite people**: an email from any
  domain, a name (optional), groups. They sign in with an account of that address and are in at once, in those
  groups ("Invited" until then; **Cancel invitation** withdraws it). Anyone else outside @optiply.nl is refused: "Only
  @optiply.nl accounts or invited people can sign in".
- **No email is sent yet** (the user's choice, 2026-11-11): admins see requests in the app; tell invited people
  yourself. Email plugs in at `notifyAdminsOfRequest` (`apps/server/src/services/users.ts`).
- **Accounts from before** this are active; nothing changes for them. The `create-admin` CLI (break-glass) makes an
  active admin, also over a waiting or rejected account.
- **States** (`users.status`): `active`, `pending` (waiting), `invited`, `rejected`. Only `active` people get
  sessions and access tokens (checked on every request). **Disable** (the Users list) is separate: it stops an active
  person and ends their sessions.
- The audit log has `user.requested`, `user.approved`, `user.rejected`, `user.invited`, `user.invite_cancelled`
  (with the groups), beside `auth.login`.

## What they can do

- **Levels**: **Use** (run a workflow live and see its runs; open and use an app; place a module or library query),
  **Edit** (also change the draft, run it, publish), **Own** (also delete and manage access). The highest grant wins.
- **Who gets them**: a **group** or **one person**. A person's level is the highest of their own grants and their
  groups'.
- **On what**: one workflow, app, resource, library query, module or component library (its **Access** button: owners
  and admins); a **folder** (everything in it, at any depth; admins); or **all** of a kind (admins).
- **All of a kind** is set on a group's or a person's page (Settings → Groups → a group, or Settings → Users → a
  person), section **Access**: per kind, *Only what's shared*, *Use all*, *Edit all, and create* (Edit on all of a
  kind is what lets someone create them), *Own all*. Below it, "Shared with …" lists every single grant with a link.
- **Resources** keep per-environment grants (their own Access); a person's page shows those as badges.
- **Admins** (the Admins group) can do everything; grants don't apply to them.

## What they see

- The **sidebar and ⌘K show only the sections someone can reach**: a section shows when any grant reaches something
  in it (one object, all of the kind, or a folder of that kind). Runs goes with Workflows; Inbox with Workflows or a
  task assigned to them; Database with Use on the built-in database; Resources doesn't count the built-in REST API
  everyone may call. Someone with Use on one app sees only **Apps**. With nothing yet: a "Welcome… nothing has been
  shared with you yet" page.
- A hidden section's own URL says "No access to …"; a link to one workflow or app still goes through its own check.
- **New …** buttons show only for those who may create (Edit on all of that kind).
- Changes reach someone on their next page (within about 30 s) or a reload.
- **An app shared for Use** opens by its URL and runs, with no way into the editor (its `/edit` link sends them to the
  app). Before it's published: "You can use this app once its owner publishes it." Without access: "You don't have
  access to this app" (the same for an app that doesn't exist).

## Why can't someone…

- **…sign in?** Their state in Settings → Users: waiting (approve them), not approved (approve them), invited (they must
  use an account of exactly that address), disabled (enable them). Outside @optiply.nl without an invitation:
  invite them.
- **…see a section?** Nothing of that kind reaches them. Look at their page's Access and their groups' pages.
- **…open an app they were given?** It isn't published yet, or the grant went to another group. The app's Access lists
  who has it.
- **…give someone access?** Only people who are in (active, not disabled) can get access; only owners and admins can
  give it (and see who to give it to).

## Where it lives

- Grants: `permissions` (`group_id` or `user_id`, exactly one: migration 0044); computed in
  `apps/server/src/services/permissions.ts` (`loadAccess`, `Access`); managed by `routers/permissions.ts`.
- Sections: `services/capabilities.ts` → `me.sections` / `me.canCreate`.
- Sign-in: `services/users.ts` (`provisionUser`, `signInDecision`, inside one locked transaction),
  `auth/routes.ts` (the Google callback), `auth/sessions.ts`; states: migration 0045.
- Admin actions: `routers/users.ts` (`approve`, `reject`, `invite`, `cancelInvite`, `pendingCount`, `directory`).
- Tests: `apps/server/test/access.test.ts`, `approval.test.ts`; `apps/web/e2e/access.spec.ts`.
