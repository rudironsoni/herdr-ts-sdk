import { Effect } from "effect";
import { expectTypeOf } from "vite-plus/test";
import {
  type IHerdrSdk,
  type ClientShellConnectInputEncoded,
  type HerdrEndpointConnectError,
  type HerdrInvalidInput,
  type WorkspaceCreateOptionsEncoded,
} from "./index.ts";

declare const sdk: IHerdrSdk;
declare const connectionInput: ClientShellConnectInputEncoded;
const workspace = sdk.ids.workspace("workspace");
const pane = sdk.ids.pane("pane");
const command = sdk.ids.command("command");

sdk.workspaces.create();
sdk.workspaces.createInDirectory("/repository", { focus: false });
sdk.workspaces.createFromWorkspace(workspace, { label: "review" });
// @ts-expect-error Directory intent is selected by the method, not an option bag.
sdk.workspaces.create({ cwd: "/repository" });
// @ts-expect-error No public directory discriminator is required or accepted.
sdk.workspaces.create({ directory: { _tag: "ServerDefault" } });
// @ts-expect-error Source workspace is positional on createFromWorkspace.
sdk.workspaces.create({ sourceWorkspaceId: workspace });
// @ts-expect-error Parsed workspace IDs and pane IDs are distinct.
sdk.workspaces.createFromWorkspace(pane);
sdk.commands.invokeInPane(command, pane, {
  selection: { anchor: { row: 0, col: 0 }, cursor: { row: 1, col: 1 } },
});
// @ts-expect-error Selection is pane-only, not tab input.
sdk.commands.invokeInTab(command, sdk.ids.tab("tab"), { selection: {} });
sdk.commands.invokeInPane(command, pane, {
  // @ts-expect-error Selection has no second, conflicting pane identifier.
  selection: { paneId: "other", anchor: { row: 0, col: 0 }, cursor: { row: 0, col: 0 } },
});
// @ts-expect-error Copy search requires a content revision.
sdk.panes.copySearch(pane, { query: "error", direction: "forward", cursor: { row: 0, col: 0 } });

const callback = sdk.clientShell.withConnection(connectionInput, () => Effect.succeed(42));
expectTypeOf(callback).toEqualTypeOf<Effect.Effect<number, HerdrEndpointConnectError>>();
const callbackFailure = sdk.clientShell.withConnection(connectionInput, () =>
  Effect.fail("domain-failure" as const),
);
expectTypeOf(callbackFailure).toEqualTypeOf<
  Effect.Effect<never, HerdrEndpointConnectError | "domain-failure">
>();
declare const dependency: Effect.Effect<number, HerdrInvalidInput, "application-dependency">;
const dependent = sdk.clientShell.withConnection(connectionInput, () => dependency);
expectTypeOf(dependent).toEqualTypeOf<
  Effect.Effect<number, HerdrEndpointConnectError | HerdrInvalidInput, "application-dependency">
>();
const graphics = sdk.panes.graphics.withStream(pane, () => Effect.succeed(42));
expectTypeOf<Effect.Services<typeof graphics>>().toEqualTypeOf<never>();
expectTypeOf<keyof WorkspaceCreateOptionsEncoded>().toEqualTypeOf<"focus" | "label" | "env">();
