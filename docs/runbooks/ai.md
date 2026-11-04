# Runbook: AI resources

M35 added two resource types that call a language model: **Anthropic** (Claude) and **OpenAI-compatible** (OpenAI,
Azure OpenAI's v1 API, Mistral, Ollama, vLLM, LiteLLM and other gateways). The design is `docs/architecture.md` §2.38;
this page is for setting them up, keeping an eye on what they cost, and finding out why a call fails.

## What they are

- They're **service resources** (M27's shape): per environment, the key encrypted, a query is an **action** and its
  fields. So the "AI block" is a **Resource query block** on an AI resource, an app's AI query is an app's resource
  query, and the resource's **Query** tab is the playground.
- Actions: **Generate text** (a prompt, an optional system prompt; the data is the text), **Summarize** (short, medium
  or long, prose or bullets; text), **Extract JSON** (a JSON Schema, an object at the top: the data is JSON checked
  against it), **Classify** (2 to 100 labels, one or several: `{label, reason}` or `{labels, reason}`), and **Agent**
  (workflows as tools; workflows only). Every field is a template; the model's answer is data, never evaluated.
- The block's **metadata**: `provider`, `model` (the one that answered), `usage` (`inputTokens`, `outputTokens`,
  `cacheReadTokens`, `cacheWriteTokens`), `costUsd` (null when the model has no price), `stopReason`, `durationMs`,
  and the prompts sent as `request` (`system`, `prompt`) unless the resource hides them (`promptsHidden: true`).
- In the editor, `{{ }}` and code completions know the data's shape from the action: the extract schema's type, the
  classify labels, `{answer, steps}` for the agent.

## Setting up Anthropic

1. Resources → **New resource** → AI → **Anthropic**.
2. **API key**: console.anthropic.com → API keys. A key per environment is best (a staging key with a low spend limit).
3. **Default model**: `claude-sonnet-5-5` unless changed. The list offers Anthropic's current models; any id may be
   typed. A query's own **Model** field overrides it.
4. **Base URL**: empty for api.anthropic.com. A proxy or gateway in front of it goes here (with **Allow a private
   network address** if it's inside the network).
5. **Fall back on refusal** (on): when the model declines, Anthropic answers with its fallback model on the models that
   offer it (`claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`). The data's `model` says
   which one answered.
6. **Save**, then **Test connection**: it lists the models ("Signed in: N models, claude-sonnet-5-5 among them").

The server never reads `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN` from its own environment:
only the resource's settings are used.

## Setting up an OpenAI-compatible provider

1. Resources → **New resource** → AI → **OpenAI-compatible**.
2. **Base URL** up to `/v1`: `https://api.openai.com/v1`, Azure OpenAI's `https://<name>.openai.azure.com/openai/v1`,
   `https://api.mistral.ai/v1`, `http://ollama:11434/v1` (with **Allow a private network address**).
3. **Model**: required, the provider's id (`gpt-5.1`, `mistral-large-latest`, `llama3.3`…).
4. **API key**: optional (a local model may need none).
5. **Input price** and **Output price** (US dollars per million tokens): optional; without them the cost is unknown,
   shown as "cost unknown", never 0.
6. **Test connection** asks `GET /models`.

Calls are `POST <base>/chat/completions`; extract and classify use `response_format: json_schema`, **strict** only
when the schema allows it (every property required and `additionalProperties: false` on every object; otherwise sent
non-strict and checked here), the agent function calling (`tools`, `tool_calls`). The answer's length is
`max_completion_tokens` for OpenAI's own API and Azure OpenAI (their reasoning models refuse `max_tokens`), `max_tokens`
for every other server. A provider that doesn't support structured output fails `ai_invalid_output` (the answer isn't
JSON, or doesn't match). Redirects are never followed (by either type): a base URL that answers 3xx fails `http`,
naming where it pointed; use that address.

## Budgets and costs

- **Token budget per run** (both types): the input and output tokens (cache reads and writes included) a run's AI calls
  may use **in all**, across its blocks, loops and function calls. Each call is checked **before** it's made against the
  tokens already spent: a call that would start over the budget fails `ai_budget` ("This run has used 1,234 AI tokens,
  over the resource's budget of 1,000 per run"). The call that crosses it isn't cut off; the next one is refused.
- The budget is per resource setting, checked against **the run's** total (all AI resources' calls together).
- An agent's turns each count; a refusal mid-agent carries the usage so far.
- A resumed run (a worker restarted) starts from its checkpoints' AI calls; a **loop's** AI iterations keep only their
  data, so after a resume their tokens aren't counted again.
- **Apps and the playground have no budget** (each query is one call; an app can't run the agent).
- Prices: Anthropic's list prices (2026-11-04) are built in (`packages/connectors/src/ai/prices.ts`); update them there
  when Anthropic changes them. Prompt caching is on (automatic `cache_control`): repeated system prompts and inputs cost
  a tenth.

Metrics (Prometheus, `/metrics`):

- Model labels are the first 100 distinct models a process sees; later ones count as `model="other"`.
- `ow_ai_calls_total{provider,model,outcome}`: `outcome` is `ok` or the error's code (`ai_budget`, `ai_refused`,
  `ai_max_tokens`, `ai_invalid_output`, `ai_max_steps`, `http`, `timeout`, …).
- `ow_ai_tokens_total{provider,model,kind}`: `kind` is `input`, `output`, `cache_read`, `cache_write`.
- `ow_ai_cost_usd_total{provider,model}`: calls without a price add nothing.

These are per process (API and worker each): sum them.

## Prompts in run history

- The run view shows, for a block's AI call: the model, tokens, cost and time, and the **Prompts sent** (system and
  prompt, as rendered). The run log gets a line per call: `AI call: anthropic claude-sonnet-5-5, 812 input + 64 output
  tokens, $0.002264, 1.2 s` (a warning when the call answered and then failed).
