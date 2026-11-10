// Lets plain Node load src/index.js, which imports "cloudflare:workers". Used by `npm test`.
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
