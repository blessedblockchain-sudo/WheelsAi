/**
 * services/agentKind.ts: what the API accepts and stores for an agent's
 * kind and its settings.
 *
 * What is pinned here: a create needs nothing and gives a conversation
 * agent; a task agent always has a form; on an update a key that is sent
 * replaces that key and the others stay, so changing the kind and changing
 * back loses nothing; every refusal is in plain words under the field it is
 * about; the 16 KB cap holds for what was sent and for what would be
 * stored; copies are deep; and the six seeded templates carry the same
 * settings in the migration and in the seed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { Prisma } from "@prisma/client";
import {
  DEFAULT_TASK_FIELDS,
  MAX_KIND_CONFIG_BYTES,
  MAX_RUN_LINE_LENGTH,
  kindConfigBytes,
  taskInputSchema,
  type KindConfig,
} from "@wheelsai/shared/agent-kind";

import {
  KIND_MESSAGES,
  cloneKindConfig,
  publicTaskForm,
  resolveKindConfig,
  type KindConfigResolution,
} from "../services/agentKind.js";
import { compileUserSchema } from "../services/jsonSchema.js";

// A Tuesday.
const NOW = new Date("2026-10-06T12:00:00Z");

const DEFAULT_FORM = { fields: [{ key: "your_request", label: "Your request", type: "long_text", required: true }] };
const TOPIC_FORM = { fields: [{ key: "topic", label: "Topic", type: "short_text", required: true }] };
const DAILY = { schedule: { cronExpression: "0 9 * * *", timezone: "Europe/Berlin" }, prompt: "Write the briefing." };

function ok(result: KindConfigResolution) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as Extract<KindConfigResolution, { ok: true }>;
}
function refused(result: KindConfigResolution) {
  assert.equal(result.ok, false, JSON.stringify(result));
  return result as Extract<KindConfigResolution, { ok: false }>;
}

/** No raw codes, no library or database text: a sentence a person can act on. */
function assertPlainWords(fields: Record<string, string>) {
  for (const [field, message] of Object.entries(fields)) {
    assert.match(message, /^["A-Z].*\.$/, `${field}: ${message}`);
    assert.doesNotMatch(message, /_|undefined|null|JSON|schema|ajv|cron-parser|Error|Expected/, `${field}: ${message}`);
  }
}

// A stored value goes into a JSON column as it is.
const asColumn: Prisma.InputJsonValue = {} as KindConfig;
void asColumn;

describe("resolveKindConfig on a create", () => {
  it("nothing sent is a conversation agent with no settings", () => {
    assert.deepEqual(resolveKindConfig({}), { ok: true, agentKind: "conversation", kindConfig: null, changed: true });
    assert.deepEqual(ok(resolveKindConfig({ agentKind: "conversation", kindConfig: null })).kindConfig, null);
    assert.deepEqual(ok(resolveKindConfig({ kindConfig: {} })).kindConfig, null);
  });

  it("a task agent with no form gets the default one", () => {
    const result = ok(resolveKindConfig({ agentKind: "task" }));
    assert.equal(result.agentKind, "task");
    assert.deepEqual(result.kindConfig, { task: DEFAULT_FORM });
    // Its own copy: the shared default is not handed out.
    assert.notEqual(result.kindConfig?.task?.fields[0], DEFAULT_TASK_FIELDS[0]);
    assert.deepEqual(ok(resolveKindConfig({ agentKind: "task", kindConfig: null })).kindConfig, { task: DEFAULT_FORM });
    assert.deepEqual(ok(resolveKindConfig({ agentKind: "task", kindConfig: { task: null } })).kindConfig, {
      task: DEFAULT_FORM,
    });
  });

  it("a task agent's form is stored normalized, with keys made from the labels", () => {
    const result = ok(
      resolveKindConfig({
        agentKind: "task",
        kindConfig: {
          task: {
            fields: [
              { label: " Code to review ", type: "long_text", required: true },
              { label: "Focus", type: "choice", options: ["Bugs", " Security ", "Bugs"] },
            ],
          },
        },
      }),
    );
    assert.deepEqual(result.kindConfig, {
      task: {
        fields: [
          { key: "code_to_review", label: "Code to review", type: "long_text", required: true },
          { key: "focus", label: "Focus", type: "choice", required: false, options: ["Bugs", "Security"] },
        ],
      },
    });
  });

  it("a scheduled agent needs no settings, and keeps a suggested schedule and its line", () => {
    assert.deepEqual(ok(resolveKindConfig({ agentKind: "scheduled" })).kindConfig, null);
    const result = ok(
      resolveKindConfig(
        {
          agentKind: "scheduled",
          kindConfig: { scheduled: { schedule: { cronExpression: " 0  9 * * 1-5 ", timezone: "Europe/Berlin" }, prompt: "  Go.  " } },
        },
        { now: NOW },
      ),
    );
    assert.deepEqual(result.kindConfig, {
      scheduled: { schedule: { cronExpression: "0 9 * * 1-5", timezone: "Europe/Berlin" }, prompt: "Go." },
    });
    // No time zone sent: none stored, and the reader's default applies.
    assert.deepEqual(
      ok(resolveKindConfig({ kindConfig: { scheduled: { schedule: { cronExpression: "0 9 * * *" } } } }, { now: NOW })).kindConfig,
      { scheduled: { schedule: { cronExpression: "0 9 * * *" } } },
    );
    // A schedule part with nothing in it is no settings at all.
    assert.deepEqual(ok(resolveKindConfig({ kindConfig: { scheduled: { prompt: "   " } } })).kindConfig, null);
  });

  it("settings of another kind may be sent with any kind, and are kept", () => {
    const result = ok(resolveKindConfig({ agentKind: "conversation", kindConfig: { task: TOPIC_FORM, scheduled: DAILY } }, { now: NOW }));
    assert.equal(result.agentKind, "conversation");
    assert.deepEqual(result.kindConfig, { task: TOPIC_FORM, scheduled: DAILY });
  });

  it("stores the keys in one order, whatever order they were sent in", () => {
    const result = ok(resolveKindConfig({ kindConfig: { scheduled: DAILY, task: TOPIC_FORM } }, { now: NOW }));
    assert.deepEqual(Object.keys(result.kindConfig ?? {}), ["task", "scheduled"]);
  });

  it("does not keep a reference to what was sent", () => {
    const sent = { task: { fields: [{ key: "topic", label: "Topic", type: "choice", required: true, options: ["a", "b"] }] } };
    const result = ok(resolveKindConfig({ agentKind: "task", kindConfig: sent }));
    sent.task.fields[0]!.options.push("c");
    sent.task.fields[0]!.label = "Changed";
    assert.deepEqual(result.kindConfig?.task?.fields[0]?.options, ["a", "b"]);
    assert.equal(result.kindConfig?.task?.fields[0]?.label, "Topic");
  });
});

describe("resolveKindConfig on an update", () => {
  const current = { agentKind: "task", kindConfig: { task: TOPIC_FORM, scheduled: DAILY } };

  it("nothing sent changes nothing", () => {
    assert.deepEqual(resolveKindConfig({}, { current, now: NOW }), {
      ok: true,
      agentKind: "task",
      kindConfig: { task: TOPIC_FORM, scheduled: DAILY },
      changed: false,
    });
  });

  it("the same values sent again are not a change", () => {
    const again = resolveKindConfig({ agentKind: "task", kindConfig: { task: TOPIC_FORM } }, { current, now: NOW });
    assert.equal(ok(again).changed, false);
  });

  it("a key that is sent replaces that key, and the other stays", () => {
    const form = { fields: [{ key: "topic", label: "Subject", type: "short_text", required: false }] };
    const result = ok(resolveKindConfig({ kindConfig: { task: form } }, { current, now: NOW }));
    assert.deepEqual(result.kindConfig, { task: form, scheduled: DAILY });
    assert.equal(result.agentKind, "task");
    assert.equal(result.changed, true);

    const line = ok(resolveKindConfig({ kindConfig: { scheduled: { prompt: "New line." } } }, { current, now: NOW }));
    // Replaced, not merged into: the schedule that was not sent is gone.
    assert.deepEqual(line.kindConfig, { task: TOPIC_FORM, scheduled: { prompt: "New line." } });
  });

  it("changing the kind and changing back loses nothing", () => {
    const away = ok(resolveKindConfig({ agentKind: "scheduled" }, { current, now: NOW }));
    assert.equal(away.agentKind, "scheduled");
    assert.equal(away.changed, true);
    assert.deepEqual(away.kindConfig, { task: TOPIC_FORM, scheduled: DAILY });

    const chat = ok(resolveKindConfig({ agentKind: "conversation" }, { current: away, now: NOW }));
    assert.deepEqual(chat.kindConfig, { task: TOPIC_FORM, scheduled: DAILY });

    const back = ok(resolveKindConfig({ agentKind: "task" }, { current: chat, now: NOW }));
    assert.deepEqual(back, { ok: true, agentKind: "task", kindConfig: { task: TOPIC_FORM, scheduled: DAILY }, changed: true });
  });

  it("becoming a task agent for the first time gives the default form and keeps the rest", () => {
    const result = ok(
      resolveKindConfig({ agentKind: "task" }, { current: { agentKind: "scheduled", kindConfig: { scheduled: DAILY } }, now: NOW }),
    );
    assert.deepEqual(result.kindConfig, { task: DEFAULT_FORM, scheduled: DAILY });
  });

  it("null removes a key, and null for the whole clears the settings", () => {
    const noSchedule = ok(resolveKindConfig({ kindConfig: { scheduled: null } }, { current, now: NOW }));
    assert.deepEqual(noSchedule.kindConfig, { task: TOPIC_FORM });

    const cleared = ok(resolveKindConfig({ agentKind: "conversation", kindConfig: null }, { current, now: NOW }));
    assert.deepEqual(cleared.kindConfig, null);
    assert.equal(cleared.changed, true);

    // A task agent cannot be left without a form.
    assert.deepEqual(ok(resolveKindConfig({ kindConfig: null }, { current, now: NOW })).kindConfig, { task: DEFAULT_FORM });
  });

  it("an agent from before kinds existed is a conversation agent", () => {
    for (const before of [{}, { agentKind: null, kindConfig: null }, { agentKind: "chat" }]) {
      assert.equal(ok(resolveKindConfig({}, { current: before })).agentKind, "conversation");
    }
    assert.equal(ok(resolveKindConfig({}, { current: { agentKind: "conversation", kindConfig: null } })).changed, false);
  });

  it("a stored schedule is not checked again when it was not sent", () => {
    // Stored settings are copied as they are; only what a caller sends is judged.
    const stored = { agentKind: "scheduled", kindConfig: { scheduled: { schedule: { cronExpression: "not a cron" } } } };
    const result = ok(resolveKindConfig({ kindConfig: { task: TOPIC_FORM } }, { current: stored, now: NOW }));
    assert.deepEqual(result.kindConfig?.scheduled, { schedule: { cronExpression: "not a cron" } });
  });
});

describe("resolveKindConfig refuses", () => {
  function fieldsOf(input: Parameters<typeof resolveKindConfig>[0]) {
    const result = refused(resolveKindConfig(input, { now: NOW }));
    assertPlainWords(result.fields);
    assert.equal(result.message, Object.values(result.fields)[0]);
    return result.fields;
  }

  it("a kind that is not one of the three", () => {
    for (const agentKind of ["chat", "Task", "", null, 3, ["task"]]) {
      assert.deepEqual(fieldsOf({ agentKind }), { agentKind: KIND_MESSAGES.invalidKind });
    }
  });

  it("settings that are not an object", () => {
    for (const kindConfig of ["task", 3, [], true]) {
      assert.deepEqual(fieldsOf({ kindConfig }), { kindConfig: KIND_MESSAGES.notAnObject });
    }
  });

  it("a setting it does not know, rather than storing it", () => {
    assert.deepEqual(fieldsOf({ kindConfig: { conversation: {} } }), {
      kindConfig: "The settings of an agent are task and scheduled. Remove anything else.",
    });
    assert.deepEqual(fieldsOf({ kindConfig: { scheduled: { enabled: true } } }), {
      "kindConfig.scheduled": "The schedule settings are schedule and prompt. Remove anything else.",
    });
  });

  it("an unknown setting without repeating its name back", () => {
    const long = "x".repeat(4000);
    for (const kindConfig of [{ [long]: 1 }, { scheduled: { [long]: 1 } }]) {
      const refused = resolveKindConfig({ kindConfig });
      assert.ok(!refused.ok);
      assert.ok(!JSON.stringify(refused).includes("xxxx"), "what was sent is not echoed");
      assert.ok(refused.message.length < 100);
    }
  });

  it("a form with problems, each under the question it is about", () => {
    const fields = fieldsOf({
      agentKind: "task",
      kindConfig: {
        task: {
          fields: [
            { label: "" },
            { label: "Tone", type: "choice", options: ["Only one"] },
            { key: "same", label: "A" },
            { key: "same", label: "B" },
            { label: "File", type: "file" },
            "nope",
          ],
        },
      },
    });
    assert.deepEqual(fields, {
      "kindConfig.task.fields[0].label": "Give this question a label.",
      "kindConfig.task.fields[1].options": "Add at least two options.",
      "kindConfig.task.fields[2].key": "Two questions have the same name in code. Change one.",
      "kindConfig.task.fields[3].key": "Two questions have the same name in code. Change one.",
      "kindConfig.task.fields[4].type":
        "Choose a type for this question: short text, long text, number, choice, yes or no, link or list.",
      "kindConfig.task.fields[5]": "This question could not be read.",
    });
  });

  it("a form that is empty, too long, or not a form", () => {
    assert.deepEqual(fieldsOf({ kindConfig: { task: { fields: [] } } }), {
      "kindConfig.task.fields": "A form needs at least one question.",
    });
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ label: `Question ${i + 1}` }));
    assert.deepEqual(fieldsOf({ kindConfig: { task: { fields: thirteen } } }), {
      "kindConfig.task.fields": "A form can have up to 12 questions.",
    });
    assert.deepEqual(fieldsOf({ kindConfig: { task: {} } }), { "kindConfig.task.fields": "Send the questions as a list." });
    assert.deepEqual(fieldsOf({ kindConfig: { task: [] } }), { "kindConfig.task": KIND_MESSAGES.taskNotAnObject });
  });

  it("a suggested schedule the scheduler could not honour", () => {
    const cron = (cronExpression: unknown, timezone?: unknown) =>
      fieldsOf({ agentKind: "scheduled", kindConfig: { scheduled: { schedule: { cronExpression, timezone } } } });

    for (const bad of ["every day", "* * * *", "61 9 * * *", "* * * * * *", "0 9 * * mon-funday"]) {
      assert.deepEqual(cron(bad), { "kindConfig.scheduled.schedule.cronExpression": KIND_MESSAGES.cronInvalid }, bad);
    }
    for (const missing of [undefined, "", "   ", 5]) {
      assert.deepEqual(cron(missing), { "kindConfig.scheduled.schedule.cronExpression": KIND_MESSAGES.cronRequired });
    }
    for (const zone of ["Mars/Olympus", "EST", "+02:00", 2]) {
      assert.deepEqual(cron("0 9 * * *", zone), { "kindConfig.scheduled.schedule.timezone": KIND_MESSAGES.timezoneInvalid });
    }
    assert.deepEqual(fieldsOf({ kindConfig: { scheduled: { schedule: "0 9 * * *" } } }), {
      "kindConfig.scheduled.schedule": KIND_MESSAGES.scheduleNotAnObject,
    });
    assert.deepEqual(fieldsOf({ kindConfig: { scheduled: "daily" } }), {
      "kindConfig.scheduled": KIND_MESSAGES.scheduledNotAnObject,
    });
  });

  it("a line for each run that is not text, or is too long", () => {
    assert.deepEqual(fieldsOf({ kindConfig: { scheduled: { prompt: 5 } } }), {
      "kindConfig.scheduled.prompt": KIND_MESSAGES.promptNotText,
    });
    assert.deepEqual(fieldsOf({ kindConfig: { scheduled: { prompt: "x".repeat(MAX_RUN_LINE_LENGTH + 1) } } }), {
      "kindConfig.scheduled.prompt": KIND_MESSAGES.promptTooLong,
    });
    ok(resolveKindConfig({ kindConfig: { scheduled: { prompt: "x".repeat(MAX_RUN_LINE_LENGTH) } } }));
  });

  it("text the database cannot store, as a field problem and not a failed write", () => {
    for (const prompt of ["Check\u0000 the market", "Check \ud83d the market", "Check \u001b[31m the market"]) {
      assert.deepEqual(fieldsOf({ kindConfig: { scheduled: { prompt } } }), {
        "kindConfig.scheduled.prompt": KIND_MESSAGES.promptNotPlainText,
      });
    }
    // A run line may have several lines, and any complete character.
    const kept = ok(resolveKindConfig({ kindConfig: { scheduled: { prompt: "Check the market.\n\tThen report \ud83d\ude80" } } }));
    assert.equal(kept.kindConfig?.scheduled?.prompt, "Check the market.\n\tThen report \ud83d\ude80");

    assert.deepEqual(
      fieldsOf({
        agentKind: "task",
        kindConfig: { task: { fields: [{ label: "a\u0000b" }, { label: "Tone", type: "choice", options: ["a\u0000", "b"] }] } },
      }),
      {
        "kindConfig.task.fields[0].label": "Use plain text on one line here, without line breaks or hidden characters.",
        "kindConfig.task.fields[1].options": "Use plain text on one line here, without line breaks or hidden characters.",
      },
    );
  });

  it("reports the kind and the settings together", () => {
    const fields = fieldsOf({ agentKind: "robot", kindConfig: { task: { fields: [{ label: "" }] } } });
    assert.deepEqual(Object.keys(fields), ["agentKind", "kindConfig.task.fields[0].label"]);
  });

  it("refusing stores nothing: there is no value on a refusal", () => {
    const result = refused(resolveKindConfig({ agentKind: "task", kindConfig: { task: { fields: [{ label: "" }] } } }));
    assert.equal("kindConfig" in result, false);
    assert.equal("agentKind" in result, false);
  });
});

