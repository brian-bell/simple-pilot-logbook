/** htm bound to Preact's h(): write components as html`<div>…</div>` tagged templates. */

import { h } from "preact";
import htm from "htm";

export const html = htm.bind(h);
