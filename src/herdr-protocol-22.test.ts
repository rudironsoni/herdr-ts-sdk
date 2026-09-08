import { Effect, Option } from "effect";
import { expect, test } from "vite-plus/test";
import {
  HerdrAbsolutePath,
  HerdrSdk,
  HerdrInvalidInput,
  HerdrServerError,
  herdrSdkLayerFromOptions,
} from "./index.ts";
import { runHerdrTest } from "./herdr-test-runtime.ts";
import { startHerdrTestServer } from "./herdr-test-server.ts";
import { makeHerdrSuccessResponse } from "./herdr-wire-fixtures.ts";

test("every protocol-22 API-socket addition dispatches and decodes a successful result", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(makeHerdrSuccessResponse(request)),
        );
        yield* Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          const pane = sdk.ids.pane("pane");
          const command = sdk.ids.command("command");
          yield* sdk.integrations.list();
          yield* sdk.panes.scroll(pane, { offsetFromBottom: 12 });
          yield* sdk.panes.editScrollback(pane);
          yield* sdk.panes.selection.read(pane, {
            anchor: { row: 1, col: 2 },
            cursor: { row: 3, col: 4 },
          });
          yield* sdk.panes.copyMotion(pane, {
            motion: "nextWordStart",
            cursor: { row: 1, col: 2 },
          });
          yield* sdk.panes.copySearch(pane, {
            query: "find",
            direction: "backward",
            cursor: { row: 1, col: 2 },
            contentRevision: 3,
          });
          yield* sdk.panes.link.activate(pane, { viewportRow: 1, col: 2 });
          yield* sdk.commands.invoke(command);
          yield* sdk.commands.invokeInWorkspace(command, sdk.ids.workspace("workspace"));
          yield* sdk.commands.invokeInTab(command, sdk.ids.tab("tab"), {
            expectedWorkspaceId: "workspace",
          });
          yield* sdk.productAnnouncements.dismiss({ version: "0.9.0", id: "notice" });
          yield* sdk.releaseNotes.dismiss({ version: "0.9.0" });
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({ socketPath: HerdrAbsolutePath.make(server.socketPath) }),
          ),
        );
        expect(
          server.requests
            .filter((request) => request.method !== "ping")
            .map((request) => request.method),
        ).toEqual([
          "integration.list",
          "pane.scroll",
          "pane.edit_scrollback",
          "pane.selection.read",
          "pane.copy_motion",
          "pane.copy_search",
          "pane.link.activate",
          "command.invoke",
          "command.invoke",
          "command.invoke",
          "product_announcement.dismiss",
          "release_notes.dismiss",
        ]);
        expect(
          server.requests.find((request) => request.method === "pane.copy_motion")?.params,
        ).toEqual({ pane_id: "pane", motion: "next_word_start", cursor: { row: 1, col: 2 } });
        expect(
          server.requests
            .filter((request) => request.method === "command.invoke")
            .map((request) => request.params),
        ).toEqual([
          { command_id: "command" },
          { command_id: "command", workspace_id: "workspace" },
          { command_id: "command", tab_id: "tab", workspace_id: "workspace" },
        ]);
      }),
    ),
  ));

test("protocol 22 workspace intents and command targets encode only their selected fields", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(makeHerdrSuccessResponse(request)),
        );
        yield* Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          const workspace = sdk.ids.workspace("workspace-source");
          const pane = sdk.ids.pane("pane-target");
          const command = sdk.ids.command("cmd_test");
          yield* sdk.workspaces.create({ label: "default" });
          yield* sdk.workspaces.createInDirectory("/fixture/repository", { label: "explicit" });
          yield* sdk.workspaces.createFromWorkspace(workspace, {
            label: "source",
            env: { source_workspace_id: "opaque" },
          });
          yield* sdk.commands.invokeInPane(command, pane, {
            expectedWorkspaceId: workspace,
            expectedTabId: "tab-parent",
            selection: {
              anchor: { row: 1, col: 2 },
              cursor: { row: 3, col: 4 },
              contentRevision: 6,
            },
          });
          const obsolete = { label: "obsolete", cwd: "/ignored" };
          expect(yield* sdk.workspaces.create(obsolete).pipe(Effect.flip)).toBeInstanceOf(
            HerdrInvalidInput,
          );
          expect(
            yield* sdk.workspaces.createInDirectory("relative").pipe(Effect.flip),
          ).toBeInstanceOf(HerdrInvalidInput);
          const foreignSelection = {
            expectedTabId: "tab",
            selection: { paneId: "other", anchor: { row: 0, col: 0 }, cursor: { row: 0, col: 0 } },
          };
          expect(
            yield* sdk.commands.invokeInPane(command, pane, foreignSelection).pipe(Effect.flip),
          ).toBeInstanceOf(HerdrInvalidInput);
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({ socketPath: HerdrAbsolutePath.make(server.socketPath) }),
          ),
        );
        const creations = server.requests.filter(
          (request) => request.method === "workspace.create",
        );
        expect(creations.map((request) => request.params)).toEqual([
          { label: "default" },
          { cwd: "/fixture/repository", label: "explicit" },
          {
            source_workspace_id: "workspace-source",
            label: "source",
            env: { source_workspace_id: "opaque" },
          },
        ]);
        expect(
          server.requests.find((request) => request.method === "command.invoke")?.params,
        ).toEqual({
          command_id: "cmd_test",
          pane_id: "pane-target",
          workspace_id: "workspace-source",
          tab_id: "tab-parent",
          selection: {
            pane_id: "pane-target",
            anchor: { row: 1, col: 2 },
            cursor: { row: 3, col: 4 },
            content_revision: 6,
          },
        });
      }),
    ),
  ));