- Whoever can see the run sees the prompts, as with a REST query's request. When prompts hold personal data, turn on
  **Hide prompts in run history** on the resource: the metadata then says `promptsHidden: true`, and the log line ends
  in "prompts hidden". The **answer** is still the block's data (a run's data is kept by the retention settings).

## The agent

- **Workflows it may call**: slugs written out, never `{{ }}` (the editor reports one; the picker under the field
  adds published ones). Each is offered to the
  model by its slug, its **description** (Workflow settings; write it for the model: what it does, what it returns) and
  its **webhook trigger's body schema** (none: any object). Write the body schema: it's how the model knows the input.
- Each tool call is a **child run** of the workflow's **live release** in the run's environment, as a Workflow block
  starts one (linked from the run view's "Tool calls", and listed by `GET /runs/:id/children`). The tool's result is
  the child's Response block's body. A failed child is sent back to the model as an error, which it can work around.
- Several calls in one turn run 4 at a time; a result over 100,000 characters is cut with a note.
- **Max steps** (default 10, at most 50): model turns that call tools. A model still calling tools after that fails
  `ai_max_steps`.
- Who may use it: a draft run needs **Use** on each tool workflow (as for a Workflow block); publishing needs Use on
  them too; a tool that isn't published is reported in the editor and refuses the run.
- The agent runs in **workflows only**: in an app or the playground it fails "The agent runs in workflows only".

## When a call fails

| Code | What it means | What to do |
| --- | --- | --- |
| `ai_budget` | The run had spent the resource's token budget | Raise the budget, or make fewer or smaller calls |
| `ai_refused` | The model declined (Anthropic's category in the message, e.g. `cyber`) | Rephrase; with Anthropic, keep Fall back on refusal on |
| `ai_max_tokens` | The answer was cut off at Max tokens, or the input and answer didn't fit the model's context window | Raise **Max tokens** on the query (default 16,000); shorten the input |
| `ai_invalid_output` | Extract/classify: the answer isn't JSON or doesn't match the schema (`details.answer` has it); or the model stopped early for another reason (named in the message) | Simplify the schema; add `required` and `additionalProperties: false`; a stronger model |
| `ai_max_steps` | The agent was still calling tools after Max steps | Clearer instructions, better tool descriptions, more steps |
| `http` 401 | The key is wrong or revoked | Replace the key; Test connection |
| `http` 429 | Rate limited after 2 retries | The provider's limits; fewer concurrent runs (workflow concurrency) |
| `http` 404 (OpenAI-compatible) | Wrong base URL or model | Base URL up to `/v1`; the model id at that provider |
| `blocked` | The base URL is on a private network | Allow a private network address, if that's intended |
| `timeout` | No answer within the block's timeout | Raise the block's timeout; lower effort; a faster model |

Both providers retry twice on 408, 409, 429, 5xx and connection failures (Anthropic through its SDK, honouring its
headers; OpenAI-compatible honouring `retry-after`, up to 30 s).

## Testing without a provider

`startFakeAi()` (`@ow/connectors/testing`) serves fakes of both APIs; the e2e setup starts one (`E2E_AI`). Markers in
the prompt steer it: `REFUSE_ME` (a refusal), `RATE_LIMIT_ONCE` (a 429, then success), `LABEL=<label>` (the label a
classification picks). Its extract answers are samples of the schema; its agent calls the first tool once, then answers
"Done: <the tool's result>".