describe("the 16 KB cap", () => {
  /** Twelve choices of fifty options: as large as a form's own limits allow. */
  function largeForm(optionLength: number) {
    return {
      fields: Array.from({ length: 12 }, (_, f) => ({
        key: `question_${f + 1}`,
        label: `Question ${f + 1}`,
        type: "choice",
        required: false,
        options: Array.from({ length: 50 }, (_, o) => `${String(o).padStart(2, "0")}${"x".repeat(optionLength - 2)}`),
      })),
    };
  }

  it("a form inside every other limit is still refused when it is over 16 KB", () => {
    const form = largeForm(100);
    assert.ok(kindConfigBytes({ task: form }) > MAX_KIND_CONFIG_BYTES);
    const result = refused(resolveKindConfig({ agentKind: "task", kindConfig: { task: form } }));
    assert.deepEqual(result.fields, { kindConfig: KIND_MESSAGES.tooLarge });
    assert.equal(result.message, "These settings are too large to save. Shorten the questions, the help text or the options.");
  });

  it("a form under it is stored, and what is stored is under it", () => {
    const result = ok(resolveKindConfig({ agentKind: "task", kindConfig: { task: largeForm(20) } }));
    assert.ok(kindConfigBytes(result.kindConfig) <= MAX_KIND_CONFIG_BYTES);
    assert.equal(result.kindConfig?.task?.fields.length, 12);
  });

  it("counts what is kept together with what is sent", () => {
    // Each part fits alone; together they do not.
    const form = largeForm(22);
    const current = { agentKind: "task", kindConfig: { task: form } };
    const formBytes = kindConfigBytes({ task: form });
    assert.ok(formBytes <= MAX_KIND_CONFIG_BYTES);
    const prompt = "x".repeat(MAX_RUN_LINE_LENGTH);
    assert.ok(formBytes + prompt.length > MAX_KIND_CONFIG_BYTES, `the form is only ${formBytes} bytes`);

    const result = refused(resolveKindConfig({ kindConfig: { scheduled: { prompt } } }, { current }));
    assert.deepEqual(result.fields, { kindConfig: KIND_MESSAGES.tooLarge });
  });

  it("counts bytes, not characters", () => {
    // 12 x 50 options of 9 three-byte characters: 5,400 characters of options, 16,200 bytes.
    const form = {
      fields: Array.from({ length: 12 }, (_, f) => ({
        key: `q${f}`,
        label: "Q",
        type: "choice",
        options: Array.from({ length: 50 }, (_, o) => `${String.fromCharCode(0x4e00 + o)}${"日".repeat(8)}`),
      })),
    };
    assert.ok(JSON.stringify({ task: form }).length < MAX_KIND_CONFIG_BYTES);
    const result = refused(resolveKindConfig({ agentKind: "task", kindConfig: { task: form } }));
    assert.deepEqual(result.fields, { kindConfig: KIND_MESSAGES.tooLarge });
  });

  it("an oversized value is refused before its questions are read", () => {
    const junk = { task: { fields: [{ label: "" }] }, padding: "x".repeat(MAX_KIND_CONFIG_BYTES) };
    assert.deepEqual(refused(resolveKindConfig({ kindConfig: junk })).fields, { kindConfig: KIND_MESSAGES.tooLarge });
  });
});

