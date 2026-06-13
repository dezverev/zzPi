import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installRightOverlayTilerHost } from "./lib/right-overlay-tiler.ts";

export default function rightOverlayTilerExtension(pi: ExtensionAPI) {
  installRightOverlayTilerHost(pi);
}
