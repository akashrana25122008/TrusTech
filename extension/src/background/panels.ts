/* ------------------------------------------------------------------ *
 * PanelsService — side panel (Chrome MV3) & sidebar (Firefox) wiring.
 * ------------------------------------------------------------------ */

import type { BrowserAdapter } from "@/browser";

export class PanelsService {
  constructor(private readonly adapter: BrowserAdapter) {
    adapter.onActionClicked(() => void adapter.openPanel());
  }

  install(): void {
    this.adapter.setOpenPanelOnActionClick();
  }

  /** Forward a worker-side event to every panel via runtime broadcast. */
  broadcast(event: unknown): void {
    void this.adapter.broadcast(event);
  }
}