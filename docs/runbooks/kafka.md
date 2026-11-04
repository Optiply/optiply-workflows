# Runbook: Kafka triggers

A workflow can be started by Apache Kafka messages: each message on its topics runs the workflow's live release, read
by a worker as one member of a consumer group. Workflows can also produce to topics. The design is
`docs/architecture.md` §2.29; this page is for setting one up and keeping it working.

## How it fits

```
producer ──▶ topic (partitions) ◀──consume── worker: a member of the trigger's group ──▶ a run per message
                    ▲                                                                      │
                    └── offsets committed up to the lowest unsettled message ◀─────────────┘
```

- A **Kafka resource** holds the connection: bootstrap brokers and a way of signing in, per environment like every
  resource. A **trigger** on a workflow names the resource, its topics and an environment.
- The trigger takes effect when the workflow is **published**. One worker at a time consumes for it (a lease on the
  trigger), as one member of the consumer group: the trigger's `groupId`, by default `ow-<workflow id>-<trigger name>`
  (a renamed workflow keeps its offsets). Consumers outside the platform may share a group; they split its partitions.
  A new group starts at the topics' newest messages, or their beginning ("A new group starts at").
- Each message starts a run. `startTrigger.data` is the value (parsed when it's JSON, otherwise text; null for a
  tombstone); `startTrigger.message` has `topic`, `partition`, `offset`, `key`, `headers`, `timestamp`, `attempt` (1
  for the first run) and `groupId`.
- **Order:** within a partition, messages with the same key run one at a time, in offset order; messages with other
  keys, or without a key, run alongside, up to "At once" (4 by default).
- **Failures** are ours to handle (Kafka has no redelivery): a run that fails or is cancelled is retried as a new run
  after "Retry after" seconds (10 by default, doubling, at most 15 minutes), up to "Attempts" runs (3 by default). Then
  the message is produced to the **dead-letter topic** if the trigger names one, with its key, value and headers plus
  `ow-error`, `ow-workflow`, `ow-run-id`, `ow-source-topic`, `ow-source-partition`, `ow-source-offset` and
  `ow-attempts`, or **dropped** without one (logged and counted). Its key's next message then runs.
- **Offsets** are committed up to the lowest message not yet settled, every 5 s and when partitions move or the worker
  stops. After a takeover, messages past the committed offset come again: one whose run succeeded is skipped, one whose
  run is under way is waited for.
- The worker keeps polling while runs last (Kafka drops a member that stops), and stops fetching while many messages
  wait (25 per "At once").

## Setting one up

1. **Topics** (and a dead-letter topic):
   ```bash
   kafka-topics.sh --bootstrap-server BROKER --create --topic orders --partitions 6
   kafka-topics.sh --bootstrap-server BROKER --create --topic orders.dlt --partitions 1
   ```
   Partitions are the unit of parallel work between keys; a key always goes to the same partition.
2. **Access** for the resource's principal, where the cluster has ACLs: `READ` and `DESCRIBE` on the topics, `READ` on
   the consumer group (`ow-…` by default, or the group the trigger names), `WRITE` on the dead-letter topic, and `WRITE`
   on topics workflows produce to.
3. **The resource**: Resources → New resource → Apache Kafka. Per environment: the brokers (host:port, one per line) and
   the sign-in:
   - **No sign-in**, plaintext or TLS (local and private clusters);
   - **SASL PLAIN** or **SCRAM-SHA-256/512**, with a username and password, over TLS when ticked (Confluent Cloud API
     keys are PLAIN over TLS; Aiven and Redpanda often SCRAM);
   - **a client certificate** (mTLS): the certificate (PEM) and its private key (kept encrypted);
   - **AWS MSK IAM**: the cluster's region and an AWS identity (an access key, an assumed role, or the server's own
     credentials, as for SQS: `docs/runbooks/sqs.md`), with `kafka-cluster:Connect` and the topic and group actions in
     its policy. Tokens are presigned and renewed before they expire.

   A CA certificate (PEM) can be added for clusters with their own. **Test connection** names who it signs in as and
   counts the topics; a wrong password or untrusted certificate is reported with what the client logged (SASL or SSL).
4. **The trigger**: in the workflow, the start block → Kafka → Add: the resource, the topics (comma-separated), the
   environment, the group (empty for its own), where a new group starts, attempts, retry delay and the dead-letter
   topic. **Publish** the workflow. The card shows "consuming" within a few seconds.
5. **Try it**:
   ```bash
   echo 'order-7:{"id": 7}' | kafka-console-producer.sh --bootstrap-server BROKER --topic orders \
     --property parse.key=true --property key.separator=:
   ```
   The card counts it, and Runs shows "kafka · Kafka orders/0@… · key order-7".

