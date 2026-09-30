/**
 * Simple Pilot Logbook — Frontend entry point.
 *
 * Renders the Preact <App> (js/app.js), which polls /api/status every 3 s and
 * /api/flights every 10 s while signed in. Every /api call carries a bearer
 * token (the "viewer token") kept in localStorage; a 401 brings up the sign-in
 * overlay and pauses polling.
 */

import { render } from "preact";
import { html } from "./html.js";
import { App } from "./app.js";

render(html`<${App} />`, document.getElementById("app"));
