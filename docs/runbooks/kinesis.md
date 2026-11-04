# Runbook: Kinesis triggers

A workflow can be started by Amazon Kinesis Data Streams records: each record runs the workflow's live release once,
by a worker reading the stream's shards. Workflows can also put records. The design is `docs/architecture.md` §2.33
(it shares the queue consumer of §2.22 and §2.29); this page is for setting one up and keeping it working.

## How it fits

```
producer ──▶ stream ── shard 0 ─┐
                    └─ shard 1 ─┼──GetRecords── worker (one per trigger, by lease) ──▶ a run per record, one per shard at a time
                                │                                                       │
                                └── checkpoint (Postgres) advanced when the run succeeds ◀┘
```

- A **Kinesis resource** holds a region and an AWS identity (the same choices as SQS: `docs/runbooks/sqs.md`), per
  environment. A **trigger** on a workflow names the resource, a stream (its name or ARN), an environment and where a
  new shard starts: **new records only** (latest, the default) or **the oldest kept** (trim horizon). With "new records
  only", the shards open when the trigger first reads them start at their newest record, and shards already closed
  then (split or merged away before) are skipped; a shard split or merged from one the trigger read starts at its
  beginning, so nothing between is missed.
- The trigger takes effect when the workflow is **published**. One worker at a time reads for it (a lease on the
  trigger; another worker takes over within about 35 s if it goes away).
- **One record per shard at a time**: a shard's records run in order, shards alongside each other (up to "At once", 4
  by default). Records with the same partition key go to the same shard, so they run in order.
- Each record starts a run. `startTrigger.data` is its data (parsed when it's JSON, otherwise text; bytes that aren't
  text arrive as base64, with `startTrigger.message.encoding` set to `base64`). `startTrigger.message` has `stream`,
  `shardId`, `sequenceNumber`, `partitionKey`, `arrivedAt` and `attempt`.
- Where each shard has got to is a **checkpoint** in Postgres (`kinesis_checkpoints`), advanced when a record's run
  succeeds. A restart, or another worker taking over, carries on after the checkpoint.
- A failed run is **retried** after "Retry after" (10 s by default), doubling each time up to 15 minutes, until
  "Attempts" (3 by default) have run; then the record is **skipped** (recorded as `dropped`) and the shard moves on.
  The shard's later records wait meanwhile.
- **Resharding**: when a shard is split or merged, its children start only once the parent (both parents, for a merge)
  has been read to its end, so a partition key's records stay in order. An iterator that expired (after 5 minutes idle) is made again from the
  checkpoint.
- A release that changes the trigger's **stream, resource or environment** clears its checkpoints: it starts afresh
  on the new stream, at its starting point.
- Kinesis keeps records 24 hours by default (up to a year): a trigger stopped for longer misses the ones that expired.

## Setting one up

1. **A stream**:
   ```bash
   aws kinesis create-stream --stream-name clicks --shard-count 2
   ```
2. **An AWS identity** for the resource (an access key, a role to assume, or the server's own credentials: see
   `docs/runbooks/sqs.md`), with this policy (drop `PutRecords` if workflows only read, and the rest if they only put):
   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": [
       "kinesis:ListShards", "kinesis:GetShardIterator", "kinesis:GetRecords", "kinesis:PutRecords"],
     "Resource": "arn:aws:kinesis:REGION:ACCOUNT:stream/clicks" }] }
   ```
   A stream encrypted with a customer-managed KMS key also needs `kms:Decrypt` (and `kms:GenerateDataKey` to put).
3. **The resource**: Resources → New resource → Amazon Kinesis. Per environment: the region and the identity. **Test
   connection** names the identity ("Kinesis in eu-west-1 as arn:aws:iam::…").
4. **The trigger**: in the workflow, the start block → Kinesis → Add: the resource, the stream, the environment, where a
   new shard starts, attempts and the retry delay. **Publish** the workflow. The card shows "reading" within a few
   seconds.
5. **Try it**:
   ```bash
   aws kinesis put-record --stream-name clicks --partition-key user-1 \
     --data '{"page": "/orders"}' --cli-binary-format raw-in-base64-out
   ```
   Runs shows "kinesis · Kinesis clicks/shardId-000000000000@…".

Putting records from a workflow: a resource query on the Kinesis resource, action **Put records**: the stream and the
records as JSON with `{{ }}` (`{"data": {{ click }}, "partitionKey": "user-{{ click.user }}"}`, or an array, sent 500 at
a time; a random partition key without one; `explicitHashKey` to pick a shard). Data that isn't a string is sent as
JSON. It answers each record's shard and sequence number; records Kinesis refused are listed under `failed` in the
query's metadata (all refused: an error).

## When it fails

The trigger card shows the last error; the same goes to the worker's log (`component: queue`).

| It says | What to do |
|---|---|
| `AWS refused … (AccessDeniedException)` | The identity's policy: the actions above on the stream (and KMS for an encrypted one). |
| `… (ResourceNotFoundException)` | The stream's name, the resource's region, or the account (a stream in another account needs a role there). |
| `AWS refused to sign in: …` | The access key or role: `docs/runbooks/sqs.md`. |
| `… (ProvisionedThroughputExceededException)` | The shard's read limit (5 reads a second, shared with other consumers): fewer consumers, or more shards. Reads back off and go on. |
| "waiting for a worker to receive it" | No worker running, or it can't reach the database: the worker's log. |
| `kinesis message dropped after its last attempt (no dead-letter topic)` | The workflow failed every attempt: its runs say why. The record is skipped; put it again once fixed. |

## Watching it

- Metrics (`/metrics` of each worker), with `kind="kinesis"`: `ow_queue_messages_total{kind,outcome}` (`acked`,
  `retried`, `dropped`, `duplicate`), `ow_queue_in_flight{kind}`, `ow_queue_pull_errors_total{kind}`. How far behind:
  CloudWatch's `GetRecords.IteratorAgeMilliseconds`.
- Log lines (`component: queue`): `kinesis trigger leased`, `kinesis pull failed`, `kinesis message to be retried: its
  run failed`, `kinesis message dropped after its last attempt (no dead-letter topic)`.
- Checkpoints: `select * from kinesis_checkpoints where trigger_id = …` (a row per shard, its last sequence number).
  Deleting a shard's row makes it start again at the trigger's starting point.
- The delivery records (`queue_deliveries`, keyed by sequence number) are kept 32 days, then pruned by retention.

## Not supported

Enhanced fan-out (SubscribeToShard) and KCL's leases (this keeps its own checkpoints, not KCL's DynamoDB table); a
dead-letter target for skipped records; several records per run; several workers sharing one trigger's shards (one
reads at a time).
