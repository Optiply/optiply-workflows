# Runbook: RabbitMQ triggers

A workflow can be started by RabbitMQ messages: each message on a queue runs the workflow's live release once, by a
worker consuming the queue. Workflows can also publish to exchanges. The design is `docs/architecture.md` §2.33 (it
shares the queue consumer of §2.22 and §2.29); this page is for setting one up and keeping it working.

## How it fits

```
publisher ──▶ exchange ──▶ queue ◀──consume (prefetch)── worker (one per trigger, by lease) ──▶ a run per message
                             │  ▲                                                                   │
                             │  └──────────── ack when the run succeeds ◀──────────────────────────┘
                             └──▶ dead-letter exchange ◀── reject (no requeue) when it fails
```

- A **RabbitMQ resource** holds the connection: host, port, virtual host, user and password, TLS, per environment like
  every resource. A **trigger** on a workflow names the resource, a queue and an environment.
- The trigger takes effect when the workflow is **published**. One worker at a time consumes for it (a lease on the
  trigger; another worker takes over within about 35 s if it goes away).
- Each message starts a run. `startTrigger.data` is the body (parsed when it's JSON, otherwise text; bytes that aren't
  text arrive as base64, with `startTrigger.message.encoding` set to `base64`). `startTrigger.message` has `queue`,
  `exchange` (empty: the default exchange), `routingKey`, `redelivered`, `headers`, and the publisher's `messageId`,
  `contentType`, `correlationId` and `timestamp` when set.
- The consumer's **prefetch** is the trigger's "At once" (4 by default, 100 at most): RabbitMQ hands out no more
  unacknowledged messages than that. A message is **acked** when its run succeeds, and **rejected without requeueing**
  when it fails or is cancelled, so the queue's **dead-letter exchange** takes it. Without one, RabbitMQ drops it.
- A message held past "Hold up to" (60 minutes by default, 24 hours at most) is acked anyway; the run goes on.
- A lost connection or channel hands the unacknowledged messages back to the broker, which delivers them again
  (`redelivered: true`). A redelivery is recognised by its **message id**: one whose run already succeeded is acked
  without a run, one whose run is under way is held for it. **Publishers should set `messageId`**; without one, each
  delivery is a new message.

## Setting one up

1. **A queue with a dead-letter queue**, so a message that fails isn't lost:
   ```bash
   rabbitmqadmin declare queue name=orders.dead durable=true
   rabbitmqadmin declare queue name=orders durable=true \
     arguments='{"x-dead-letter-exchange": "", "x-dead-letter-routing-key": "orders.dead"}'
   ```
   (or a policy: `rabbitmqctl set_policy orders-dlx '^orders$' '{"dead-letter-exchange": "", "dead-letter-routing-key": "orders.dead"}' --apply-to queues`).
   The queue must exist: the trigger doesn't declare it.
2. **A user** for the resource, with permissions on the virtual host: `read` on the queues it consumes, `write` on the
   exchanges it publishes to (`amq.default` for the default exchange), nothing to configure:
   ```bash
   rabbitmqctl add_user workflows 'a long password'
   rabbitmqctl set_permissions -p / workflows '^$' '^(amq\.default|orders-out)$' '^orders$'
   ```
3. **The resource**: Resources → New resource → RabbitMQ. Per environment: the host, the port (empty: 5672, or 5671 with
   TLS), the virtual host, the username and password, TLS with an optional CA (PEM). A broker on a private address
   (inside Optiply's network) needs "Allow a private network address". **Test connection** answers the broker's
   product and version ("RabbitMQ 4.1.4 at rabbitmq.internal").
4. **The trigger**: in the workflow, the start block → RabbitMQ → Add: the resource, the queue, the environment, "At
   once" and "Hold up to". **Publish** the workflow. The card shows "consuming" within a few seconds.
5. **Try it**:
   ```bash
   rabbitmqadmin publish exchange=amq.default routing_key=orders \
     payload='{"id": 7}' properties='{"message_id": "order-7"}'
   ```
   The card counts it ("last day: 1 message"), and Runs shows "rabbitmq · RabbitMQ message order-7 · orders".

Publishing from a workflow: a resource query on the RabbitMQ resource, action **Publish**: the exchange (empty: the
default exchange, where the routing key is the queue's name), the routing key, and the messages as JSON with `{{ }}`
(`{"body": {{ order }}, "messageId": "order-{{ order.id }}", "headers": {"kind": "created"}}`, or an array; also
`contentType`, `persistent` (true by default), `priority`, `expiration`). A body that isn't a string is sent as JSON.
The query waits for the broker's **publisher confirms**, and messages are published as **mandatory**: one that no
queue takes is an error, not a silent drop.

## When it fails

The trigger card shows the last error; the same goes to the worker's log (`component: queue`).

| It says | What to do |
|---|---|
| `RabbitMQ refused the sign-in or the vhost: …` | The username and password, or the user's access to the virtual host. |
| `Could not reach RabbitMQ to …: …` | The host and port, TLS on a plain port (or the other way round), a firewall. |
| `… a private network address …` | Tick "Allow a private network address" for a broker inside Optiply's network. |
| `RabbitMQ: NOT_FOUND - no queue 'orders' in vhost '/'` | Declare the queue (step 1), or fix its name or the virtual host. |
| `RabbitMQ: … ACCESS_REFUSED …` | The user's permissions (step 2). |
| `The broker cancelled the consumer of "orders"` | The queue was deleted: declare it again; the trigger picks it up on its next try. |
| `No queue is bound to … with routing key "…"` (a publish query) | A binding from the exchange, or the queue's name as the routing key on the default exchange. |
| Runs failing, messages in the dead-letter queue | The workflow fails: its runs say why. Move the messages back (the shovel plugin, or `rabbitmqadmin`) once it's fixed. |

Consumes that fail are retried, waiting 1 s, then twice as long each time up to 30 s. Messages wait in the queue meanwhile.

## Watching it

- Metrics (`/metrics` of each worker), with `kind="rabbitmq"`: `ow_queue_messages_total{kind,outcome}` (`acked`,
  `nacked` rejected to the dead-letter exchange, `duplicate`, `released` past the hold), `ow_queue_in_flight{kind}`,
  `ow_queue_pull_errors_total{kind}`. The queue's depth: RabbitMQ's management UI or `rabbitmqctl list_queues`.
- Log lines (`component: queue`): `rabbitmq trigger leased`, `rabbitmq pull failed`, `rabbitmq message nacked: its run
  failed`, `rabbitmq message held past maxHoldMinutes: acked, its run goes on`.
- The delivery records (`queue_deliveries`, keyed `id:<messageId>`) are kept 32 days, then pruned by retention.

## Not supported

RabbitMQ streams and quorum-queue specifics (a quorum queue's delivery limit works as RabbitMQ applies it); AMQP 1.0;
SSH tunnels to brokers; declaring queues or bindings from here; several messages per run; several workers sharing one
trigger's queue (one consumes at a time).
