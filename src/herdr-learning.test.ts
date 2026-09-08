import { Deferred, Effect, Stream } from "effect";
import { expect, test } from "vite-plus/test";
import {
  HerdrAbsolutePath,
  HerdrGraphicsStreamClosed,
  HerdrInvalidResponse,
  HerdrSdk,
  herdrSdkLayerFromOptions,
} from "./index.ts";
import { runHerdrTest } from "./herdr-test-runtime.ts";
import { HerdrRawTestResponse, startHerdrTestServer } from "./herdr-test-server.ts";
import { makeHerdrSuccessResponse } from "./herdr-wire-fixtures.ts";
import type { WorkspaceInfo } from "./generated/wire-success-response.ts";

const workspace = {
  workspace_id: "workspace-learning",
  number: 1,
  label: "Local recipe",
  focused: true,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: "tab-learning",
  agent_status: "idle",
} satisfies WorkspaceInfo;

// Controls: explicit fixture endpoint, fixed workspace response, caller-owned request ID.
// Hypothesis: Domain input becomes snake-case wire input; wire output becomes domain output.
test("sdk learning: request-wire-result", (context) =>
  runHerdrTest(
    context,
    Effect.gen(function* () {
      const server = yield* startHerdrTestServer((request) =>
        Effect.succeed(
          request.method === "workspace.get"
            ? { id: request.id, result: { type: "workspace_info", workspace } }
            : makeHerdrSuccessResponse(request),
        ),
      );
      const result = yield* runLearningSdk(
        server.socketPath,
        Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          return yield* sdk.workspaces.get(sdk.ids.workspace("workspace-learning"), {
            requestId: "learning-request",
          });
        }),
      );
      expect(server.requests.find((request) => request.method === "workspace.get")).toEqual({
        id: "learning-request",
        method: "workspace.get",
        params: { workspace_id: "workspace-learning" },
      });
      expect(result).toMatchObject({
        id: "workspace-learning",
        label: "Local recipe",
        paneCount: 1,
      });
      expect(result).not.toHaveProperty("workspace_id");
    }),
  ));

// Controls: corrupt only the first ping; retry explicitly on the same SDK without a retry policy.
// Hypothesis: Compatibility failure is recoverable; successful compatibility is shared across namespaces.
test("sdk learning: compatibility-recovery", (context) =>
  runHerdrTest(
    context,
    Effect.gen(function* () {
      let pings = 0;
      const server = yield* startHerdrTestServer((request) =>
        Effect.sync(() => {
          if (request.method === "ping" && ++pings === 1)
            return new HerdrRawTestResponse("{broken\n");
          return makeHerdrSuccessResponse(request);
        }),
      );
      yield* runLearningSdk(
        server.socketPath,
        Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          const failure = yield* sdk.workspaces.list().pipe(Effect.flip);
          expect(failure).toBeInstanceOf(HerdrInvalidResponse);
          expect(server.requests.map((request) => request.method)).toEqual(["ping"]);
          yield* Effect.all([sdk.workspaces.list(), sdk.popups.close()], {
            concurrency: "unbounded",
          });
          yield* sdk.workspaces.list();
        }),
      );
      expect(pings).toBe(2);
      expect(server.requests.filter((request) => request.method === "workspace.list")).toHaveLength(
        2,
      );
      expect(server.requests.filter((request) => request.method === "popup.close")).toHaveLength(1);
    }),
  ));

