// Single source of truth for the version shown in the admin UI.
// Wrangler bundles JSON imports, so the value tracks package.json on every deploy.
import pkg from "../package.json";

export const APP_VERSION: string = pkg.version;
