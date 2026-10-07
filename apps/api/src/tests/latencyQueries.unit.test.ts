import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTOGRAM_EDGES_MS,
  groupedLatencyQuery,
  latencyHistogramQuery,
  outcomeCountsQuery,
  pruneLatencyQuery,
  publicLatencyQuery,
  scopedLatencyQuery,
} from "../services/latencyQueries.js";

// Every stated latency is one of these queries over request_latency_samples.
// What each filters on is the definition of the number it produces, so it is
// pinned here: a public figure that quietly counted failures, the dev mock or
// our own test organization would be a different (and better-looking) number.

const SINCE = new Date("2026-10-06T09:00:00.000Z");
const UNTIL = new Date("2026-10-07T09:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";
const AGENT = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT = "33333333-3333-4333-8333-333333333333";

const flat = (text: string) => text.replace(/\s+/g, " ");

const platform = {
  since: SINCE,
  surfaces: ["v1", "agent_api"],
  excludedOrgIds: [OTHER_ORG],
  maxSamplesPerOrg: 17,
};

test("the public query counts successful answers on the listed surfaces in the window", () => {
  const { text, values } = publicLatencyQuery(platform);
  const sql = flat(text);
  assert.match(sql, /FROM request_latency_samples/);
  assert.match(sql, /created_at >= \$1/);
  assert.match(sql, /surface = ANY\(\$2::text\[\]\)/);
  assert.match(sql, /provider <> 'nosana_mock'/);
  assert.match(sql, /NOT \(org_id = ANY\(\$3::uuid\[\]\)\)/);
  assert.match(sql, /outcome = 'ok'/);
  assert.deepEqual(values, [SINCE, ["v1", "agent_api"], [OTHER_ORG], 17]);
});

// One organization must not be able to set the platform's figure by sending
// more requests than everyone else: each counts for its most recent N only.
const CAP_SUBQUERY =
  /FROM \( SELECT org_id, outcome, total_ms, first_token_ms, row_number\(\) OVER \(PARTITION BY org_id ORDER BY created_at DESC, id DESC\) AS org_rank FROM request_latency_samples WHERE (.*?) \) AS capped WHERE org_rank <= \$4/;

test("every platform query reads each organization's most recent rows only, up to the bound cap", () => {
  for (const query of [publicLatencyQuery(platform), latencyHistogramQuery(platform), outcomeCountsQuery(platform)]) {
    const sql = flat(query.text);
    const capped = CAP_SUBQUERY.exec(sql);
    assert.ok(capped, sql);
    // The platform filter is applied BEFORE the ranking, so excluded rows do
    // not use up an organization's share.
    assert.match(capped[1]!, /created_at >= \$1 AND surface = ANY\(\$2::text\[\]\)/);
    assert.equal(query.values[3], 17);
    // Nothing reads the table un-capped: the only FROM on it is the ranked one.
    assert.equal(sql.match(/FROM request_latency_samples/g)!.length, 1);
    assert.ok(!query.text.includes("17"), "the cap is bound, not spliced");
  }
});

test("the latency figure and its histogram rank answers only; the error share ranks every ending", () => {
  const inner = (text: string) => CAP_SUBQUERY.exec(flat(text))![1]!;
  assert.match(inner(publicLatencyQuery(platform).text), /AND outcome = 'ok'$/);
  assert.match(inner(latencyHistogramQuery(platform).text), /AND outcome = 'ok'$/);
  assert.ok(!/outcome = /.test(inner(outcomeCountsQuery(platform).text)));
});

test("a cap that is not a positive whole number counts one request per organization, never all", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.4]) {
    assert.equal(publicLatencyQuery({ ...platform, maxSamplesPerOrg: bad }).values[3], 1, String(bad));
  }
  assert.equal(publicLatencyQuery({ ...platform, maxSamplesPerOrg: 17.9 }).values[3], 17);
});

