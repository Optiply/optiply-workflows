# Runbook: Pub/Sub triggers

A workflow can be started by Google Cloud Pub/Sub messages: each message published to a topic runs the workflow's live
release once, through a subscription the platform pulls. Workflows can also publish to topics. The design is
`docs/architecture.md` §2.22; this page is for setting one up and keeping it working.

## How it fits

```
publisher ──▶ topic ──▶ subscription ◀──pull── worker (one per trigger, by lease) ──▶ a run per message
                              ▲                                                         │
                              └──────── ack when the run succeeds, nack when it fails ◀─┘
```

- A **Pub/Sub resource** holds the connection: a GCP project and a Google identity, set per environment like every
  resource. A **trigger** on a workflow names the resource, a subscription and an environment.
- The trigger takes effect when the workflow is **published**, like webhooks and schedules. One worker at a time pulls
  for it (a lease on the trigger, renewed every 5 s; another worker takes over within about 35 s if it goes away).
- Each message starts a run. `startTrigger.data` is the message's data (parsed when it's JSON, otherwise text);
  `startTrigger.message` has `messageId`, `publishTime`, `attributes`, `orderingKey`, `deliveryAttempt` (with a
  dead-letter policy), `subscription` and `dataBase64`.
- The message is **held** while its run lasts (its ack deadline extended every 20 s), then **acked** when the run
  succeeds, or **nacked** when it fails or is cancelled: Pub/Sub delivers it again, with the subscription's retry
  policy, and after enough attempts to its dead-letter topic if it has one. A run that outlasts the trigger's
  "Hold up to" (60 minutes by default) has its message acked anyway; the run goes on.
- Pub/Sub delivers at least once. A message delivered again whose run already succeeded is acked without a run, and
  one whose run is still under way is held for that run, not run twice.

## Setting one up

1. **A topic and a subscription** (a pull subscription, the default):
   ```bash
   gcloud pubsub topics create orders --project PROJECT
   gcloud pubsub subscriptions create orders-workflow --topic orders --project PROJECT \
     --ack-deadline 60 --min-retry-delay 10s --max-retry-delay 600s
   ```
   A dead-letter topic is worth having, so a message that keeps failing stops being retried:
   ```bash
   gcloud pubsub topics create orders-dead --project PROJECT
   gcloud pubsub subscriptions update orders-workflow --project PROJECT \
     --dead-letter-topic orders-dead --max-delivery-attempts 5
   ```
   (Pub/Sub's own service account then needs the publisher role on the dead-letter topic and the subscriber role on
   the subscription: `gcloud` prints what to grant.) With ordering keys, create the subscription with
   `--enable-message-ordering`: a key's messages then run one at a time, in order.
2. **A Google identity** for the resource, either:
   - **a service account key** kept with the resource (encrypted, never shown again), for an account of its own:
     ```bash
     gcloud iam service-accounts create optiply-workflows-pubsub --project PROJECT
     gcloud pubsub subscriptions add-iam-policy-binding orders-workflow --project PROJECT \
       --member serviceAccount:optiply-workflows-pubsub@PROJECT.iam.gserviceaccount.com \
       --role roles/pubsub.subscriber
     gcloud pubsub topics add-iam-policy-binding orders --project PROJECT \
       --member serviceAccount:optiply-workflows-pubsub@PROJECT.iam.gserviceaccount.com \
       --role roles/pubsub.publisher   # only if workflows publish to it
     gcloud iam service-accounts keys create key.json \
       --iam-account optiply-workflows-pubsub@PROJECT.iam.gserviceaccount.com
     ```
   - or **this server's own identity**, as for IAP (`docs/runbooks/ssh-tunnels.md`): off unless
     `GOOGLE_SERVER_IDENTITY=allow`, chosen by admins only; with Docker Compose on a Mac, `docker-compose.gcloud.yml`
     and `gcloud auth application-default login` (the identity is then yours).
3. **The resource**: Resources → New resource → Google Cloud Pub/Sub. Per environment: the identity (and key), the
   project (a key's own by default; required with the server's identity). **Test connection** says which project and
   identity; one that may not list topics still passes (subscribing and publishing don't need it).
4. **The trigger**: in the workflow, the start block → Pub/Sub → Add: the resource, the subscription (its id, or
   `projects/…/subscriptions/…` in another project), the environment, "At once" (messages whose runs may be under way
   together, 4 by default) and "Hold up to" (minutes). **Publish** the workflow. The card shows "pulling" within a few
   seconds.
5. **Try it**:
   ```bash
   gcloud pubsub topics publish orders --project PROJECT --message '{"id": 1}' --attribute kind=created
   ```
   The card counts it ("last day: 1 message"), and Runs shows the run as "pubsub · message …".

Publishing from a workflow: a resource query on the Pub/Sub resource, with the topic and the messages as JSON with
`{{ }}` (`{"data": {{ order }}, "attributes": {"kind": "created"}}`, or an array of such, up to 1,000).

## When it fails

The trigger card shows the last error; the same goes to the worker's log (`component: pubsub`).

| It says | What to do |
|---|---|
| `Pub/Sub refused the identity … (it needs roles/pubsub.subscriber …)` | Grant the identity the subscriber role on the subscription (publisher on a topic it publishes to). |
| `Resource not found (resource=projects/…/subscriptions/…)` | The subscription's name or project: the trigger's subscription, the resource's project. |
| `This instance doesn't let resources use its own Google identity` | `GOOGLE_SERVER_IDENTITY=allow` (and credentials) on the server, or a key on the resource. |
| `The server has no Google identity: …` | The server's credentials: `gcloud auth application-default login` again (with Compose, the mounted file), or the VM's service account. |
| "waiting for a worker to pull it" | No worker running, or it can't reach the database: the worker's log. |
| Runs failing, messages redelivered | The workflow fails: its runs say why. Pub/Sub keeps redelivering until a run succeeds or the dead-letter topic takes the message. |

Pulls that fail are retried, waiting 1 s, then twice as long each time up to 30 s; a fixed key or role is picked up
on the next try. Messages aren't lost meanwhile: Pub/Sub keeps them (7 days by default).

## Watching it

- Metrics (`/metrics` of each worker): `ow_pubsub_messages_total{outcome}` (`acked`, `nacked`, `duplicate`,
  `released` past the hold), `ow_pubsub_in_flight`, `ow_pubsub_pull_errors_total`. Many nacks: runs failing; many
  `released`: runs longer than "Hold up to".
- Log lines (`component: pubsub`): `pubsub trigger leased` (info), `pubsub pull failed` (warn, with Pub/Sub's message),
  `pubsub message nacked: its run failed`, `pubsub message held past maxHoldMinutes: acked, its run goes on`.
- The delivery records (`pubsub_deliveries`) are kept 32 days (Pub/Sub keeps an unacked message 31 days at most), then
  pruned by retention.

## Not supported

Push subscriptions; SQS and Kafka (later, as more kinds of the same trigger); Pub/Sub's exactly-once delivery
subscriptions (our duplicate check covers acked messages); several messages per run; several workers sharing one
trigger's messages (one pulls at a time).
