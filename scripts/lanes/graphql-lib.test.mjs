import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGraphql } from "./graphql-lib.mjs";
import { parseGraphql as fromDelivery } from "./delivery-metrics.mjs";
import { parseGraphql as fromReview } from "./review-metrics.mjs";

const page = { nodes: [], pageInfo: { hasNextPage: false } };
const wrap = (pullRequests) => JSON.stringify({ data: { repository: { pullRequests } } });

test("parseGraphql returns the pullRequests page", () => {
  assert.deepEqual(parseGraphql(wrap(page)), page);
});

test("both metrics scripts use the shared parseGraphql", () => {
  assert.equal(fromDelivery, parseGraphql);
  assert.equal(fromReview, parseGraphql);
});

test("edge: malformed JSON throws without echoing the text", () => {
  assert.throws(() => parseGraphql("secret <html>"), (e) => /not JSON/.test(e.message) && !e.message.includes("secret"));
});

test("edge: empty string is not JSON", () => {
  assert.throws(() => parseGraphql(""), /not JSON/);
});

test("edge: missing pageInfo, missing nodes, non-array nodes, non-boolean hasNextPage", () => {
  assert.throws(() => parseGraphql(wrap({ nodes: [] })), /unexpected/);
  assert.throws(() => parseGraphql(wrap({ pageInfo: { hasNextPage: false } })), /unexpected/);
  assert.throws(() => parseGraphql(wrap({ nodes: {}, pageInfo: { hasNextPage: false } })), /unexpected/);
  assert.throws(() => parseGraphql(wrap({ nodes: [], pageInfo: { hasNextPage: "no" } })), /unexpected/);
});

test("edge: null body, errors-only body and missing repository are unexpected", () => {
  assert.throws(() => parseGraphql("null"), /unexpected/);
  assert.throws(() => parseGraphql(JSON.stringify({ errors: [{ message: "secret" }] })), (e) => /unexpected/.test(e.message) && !e.message.includes("secret"));
  assert.throws(() => parseGraphql('{"data":{"repository":null}}'), /unexpected/);
});
