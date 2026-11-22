module.exports = {
  revalidatePath() {},
  revalidateTag() {},
  unstable_cache(fn) { return fn; },
  unstable_noStore() {},
};
