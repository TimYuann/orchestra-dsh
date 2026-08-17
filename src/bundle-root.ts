/**
 * Bundle-root host entry for orchestra-dsh.
 *
 * No host behavior of its own: the a2a and orchestra plugin rows mount via
 * the ./a2a and ./orchestra subpath exports. This row exists so the client
 * module system can resolve the bundle by its root package name and discover
 * the `dsh.client` declaration (the browser settings panel in ./client).
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = "orchestra-bundle";

/** No-op: client half carries the UI; host rows mount the tools. */
export function apply(): void {}
