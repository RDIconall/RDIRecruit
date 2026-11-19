import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Anthropic = require("./fake-anthropic.cjs");

export default Anthropic;
export const resetAnthropic = Anthropic.resetAnthropic;
export const markBatchesEnded = Anthropic.markBatchesEnded;
export const graderPrompts = Anthropic.graderPrompts;
export const batchCount = Anthropic.batchCount;