// Controls: acceptance and one event arrive together; observe close, never sleep to guess readiness.
// Hypothesis: A finite event consumer normalizes its event and releases the scoped subscription socket.
test("sdk learning: scoped-subscription", (context) =>
  runHerdrTest(
    context,
    Effect.gen(function* () {
      const server = yield* startHerdrTestServer((request) =>
        Effect.sync(() => {
          const response = makeHerdrSuccessResponse(request);
          if (request.method !== "events.subscribe") return response;
          return new HerdrRawTestResponse(
            [
              JSON.stringify(response),
              JSON.stringify({
                event: "workspace_created",
                data: { type: "workspace_created", workspace },
              }),
              "",
            ].join("\n"),
          );
        }),
      );
      yield* runLearningSdk(
        server.socketPath,
        Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          const events = yield* sdk.events
            .subscribe([{ type: "workspace.created" }])
            .pipe(Stream.take(1), Stream.runCollect);
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            type: "workspace.created",
            workspace: { id: "workspace-learning" },
          });
          yield* server.waitFor("close", 2);
        }),
      );
      expect(server.openSocketMethods()).not.toContain("events.subscribe");
    }),
  ));

// Controls: two distinct tiny payloads; capture their bytes, then let the writer escape its scope.
// Hypothesis: Concurrent graphics writes serialize complete frames; scope closure invalidates the writer.
test("sdk learning: graphics-writer", (context) =>
  runHerdrTest(
    context,
    Effect.gen(function* () {
      const received = yield* Deferred.make<void>();
      const run = Effect.runForkWith(yield* Effect.context<never>());
      const chunks: Buffer[] = [];
      const server = yield* startHerdrTestServer((request, socket) =>
        Effect.sync(() => {
          if (request.method === "pane.graphics.stream") {
            socket.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              // Payloads have no newline: two header newlines and both payloads complete the observation.
              const bytes = Buffer.concat(chunks);
              const secondHeader = bytes.indexOf(10, bytes.indexOf(10) + 1);
              if (secondHeader >= 0 && bytes.length >= secondHeader + 4) {
                run(Deferred.succeed(received, undefined));
              }
            });
          }
          return makeHerdrSuccessResponse(request);
        }),
      );
      const frame = (byte: number) => ({
        format: "png" as const,
        imageWidth: 1,
        imageHeight: 1,
        data: Uint8Array.of(byte, byte, byte),
      });
      yield* runLearningSdk(
        server.socketPath,
        Effect.gen(function* () {
          const sdk = yield* HerdrSdk;
          const writer = yield* Effect.scoped(
            Effect.gen(function* () {
              const acquired = yield* sdk.panes.graphics.openStream(sdk.ids.pane("pane-learning"));
              yield* Effect.all([acquired.write(frame(1)), acquired.write(frame(2))], {
                concurrency: "unbounded",
              });
              yield* Deferred.await(received);
              return acquired;
            }),
          );
          const closed = yield* writer.write(frame(3)).pipe(Effect.flip);
          expect(closed).toBeInstanceOf(HerdrGraphicsStreamClosed);
          yield* server.waitFor("close", 2);
        }),
      );
      const bytes = Buffer.concat(chunks);
      let offset = 0;
      const payloads: number[][] = [];
      for (let index = 0; index < 2; index++) {
        const newline = bytes.indexOf(10, offset);
        expect(newline).toBeGreaterThan(offset);
        const header: unknown = JSON.parse(bytes.subarray(offset, newline).toString("utf8"));
        expect(header).toMatchObject({
          format: "png",
          data_length: 3,
          image_width: 1,
          image_height: 1,
        });
        payloads.push([...bytes.subarray(newline + 1, newline + 4)]);
        offset = newline + 4;
      }
      expect(payloads).toEqual(
        expect.arrayContaining([
          [1, 1, 1],
          [2, 2, 2],
        ]),
      );
      expect(offset).toBe(bytes.length);
    }),
  ));

// The only SDK composition point supplies a fixture path, never ambient Herdr discovery.
function runLearningSdk<A, E>(socketPath: string, recipe: Effect.Effect<A, E, HerdrSdk>) {
  return recipe.pipe(
    Effect.provide(herdrSdkLayerFromOptions({ socketPath: HerdrAbsolutePath.make(socketPath) })),
    Effect.timeout("3 seconds"),
  );
}
