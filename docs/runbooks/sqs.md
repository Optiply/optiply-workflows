# Runbook: SQS triggers

A workflow can be started by Amazon SQS messages: each message on a queue runs the workflow's live release once, by a
worker receiving from the queue. Workflows can also send to queues. The design is `docs/architecture.md` §2.29 (it
shares Pub/Sub's consumer, §2.22); this page is for setting one up and keeping it working.

## How it fits

```
sender ──▶ queue ◀──receive (long poll)── worker (one per trigger, by lease) ──▶ a run per message
             ▲                                                                      │
             └──── delete when the run succeeds, visible again when it fails ◀──────┘
```

- An **SQS resource** holds the connection: a region and an AWS identity, per environment like every resource. A
  **trigger** on a workflow names the resource, a queue (its name or URL) and an environment.
- The trigger takes effect when the workflow is **published**. One worker at a time receives for it (a lease on the
  trigger, renewed every 5 s; another worker takes over within about 35 s if it goes away).
- Each message starts a run. `startTrigger.data` is the body (parsed when it's JSON, otherwise text);
  `startTrigger.message` has `messageId`, `queue` (the URL), `attributes` (SQS's own: `SentTimestamp`,
  `ApproximateReceiveCount`, …), `messageAttributes` (the sender's, as text), `receiveCount`, `sentAt`, and on FIFO
  queues `groupId`, `deduplicationId` and `sequenceNumber`.
- The message is **held** while its run lasts (its visibility set to 60 s, renewed every 20 s), then **deleted** when
  the run succeeds, or made **visible again at once** when it fails or is cancelled: the queue hands it out again, and
  after its redrive policy's `maxReceiveCount` moves it to the dead-letter queue. A run that outlasts the trigger's
  "Hold up to" (60 minutes by default, 12 hours at most, SQS's own limit) has its message deleted anyway; the run goes
  on.
- **FIFO queues** (`name.fifo`) are received one message at a time, so SQS hands out a group's next message only after
  this one is deleted: a group's messages run one at a time, in order; other groups run alongside.
- SQS delivers at least once. A message received again whose run already succeeded is deleted without a run, and one
  whose run is still under way is held for that run, not run twice.

## Setting one up

1. **A queue**, with a dead-letter queue so a message that keeps failing stops being retried:
   ```bash
   aws sqs create-queue --queue-name orders-dlq
   aws sqs create-queue --queue-name orders --attributes '{
     "VisibilityTimeout": "60",
     "RedrivePolicy": "{\"deadLetterTargetArn\":\"arn:aws:sqs:REGION:ACCOUNT:orders-dlq\",\"maxReceiveCount\":\"5\"}"
   }'
   ```
2. **An AWS identity** for the resource, one of:
   - **an access key** of an IAM user (the secret kept encrypted, never shown again), with this policy (drop
     `SendMessage` if workflows only receive, and the receive actions if they only send):
     ```json
     { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": [
         "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility",
         "sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:SendMessage"],
       "Resource": "arn:aws:sqs:REGION:ACCOUNT:orders" }] }
     ```
   - **a role to assume** with that key (or with the server's credentials): its ARN and, if its trust policy asks for
     one, the external id. Credentials are short-lived and renewed before they expire; the role may be in another
     account.
   - or **this server's own credentials**: the SDK's default chain (environment variables, `~/.aws`, SSO, web identity,
     ECS and EC2 instance roles). Off unless `AWS_SERVER_IDENTITY=allow`; only admins choose it for a resource, or change
     the region or role used with it. With Docker Compose on a Mac, `docker-compose.aws.yml` mounts `~/.aws`
     read-only and opts in (the identity is then yours: `AWS_PROFILE` picks a profile).
3. **The resource**: Resources → New resource → Amazon SQS. Per environment: the region, the identity, an optional role.
   **Test connection** names the identity (STS) and lists a queue; one that may not list queues still passes.
   Admins can point a resource at another endpoint (LocalStack, ElasticMQ); STS is asked there too.
4. **The trigger**: in the workflow, the start block → SQS → Add: the resource, the queue (its name in the resource's
   region and account, or its URL), the environment, "At once" (4 by default) and "Hold up to". **Publish** the
   workflow. The card shows "receiving" within a few seconds.
5. **Try it**:
   ```bash
   aws sqs send-message --queue-url "$(aws sqs get-queue-url --queue-name orders --query QueueUrl --output text)" \
     --message-body '{"id": 1}' --message-attributes 'kind={DataType=String,StringValue=created}'
   ```
   The card counts it ("last day: 1 message"), and Runs shows "sqs · SQS message … · orders".

Sending from a workflow: a resource query on the SQS resource, with the queue and the messages as JSON with `{{ }}`
(`{"body": {{ order }}, "attributes": {"kind": "created"}}`, or an array of such, up to 1,000, sent ten at a time; on a
FIFO queue each needs a `groupId`, and a `deduplicationId` unless the queue deduplicates by content).

## When it fails

The trigger card shows the last error; the same goes to the worker's log (`component: queue`).

| It says | What to do |
|---|---|
| `AWS refused to receive messages: … (AccessDenied)` | The identity's policy: the actions above on the queue. |
| `No queue "orders" in eu-west-1 for this identity` | The queue's name, the resource's region, or the account (a queue in another account needs its URL, or a role there). |
| `AWS refused to sign in: … (SignatureDoesNotMatch)` / `(InvalidClientTokenId)` | The access key's secret, or the key itself (deleted, inactive). |
| `This instance doesn't let resources use its own AWS credentials` | `AWS_SERVER_IDENTITY=allow` (and credentials) on the server, or an access key on the resource. |
| `… (AccessDenied)` when assuming the role | The role's trust policy: the caller's ARN, and the external id if it asks for one. |
| "waiting for a worker to receive it" | No worker running, or it can't reach the database: the worker's log. |
| Runs failing, messages coming back | The workflow fails: its runs say why. SQS hands the message out again until a run succeeds or the redrive policy moves it to the dead-letter queue. |

Receives that fail are retried, waiting 1 s, then twice as long each time up to 30 s; a fixed key or policy is picked
up on the next try. Messages aren't lost meanwhile: SQS keeps them (4 days by default, 14 at most).

## Watching it

- Metrics (`/metrics` of each worker), with `kind="sqs"`: `ow_queue_messages_total{kind,outcome}` (`acked` deleted,
  `nacked` handed back, `duplicate`, `released` past the hold), `ow_queue_in_flight{kind}`,
  `ow_queue_pull_errors_total{kind}`.
- Log lines (`component: queue`): `sqs trigger leased`, `sqs pull failed` (with AWS's message), `sqs message nacked:
  its run failed`, `sqs message held past maxHoldMinutes: acked, its run goes on`.
- The delivery records (`queue_deliveries`, shared with Pub/Sub and Kafka) are kept 32 days, then pruned by retention.

## Not supported

SNS beyond what an SQS subscription delivers (SNS-wrapped bodies arrive as they are); several messages per run;
several workers sharing one trigger's messages (one receives at a time); SQS's Lambda-style push.