test("the public query's percentiles are observed values, with the org spread beside them", () => {
  const sql = flat(publicLatencyQuery(platform).text);
  assert.match(sql, /percentile_disc\(0\.5\) WITHIN GROUP \(ORDER BY total_ms\) AS p50/);
  assert.match(sql, /percentile_disc\(0\.95\) WITHIN GROUP \(ORDER BY total_ms\) AS p95/);
  assert.match(sql, /count\(DISTINCT org_id\)::int AS orgs/);
  assert.match(sql, /count\(\*\)::int AS n/);
  // Time to first token: only over the samples that have one.
  assert.match(sql, /count\(first_token_ms\)::int AS first_token_n/);
  assert.match(sql, /percentile_disc\(0\.5\) WITHIN GROUP \(ORDER BY first_token_ms\) AS first_token_p50/);
  assert.ok(!/percentile_cont|avg\(/.test(sql), "no interpolation and no average in the headline");
});

test("no value is spliced into the public SQL", () => {
  const { text } = publicLatencyQuery(platform);
  assert.ok(!text.includes(OTHER_ORG));
  assert.ok(!text.includes("agent_api"));
});

test("an empty exclusion list is still bound, as an empty array", () => {
  const { values } = publicLatencyQuery({ ...platform, excludedOrgIds: [] });
  assert.deepEqual(values[2], []);
});

test("outcome counts cover every ending under the same platform filter", () => {
  const { text, values } = outcomeCountsQuery(platform);
  const sql = flat(text);
  assert.match(sql, /SELECT outcome, count\(\*\)::int AS n/);
  assert.match(sql, /surface = ANY\(\$2::text\[\]\)/);
  assert.match(sql, /provider <> 'nosana_mock'/);
  assert.match(sql, /NOT \(org_id = ANY\(\$3::uuid\[\]\)\)/);
  assert.match(sql, /GROUP BY outcome/);
  assert.ok(!/outcome = 'ok'/.test(sql), "an error share needs the errors");
  assert.deepEqual(values, [SINCE, ["v1", "agent_api"], [OTHER_ORG], 17]);
});

test("the histogram buckets successful answers by bound edges, an edge closing its own bucket", () => {
  const { text, values } = latencyHistogramQuery(platform);
  const sql = flat(text);
  assert.match(sql, /width_bucket\(total_ms - 1, \$5::int\[\]\) AS bucket/);
  assert.match(sql, /outcome = 'ok'/);
  assert.match(sql, /GROUP BY bucket ORDER BY bucket/);
  assert.deepEqual(values[4], [...HISTOGRAM_EDGES_MS]);
  assert.deepEqual([...HISTOGRAM_EDGES_MS], [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000]);
});

// ============================================
// One organization
// ============================================

const scoped = { orgId: ORG, since: SINCE, until: UNTIL, outcomes: ["ok", "error", "timeout"] as const };

test("the scoped query is bound to the organization and a half-open window", () => {
  const { text, values } = scopedLatencyQuery(scoped);
  const sql = flat(text);
  assert.match(sql, /WHERE org_id = \$1::uuid/);
  assert.match(sql, /created_at >= \$2 AND created_at < \$3/);
  assert.match(sql, /outcome = ANY\(\$4::text\[\]\)/);
  assert.deepEqual(values, [ORG, SINCE, UNTIL, ["ok", "error", "timeout"]]);
  assert.match(sql, /avg\(total_ms\)::float8 AS avg/);
  assert.match(sql, /percentile_disc\(0\.95\) WITHIN GROUP \(ORDER BY total_ms\) AS p95/);
  assert.match(sql, /percentile_disc\(0\.99\) WITHIN GROUP \(ORDER BY total_ms\) AS p99/);
});

test("the caller chooses which endings count; cancelled is never implied", () => {
  const { values } = scopedLatencyQuery({ ...scoped, outcomes: ["ok"] });
  assert.deepEqual(values[3], ["ok"]);
  assert.ok(!flat(scopedLatencyQuery(scoped).text).includes("cancelled"));
});

test("a deployment scope narrows the organization's samples and never replaces the org", () => {
  const { text, values } = scopedLatencyQuery({ ...scoped, deploymentIds: [DEPLOYMENT] });
  const sql = flat(text);
  assert.match(sql, /WHERE org_id = \$1::uuid/);
  assert.match(sql, /AND \(deployment_id = ANY\(\$5::uuid\[\]\)\)$/);
  assert.equal(values[0], ORG);
  assert.deepEqual(values[4], [DEPLOYMENT]);
});

test("an agent scope is the agent's chats OR its own model deployments, inside the org", () => {
  const { text, values } = scopedLatencyQuery({ ...scoped, agentId: AGENT, deploymentIds: [DEPLOYMENT] });
  const sql = flat(text);
  assert.match(sql, /WHERE org_id = \$1::uuid/);
  // The OR is parenthesised: it cannot escape the org predicate.
  assert.match(sql, /AND \(agent_id = \$5::uuid OR deployment_id = ANY\(\$6::uuid\[\]\)\)$/);
  assert.deepEqual(values.slice(4), [AGENT, [DEPLOYMENT]]);
});

test("another organization's resource id cannot widen the scope", () => {
  // The id is only ever a further AND on rows already restricted to ORG.
  const { text, values } = scopedLatencyQuery({ ...scoped, deploymentIds: ["foreign-id"] });
  const sql = flat(text);
  assert.equal(values[0], ORG);
  assert.ok(sql.indexOf("org_id = $1::uuid") < sql.indexOf("deployment_id"));
  assert.ok(!/\bOR\b/.test(sql), "a single scope adds no OR at all");
  assert.ok(!text.includes("foreign-id"));
});

test("an agent with no model deployments still binds an (empty) list", () => {
  const { values } = scopedLatencyQuery({ ...scoped, agentId: AGENT, deploymentIds: [] });
  assert.deepEqual(values.slice(4), [AGENT, []]);
});

// ============================================
// Retention
// ============================================

test("prune deletes one bounded batch of samples older than the cutoff", () => {
  const before = new Date("2026-09-07T09:00:00.000Z");
  const { text, values } = pruneLatencyQuery({ before, batchSize: 5_000 });
  const sql = flat(text);
  assert.match(sql, /^DELETE FROM request_latency_samples WHERE id IN \(/);
  assert.match(sql, /SELECT id FROM request_latency_samples WHERE created_at < \$1 ORDER BY created_at LIMIT \$2/);
  assert.deepEqual(values, [before, 5_000]);
});

test("a breakdown keeps the org, window and outcome filters and only adds the grouping", () => {
  const whole = scopedLatencyQuery({ ...scoped, agentId: AGENT });
  for (const [groupBy, column] of [
    ["deployment", "deployment_id"],
    ["agent", "agent_id"],
    ["surface", "surface"],
  ] as const) {
    const { text, values } = groupedLatencyQuery({ ...scoped, agentId: AGENT }, groupBy);
    assert.deepEqual(values, whole.values, "the same parameters, in the same order");
    assert.ok(flat(text).includes("WHERE org_id = $1::uuid AND created_at >= $2 AND created_at < $3"));
    assert.ok(flat(text).includes(`AND ${column} IS NOT NULL GROUP BY ${column}`));
    assert.ok(flat(text).includes(`${column}::text AS key`));
    assert.ok(flat(text).includes("percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms)"));
  }
});

test("first-token samples are counted with the organizations they came from", () => {
  const { text } = publicLatencyQuery({ since: SINCE, surfaces: ["v1"], excludedOrgIds: [], maxSamplesPerOrg: 17 });
  assert.ok(
    flat(text).includes("(count(DISTINCT org_id) FILTER (WHERE first_token_ms IS NOT NULL))::int AS first_token_orgs"),
  );
});
