/** @type {string[]} */
const revalidatedPaths = [];

function revalidatePath(originalPath) {
  revalidatedPaths.push(String(originalPath));
}

function resetCacheStandin() {
  revalidatedPaths.length = 0;
}

module.exports = {
  revalidatePath,
  revalidatedPaths,
  resetCacheStandin,
};
