/**
 * The GraphQL response parser shared by delivery-metrics.mjs and review-metrics.mjs (and lane-metrics.mjs through
 * delivery-metrics.mjs), so a change to the pullRequests response shape needs one fix.
 */

/** Parses a GraphQL response without ever echoing raw API text in an error (JSON.parse messages quote the input). */
export function parseGraphql(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("GitHub returned a response that is not JSON");
  }
  const page = body?.data?.repository?.pullRequests;
  if (!page || !Array.isArray(page.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean") {
    throw new Error("GitHub returned an unexpected GraphQL response");
  }
  return page;
}