test("new capabilities, integration states, bounded matches, and optional link results decode through SDK services", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(
            request.method === "ping"
              ? {
                  id: request.id,
                  result: {
                    type: "pong",
                    version: "0.9.0",
                    protocol: 22,
                    capabilities: {
                      live_handoff: false,
                      endpoint_protocol_generation: 1,
                      surface_interest: true,
                      health_check: true,
                    },
                  },
                }
              : request.method === "integration.list"
                ? {
                    id: request.id,
                    result: {
                      type: "integration_list",
                      integrations: (["not_installed", "current", "outdated"] as const).map(
                        (state) => ({
                          target: "codex",
                          label: "Codex",
                          command: "codex",
                          available: true,
                          state,
                        }),
                      ),
                    },
                  }
                : request.method === "pane.copy_search"
                  ? {
                      id: request.id,
                      result: {
                        type: "pane_copy_search",
                        pane_id: "pane",
                        content_revision: 6,
                        matches: [{ start: { row: 0, col: 0 }, end: { row: 0, col: 2 } }],
                        total: 2000,
                        current: 0,
                        current_global: 100,
                      },
                    }
                  : request.method === "pane.link.activate"
                    ? {
                        id: request.id,
                        result: { type: "pane_link_activated", handled: false },
                      }
                    : makeHerdrSuccessResponse(request),
          ),
        );
        yield* Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          const pong = yield* sdk.server.ping();
          expect(Option.getOrThrow(pong.capabilities)).toMatchObject({
            surfaceInterest: true,
            healthCheck: true,
            detachedServerDaemon: false,
          });
          expect(
            Option.getOrThrow(Option.getOrThrow(pong.capabilities).endpointProtocolGeneration),
          ).toBe(1);
          expect((yield* sdk.integrations.list()).map((integration) => integration.state)).toEqual([
            "notInstalled",
            "current",
            "outdated",
          ]);
          const pane = sdk.ids.pane("pane");
          const searchInput = {
            query: "é".repeat(2048),
            direction: "forward" as const,
            cursor: { row: 0, col: 0 },
            contentRevision: 6,
          };
          const search = yield* sdk.panes.copySearch(pane, searchInput);
          expect(search.matches.length).toBe(1);
          expect(search.total).toBe(2000);
          expect(Option.getOrThrow(search.currentGlobal)).toBe(100);
          const oversized = yield* sdk.panes
            .copySearch(pane, { ...searchInput, query: searchInput.query + "é" })
            .pipe(Effect.flip);
          expect(oversized).toBeInstanceOf(HerdrInvalidInput);
          expect(
            yield* sdk.panes.scroll(pane, { offsetFromBottom: -1 }).pipe(Effect.flip),
          ).toBeInstanceOf(HerdrInvalidInput);
          const link = yield* sdk.panes.link.activate(pane, { viewportRow: 0, col: 0 });
          expect(link.handled).toBe(false);
          expect(Option.isNone(link.url)).toBe(true);
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({ socketPath: HerdrAbsolutePath.make(server.socketPath) }),
          ),
        );
        expect(
          server.requests.filter((request) => request.method === "pane.copy_search"),
        ).toHaveLength(1);
        expect(server.requests.filter((request) => request.method === "pane.scroll")).toHaveLength(
          0,
        );
      }),
    ),
  ));

test.for([
  "stale_content",
  "agent_prompt_stalled",
  "agent_blocked",
  "stale_announcement",
  "stale_release_notes",
])("server %s failures retain their code and are never retried", (code, context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startHerdrTestServer((request) =>
          Effect.succeed(
            request.method === "ping"
              ? makeHerdrSuccessResponse(request)
              : { id: request.id, error: { code, message: "fixture rejection" } },
          ),
        );
        yield* Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          const pane = sdk.ids.pane("pane");
          const operation =
            code === "stale_content"
              ? sdk.panes.selection.read(pane, {
                  anchor: { row: 0, col: 0 },
                  cursor: { row: 1, col: 1 },
                  contentRevision: 8,
                })
              : code === "stale_announcement"
                ? sdk.productAnnouncements.dismiss({ version: "0.9.0", id: "announcement" })
                : code === "stale_release_notes"
                  ? sdk.releaseNotes.dismiss({ version: "0.9.0" })
                  : sdk.agents.prompt(
                      { paneId: pane },
                      { text: "fixture", wait: { until: ["idle"] } },
                    );
          const error = yield* operation.pipe(Effect.flip);
          expect(error).toBeInstanceOf(HerdrServerError);
          expect(error).toMatchObject({ serverCode: code });
        }).pipe(
          Effect.provide(
            herdrSdkLayerFromOptions({ socketPath: HerdrAbsolutePath.make(server.socketPath) }),
          ),
        );
        expect(server.requests.filter((request) => request.method !== "ping")).toHaveLength(1);
      }),
    ),
  ),
);
