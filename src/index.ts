/** orchestra-dsh entry: re-exports both host-plane plugins. */
export { apply as applyA2a, name as a2aName, inject as a2aInject } from "./a2a.js";
export { apply as applyOrchestra, name as orchestraName, inject as orchestraInject } from "./orchestra.js";
export { createSession, deliverMessage, listThreads, readSessionText } from "./a2a.js";