describe("cloneKindConfig", () => {
  const stored: KindConfig = {
    task: { fields: [{ key: "tone", label: "Tone", type: "choice", required: true, help: "Pick one.", options: ["Friendly", "Formal"] }] },
    scheduled: { schedule: { cronExpression: "0 9 * * *", timezone: "UTC" }, prompt: "Go." },
  };

  it("copies everything, and shares nothing", () => {
    const copy = cloneKindConfig(stored);
    assert.deepEqual(copy, stored);
    assert.notEqual(copy, stored);
    assert.notEqual(copy?.task, stored.task);
    assert.notEqual(copy?.task?.fields, stored.task?.fields);
    assert.notEqual(copy?.task?.fields[0], stored.task?.fields[0]);
    assert.notEqual(copy?.task?.fields[0]?.options, stored.task?.fields[0]?.options);
    assert.notEqual(copy?.scheduled, stored.scheduled);
    assert.notEqual(copy?.scheduled?.schedule, stored.scheduled?.schedule);

    // Changing the copy leaves the original alone, and the other way round.
    const before = JSON.stringify(stored);
    copy!.task!.fields[0]!.options!.push("Rude");
    copy!.task!.fields.push({ key: "x", label: "X", type: "number", required: false });
    copy!.scheduled!.schedule!.cronExpression = "* * * * *";
    assert.equal(JSON.stringify(stored), before);
  });

  it("is null when there is nothing to copy", () => {
    for (const nothing of [null, undefined, {}, [], "x", 3, { task: null }, { scheduled: {} }, { other: 1 }]) {
      assert.equal(cloneKindConfig(nothing), null, JSON.stringify(nothing));
    }
  });

  it("carries only what it knows", () => {
    const copy = cloneKindConfig({
      task: { fields: [{ key: "topic", label: "Topic", type: "short_text", required: true, secret: "s" }], ownerNote: "n" },
      scheduled: { schedule: { cronExpression: "0 9 * * *", channelId: "c1" }, prompt: "Go.", webhook: "https://example.com/hook" },
      publicHandle: "acme",
      internal: { orgId: "o1" },
    });
    assert.deepEqual(copy, {
      task: TOPIC_FORM,
      scheduled: { schedule: { cronExpression: "0 9 * * *" }, prompt: "Go." },
    });
  });

  it("drops a form it cannot read, and keeps the rest", () => {
    assert.deepEqual(cloneKindConfig({ task: { fields: [{ label: "" }] }, scheduled: { prompt: "Go." } }), {
      scheduled: { prompt: "Go." },
    });
  });

  it("what resolveKindConfig stores comes back from a copy unchanged", () => {
    const result = ok(resolveKindConfig({ agentKind: "task", kindConfig: { task: TOPIC_FORM, scheduled: DAILY } }, { now: NOW }));
    assert.deepEqual(cloneKindConfig(result.kindConfig), result.kindConfig);
    // Through the database and back (JSON), too.
    assert.deepEqual(cloneKindConfig(JSON.parse(JSON.stringify(result.kindConfig))), result.kindConfig);
  });
});

