/**
 * next 16.2.9 revalidatePath (dist/server/web/spec-extension/revalidate.js)
 * only writes cache tags onto the request store. Outside a server action it
 * throws before that write. These no-ops stand in for that cache bookkeeping
 * so the tests can observe the working-file write that already happened.
 */
function revalidatePath() {}
function revalidateTag() {}
function updateTag() {}
function refresh() {}
function unstable_cache(fn) {
  return fn;
}
function cacheLife() {}
function cacheTag() {}

module.exports = {
  revalidatePath,
  revalidateTag,
  updateTag,
  refresh,
  unstable_cache,
  cacheLife,
  cacheTag,
};
