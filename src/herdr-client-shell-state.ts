/**
 * Applies complete-surface-dependent patches without mutating previously published frames.
 * Boot, projection, base revision, and row bounds are independent runtime invariants.
 * @since 0.9.0
 */
import { Result } from "effect";
import type {
  ClientShellGraphicsAssetKey,
  ClientShellSurface,
  ClientShellSurfacePatch,
} from "./herdr-client-shell-models.ts";
import { HerdrEndpointInvalidMessage } from "./herdr-endpoint-errors.ts";

function graphicsIdentity(key: ClientShellGraphicsAssetKey): string {
  const source = key.source;
  const identity =
    source.kind === "paneLayer"
      ? ["layer", source.paneId, source.layerId]
      : source.target.kind === "pane"
        ? ["pane", source.target.paneId, source.imageId]
        : ["popup", source.target.terminalId, source.imageId];
  return JSON.stringify([
    ...identity,
    key.imageWidth,
    key.imageHeight,
    key.format,
    key.dataLength,
    key.dataFingerprint.toString(),
  ]);
}

/** Resolves a complete graphics scene before coalescing surfaces so skipped updates cannot lose image bytes. @category models @since 0.9.0 */
export function retainClientShellGraphics(
  previous: ClientShellSurface | undefined,
  surface: ClientShellSurface,
  maximumBytes: number,
): Result.Result<ClientShellSurface, HerdrEndpointInvalidMessage> {
  const available = new Map(
    previous?.graphics.assets.map((asset) => [graphicsIdentity(asset.key), asset]) ?? [],
  );
  for (const asset of surface.graphics.assets) {
    if (asset.data.length !== asset.key.dataLength)
      return Result.fail(new HerdrEndpointInvalidMessage("schema"));
    available.set(graphicsIdentity(asset.key), asset);
  }
  const required = new Set([
    ...surface.graphics.placements.map((placement) => graphicsIdentity(placement.asset)),
    ...surface.graphics.retainedAssets.map(graphicsIdentity),
  ]);
  const assets: ClientShellSurface["graphics"]["assets"][number][] = [];
  let bytes = 0;
  for (const identity of required) {
    const asset = available.get(identity);
    if (asset === undefined) return Result.fail(new HerdrEndpointInvalidMessage("revision"));
    bytes += asset.data.length;
    if (bytes > maximumBytes) return Result.fail(new HerdrEndpointInvalidMessage("resource_limit"));
    assets.push(asset);
  }
  return Result.succeed({ ...surface, graphics: { ...surface.graphics, assets } });
}

/** Applies an exact-base surface patch or fails; never guesses a missing base frame. @category models @since 0.9.0 */
export function applyClientShellSurfacePatch(
  surface: ClientShellSurface,
  patch: ClientShellSurfacePatch,
): Result.Result<ClientShellSurface, HerdrEndpointInvalidMessage> {
  if (
    surface.bootId !== patch.bootId ||
    surface.projectionRevision !== patch.projectionRevision ||
    surface.surfaceRevision !== patch.baseSurfaceRevision ||
    patch.surfaceRevision <= surface.surfaceRevision
  )
    return Result.fail(new HerdrEndpointInvalidMessage("revision"));
  const cells = [...surface.frame.cells];
  for (const row of patch.rows) {
    if (row.y >= surface.frame.height || row.x + row.cells.length > surface.frame.width)
      return Result.fail(new HerdrEndpointInvalidMessage("revision"));
    for (const [index, cell] of row.cells.entries())
      cells[row.y * surface.frame.width + row.x + index] = cell;
  }
  const panes = new Map(surface.panes.map((pane) => [pane.paneId, pane]));
  for (const pane of patch.panes) {
    if (!panes.has(pane.paneId)) return Result.fail(new HerdrEndpointInvalidMessage("revision"));
    panes.set(pane.paneId, pane);
  }
  return Result.succeed({
    ...surface,
    surfaceRevision: patch.surfaceRevision,
    frame: { ...surface.frame, cells, cursor: patch.cursor },
    panes: [...panes.values()],
  });
}