Producing from a workflow: a resource query on the Kafka resource, with the topic and the messages as JSON with `{{ }}`
(`{"key": "order-{{ id }}", "value": {{ order }}, "headers": {"kind": "created"}}`, or an array, up to 1,000; `null` as
a value is a tombstone). It answers each partition's first offset.

## The Schema Registry (Avro and JSON Schema)

A Kafka resource can name a **Schema Registry** speaking Confluent's API (Confluent Cloud, Confluent Platform,
Redpanda, Karapace). Then:

- **Triggers decode** values in the registry's **wire format** (a zero byte, the schema's 4-byte id, the payload):
  Avro by the schema (`startTrigger.data` is plain JSON: `bytes` fields as base64, unions as their value), JSON Schema
  as the JSON after the header. `startTrigger.message.schemaId` names the schema, and Runs shows "· schema 12".
  Schemas are fetched by id once and kept. A value that can't be decoded (its schema deleted, the registry down, a
  Protobuf schema) still runs: its bytes as base64 (`message.encoding: 'base64'`) and `message.schemaError` saying why.
  Values not in the wire format arrive as before (JSON or text).
- **Produce queries encode** a message that names a **`subject`**, by that subject's latest schema (looked up again
  after a minute): `{"key": "order-7", "subject": "orders-value", "value": {"id": 7, "sku": "A-7"}}`. An Avro value is
  checked against the schema first, and a mismatch names the field (`The value doesn't match subject orders-value's
  schema at id`). Messages without a subject are sent as before; one produce can mix subjects. The subject must
  exist: register schemas with your usual tools (this doesn't register them).

Setting it up: the resource's settings → Schema Registry: the URL, and for a registry with sign-in its username and
password (Confluent Cloud: a Schema Registry API key and secret; the password is kept encrypted). A registry on a
private address needs "Allow a private network address". Saving refuses a username without its password.

| It says | What to do |
|---|---|
| `schemaError: Schema registry: Schema not found` | The value's schema was deleted (or another registry wrote it): the run has its bytes as base64. |
| `Schema registry: Unauthorized` / `HTTP 401` | The registry's username and password (Confluent Cloud: a Schema Registry key, not a cluster key). |
| `Subject 'orders-value' not found.` (produce) | Register the subject's schema, or fix its name (`<topic>-value` by Confluent's default naming). |
| `Subject … is PROTOBUF, which isn't encoded here` | Protobuf isn't supported: produce JSON, or use an Avro or JSON Schema subject. |

## When it fails

The trigger card shows the last error; the same goes to the worker's log (`component: queue`).

| It says | What to do |
|---|---|
| `Couldn't connect to Kafka: SASL authentication error: …` | The username and password, or the mechanism (PLAIN or SCRAM, and which SCRAM). |
| `… SSL handshake failed …` / `certificate verify failed` | TLS on a plaintext listener (or the other way round), or a cluster CA to add. |
| `Couldn't connect to Kafka: no broker answered` | The brokers' addresses and ports, a firewall, or TLS on the wrong listener. |
| `Couldn't join the consumer group: …` | The group's ACL (`READ` on the group), or the cluster unreachable. |
| `Add the cluster's AWS region` / `AWS refused to sign in: …` | MSK IAM's region and identity (`docs/runbooks/sqs.md` for the identity's errors). |
| "waiting for a worker to receive it" | No worker running, or it can't reach the database: the worker's log. |
| `kafka message dropped after its last attempt (no dead-letter topic)` | The workflow failed every attempt: its runs say why; name a dead-letter topic to keep such messages. |
| `dead letter failed again` | The dead-letter topic is missing or not writable; the message's partition waits until it is. |

## Watching it

- Metrics (`/metrics` of each worker), with `kind="kafka"`: `ow_queue_messages_total{kind,outcome}` (`acked`,
  `retried`, `dead_lettered`, `dropped`, `duplicate`, `released` past the hold), `ow_queue_in_flight{kind}`,
  `ow_queue_pull_errors_total{kind}`. The group's lag: Kafka's own tools (`kafka-consumer-groups.sh --describe`).
- Log lines (`component: queue`): `kafka trigger leased`, `kafka partitions assigned` / `revoked`, `kafka pull failed`,
  `kafka message to be retried: its run failed`, `kafka message dead-lettered after its last attempt`, `kafka offset
  commit failed`.
- The delivery records (`queue_deliveries`, keyed `<topic>/<partition>/<offset>@<timestamp>`, so a topic made again,
  whose offsets restart, isn't mistaken for the old one) are kept 32 days, then pruned.

## Not supported

Exactly-once transactions; Protobuf in the Schema Registry (such values arrive as base64 with a `schemaError`); registering schemas; SSH tunnels to Kafka (brokers
advertise their own addresses); several messages per run; several workers of this platform sharing one trigger's
partitions (one consumes at a time; outside consumers in the same group do share them).