describe("publicTaskForm", () => {
  it("is the schema in field order, the order beside it, and nothing else", () => {
    const form = publicTaskForm({
      task: {
        fields: [
          { key: "zebra", label: "Zebra", type: "short_text", required: true },
          { key: "apple", label: "Apple", type: "yes_no", required: false },
        ],
      },
      scheduled: DAILY,
    });
    assert.deepEqual(Object.keys(form), ["schema", "order"]);
    assert.deepEqual(form.order, ["zebra", "apple"]);
    assert.deepEqual(Object.keys(form.schema.properties), ["zebra", "apple"]);
    assert.deepEqual(form.schema.required, ["zebra"]);
    const text = JSON.stringify(form);
    for (const internal of ["scheduled", "cronExpression", "Write the briefing", "Europe/Berlin"]) {
      assert.equal(text.includes(internal), false, internal);
    }
    assert.doesNotThrow(() => compileUserSchema(form.schema, { root: "object" }));
  });

  it("an agent with no form shows the default one", () => {
    for (const none of [null, undefined, {}, { scheduled: DAILY }]) {
      const form = publicTaskForm(none);
      assert.deepEqual(form.order, ["your_request"]);
      assert.deepEqual(form.schema, taskInputSchema(DEFAULT_TASK_FIELDS));
    }
  });
});

