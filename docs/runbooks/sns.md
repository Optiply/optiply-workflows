# Runbook: SNS

Amazon SNS works both ways here. Workflows **publish** to SNS topics through an SNS resource, and a workflow's
**webhook** can be an SNS subscription, so each notification runs the workflow. The design is `docs/architecture.md`
§2.33; this page is for setting both up.

## How it fits

```
workflow ──publish──▶ topic ──HTTPS POST (signed)──▶ /api/v1/workflows/<slug>/webhook ──▶ a run per notification
                        │                                   │
                        └──── SubscriptionConfirmation ────▶ confirmed by fetching its SubscribeURL (no run)
```

- Publishing needs an **SNS resource**: a region and an AWS identity (the same choices as SQS: `docs/runbooks/sqs.md`).
- Receiving needs no resource: the workflow's **webhook trigger** with the signature preset **SNS** and the topics it
  takes. SNS signs each message with a certificate of its own; the webhook checks it:
  - the certificate's URL must be `https://sns.<region>.amazonaws.com/….pem` (checked before it's fetched; fetched
    certificates are kept a day);
  - the signature (SignatureVersion 1, SHA1, or 2, SHA256) over SNS's canonical string;
  - the topic must be one of the trigger's topic ARNs.
  Anything else is answered 401 without a run.
- A **SubscriptionConfirmation** is confirmed at once (its `SubscribeURL` fetched, the same host rule) and answered 200
  without a run. An **UnsubscribeConfirmation** is answered without a run.
- A **Notification** starts a run. `startTrigger.data` is `{message, subject, attributes, messageId, topicArn,
  timestamp}`; `message` is parsed when it's JSON. The message id is the run's **idempotency key**: SNS retrying a
  delivery doesn't run the workflow twice.

## Receiving: a topic's notifications run a workflow

1. **The webhook**: in the workflow, the start block → Webhook: on, auth **Signature**, preset **SNS**, and the topic
   ARNs it takes (one per line; no secret). **Publish** the workflow. Its URL is
   `https://<this instance>/api/v1/workflows/<slug>/webhook` (or its alias).
2. **The subscription**, in AWS (raw message delivery **off**: the webhook needs SNS's signed envelope):
   ```bash
   aws sns subscribe --topic-arn arn:aws:sns:eu-west-1:ACCOUNT:orders --protocol https \
     --notification-endpoint https://workflows.optiply.com/api/v1/workflows/on-orders/webhook
   ```
   SNS sends the confirmation, and the webhook confirms it: `aws sns list-subscriptions-by-topic` shows the
   subscription's ARN instead of "PendingConfirmation" within seconds. The instance must be reachable from the
   internet for this (SNS can't reach a private address).
3. **Try it**:
   ```bash
   aws sns publish --topic-arn arn:aws:sns:eu-west-1:ACCOUNT:orders --subject 'New order' --message '{"id": 7}'
   ```
   Runs shows a webhook run with `startTrigger.data.message.id` 7.

## Publishing from a workflow

1. **An AWS identity** with `sns:Publish` on the topics (it covers `PublishBatch` too; an encrypted topic also needs
   `kms:GenerateDataKey` and `kms:Decrypt` on its key).
2. **The resource**: Resources → New resource → Amazon SNS. Per environment: the region and the identity. **Test
   connection** names the identity.
3. **The query**: a resource query on it, action **Publish**: the topic ARN and the messages as JSON with `{{ }}`
   (`{"message": {{ order }}, "subject": "New order", "attributes": {"kind": "created"}}`, or an array, sent ten at a
   time). A message that isn't a string is sent as JSON. On a FIFO topic (`….fifo`) each needs a `groupId`, and a
   `deduplicationId` unless the topic deduplicates by content. It answers each message's id; messages SNS refused
   are listed under `failed` in the query's metadata (all refused: an error).

## When it fails

| It says | What to do |
|---|---|
| Publishing the workflow refused: `List the SNS topics …` | The webhook's topic ARNs: the topics it takes. |
| The subscription stays "PendingConfirmation" | The webhook isn't published, the topic isn't in its list, or SNS can't reach the instance (a private address, a firewall). Delete the pending subscription and subscribe again. |
| SNS's delivery logs show 401 | The topic isn't in the webhook's list, raw message delivery is on, or the message was altered on the way (a proxy rewriting the body). |
| `The SNS subscription couldn't be confirmed: …` (503) | The instance couldn't fetch the SubscribeURL (outbound HTTPS to `sns.<region>.amazonaws.com`). SNS sends the confirmation again a few times; or subscribe again. |
| Runs failing | The workflow fails: its runs say why. SNS retries a delivery that wasn't answered 2xx (by the topic's delivery policy); the message id is the idempotency key, so a retry doesn't start a second run. |
| `AWS refused … (AuthorizationError)` (publishing) | The identity's policy: `sns:Publish` on the topic. |
| `"…" isn't a topic ARN` / `A FIFO topic needs a groupId on every message` | The query's topic ARN, or the messages' `groupId`. |

## Not supported

Creating subscriptions from here (subscribe the webhook's URL in AWS); SMS, email and mobile push; raw message
delivery to the webhook; receiving through an SQS subscription is the SQS trigger's (`docs/runbooks/sqs.md`), where
the body is SNS's envelope as it is.
