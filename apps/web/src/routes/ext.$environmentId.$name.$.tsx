import { createFileRoute } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

import { SidebarInset } from "../components/ui/sidebar";
import { ExtensionHostView } from "../extensions/ExtensionHostView";

/**
 * One route for every extension, on every environment.
 *
 * The splat is the extension's own routing space: everything below
 * `/ext/<environmentId>/<name>/` is handed to the mounted bundle as a sub-path
 * and never interpreted here, so an extension can have as many screens as it
 * likes without the host knowing any of them.
 */
export const Route = createFileRoute("/ext/$environmentId/$name/$")({
  component: ExtensionRoute,
});

function ExtensionRoute() {
  const { environmentId, name, _splat } = Route.useParams();
  const splat = _splat ?? "";
  // The same main-area shell every other full page gets (the pull-requests
  // route is the closest sibling): bounded to the viewport and clipped, so the
  // extension's own container below is the one thing that scrolls.
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <ExtensionHostView
        environmentId={environmentId as EnvironmentId}
        name={name}
        subPath={splat.length === 0 ? "/" : `/${splat}`}
      />
    </SidebarInset>
  );
}
