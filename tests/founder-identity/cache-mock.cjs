/** Next's revalidatePath throws outside a request store. Identity writes happen before that call. */
function revalidatePath() {}
function revalidateTag() {}
function updateTag() {}
function refresh() {}

module.exports = { revalidatePath, revalidateTag, updateTag, refresh };