describe("the seeded templates", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");
  const migration = read("packages/db/prisma/migrations/20261013100000_agent_kind/migration.sql");
  const seed = read("packages/db/prisma/seed.ts");

  /** slug -> what the migration writes. */
  const fromMigration = new Map<string, { agentKind: string; kindConfig: unknown }>();
  const statement =
    /UPDATE "agent_templates"\s+SET "agent_kind" = '(\w+)',\s+"kind_config" = '([\s\S]*?)'::jsonb\s+WHERE "slug" = '([a-z-]+)' AND "kind_config" IS NULL;/g;
  for (const match of migration.matchAll(statement)) {
    fromMigration.set(match[3]!, { agentKind: match[1]!, kindConfig: JSON.parse(match[2]!.replace(/''/g, "'")) });
  }

  /** slug -> what the seed writes (the object between its two markers). */
  const literal = /\/\/ template-kinds:start\s+const templateKinds = (\{[\s\S]*?\});\s+\/\/ template-kinds:end/.exec(seed)?.[1];
  assert.ok(literal, "packages/db/prisma/seed.ts must keep templateKinds between its two markers");
  const fromSeed = new Function("Prisma", `return (${literal});`)({ DbNull: null }) as Record<
    string,
    { agentKind: string; kindConfig: unknown }
  >;

  const KINDS: Record<string, string> = {
    "customer-support-bot": "conversation",
    "code-review-assistant": "task",
    "research-summarizer": "task",
    "content-writer": "task",
    "trading-signal-agent": "scheduled",
    "multi-agent-pipeline": "task",
  };

  it("are the six, each with its kind", () => {
    assert.deepEqual(Object.keys(fromSeed).sort(), Object.keys(KINDS).sort());
    for (const [slug, kind] of Object.entries(KINDS)) assert.equal(fromSeed[slug]?.agentKind, kind, slug);
    // Every template in the seed has an entry, so the seed's own check cannot throw.
    const slugs = [...seed.matchAll(/^ {4}slug: "([a-z-]+)",$/gm)].map((match) => match[1]);
    assert.deepEqual(slugs.sort(), Object.keys(KINDS).sort());
  });

  it("the migration and the seed write the same values", () => {
    // The conversation template needs no statement: the column default is its kind.
    assert.deepEqual([...fromMigration.keys()].sort(), Object.keys(KINDS).filter((slug) => KINDS[slug] !== "conversation").sort());
    for (const [slug, written] of fromMigration) {
      assert.deepEqual(written, fromSeed[slug], slug);
      // In the same key order, so the seed's update is a no-op in every reading.
      assert.equal(JSON.stringify(written), JSON.stringify(fromSeed[slug]), slug);
    }
    assert.deepEqual(fromSeed["customer-support-bot"], { agentKind: "conversation", kindConfig: null });
  });

  it("each is exactly what the API would store for it", () => {
    for (const [slug, template] of Object.entries(fromSeed)) {
      const result = ok(resolveKindConfig({ agentKind: template.agentKind, kindConfig: template.kindConfig }, { now: NOW }));
      assert.equal(result.agentKind, KINDS[slug]);
      assert.deepEqual(result.kindConfig, template.kindConfig, slug);
      assert.equal(JSON.stringify(result.kindConfig), JSON.stringify(template.kindConfig), slug);
      if (result.agentKind === "task") {
        assert.doesNotThrow(() => compileUserSchema(publicTaskForm(result.kindConfig).schema, { root: "object" }), slug);
        assert.ok(result.kindConfig?.task?.fields.some((field) => field.required), `${slug} asks for something`);
      }
    }
    assert.deepEqual(fromSeed["trading-signal-agent"]?.kindConfig, {
      scheduled: {
        schedule: { cronExpression: "0 9 * * *", timezone: "UTC" },
        prompt: "Check the market for BTC, ETH and SOL and report today's trading signals, with the risk for each.",
      },
    });
  });

  it("the migration holds agent_kind to the three kinds on all three tables", () => {
    for (const table of ["agents", "agent_templates"]) {
      assert.ok(
        migration.includes(
          `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_agent_kind_check" CHECK ("agent_kind" IN ('conversation', 'task', 'scheduled'));`,
        ),
        table,
      );
      assert.match(migration, new RegExp(`ALTER TABLE "${table}"\\s+ADD COLUMN "agent_kind" TEXT NOT NULL DEFAULT 'conversation',\\s+ADD COLUMN "kind_config" JSONB;`));
    }
    assert.ok(
      migration.includes(
        `CHECK ("agent_kind" IS NULL OR "agent_kind" IN ('conversation', 'task', 'scheduled'));`,
      ),
    );
    assert.match(migration, /ALTER TABLE "agent_versions"\s+ADD COLUMN "agent_kind" TEXT,\s+ADD COLUMN "kind_config" JSONB;/);
  });

  it("the seed no longer names a model in the template's description", () => {
    const description = /slug: "customer-support-bot",[\s\S]*?longDescription:\s+"([^"]+)"/.exec(seed)?.[1];
    assert.ok(description);
    assert.doesNotMatch(description, /Llama|GPT|Claude|Gemini|Mistral|\d+B\b/);
  });
});
