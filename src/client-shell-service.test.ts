import { createHash } from "node:crypto";
import { Effect, Fiber, Option, Queue, Result, Stream, type Scope } from "effect";
import { expect, test } from "vite-plus/test";
import {
  HerdrAbsolutePath,
  HerdrSdk,
  HerdrEndpointClosed,
  HerdrEndpointInvalidMessage,
  HerdrEndpointRequestTimeout,
  HerdrEndpointStaleReference,
  HerdrEndpointUnsupportedMethod,
  herdrSdkLayerFromOptions,
} from "./index.ts";
import { runHerdrTest } from "./herdr-test-runtime.ts";
import { startHerdrTestServer } from "./herdr-test-server.ts";
import { makeHerdrSuccessResponse } from "./herdr-wire-fixtures.ts";
import {
  startEndpointTestServer,
  fixtureControl,
  fixturePatch,
  fixtureResponse,
  fixtureFrame,
  fixtureText,
  fixtureSurface,
} from "./herdr-endpoint-test-server.ts";
import {
  decodeEndpointMessage,
  encodeEndpointRequest,
  encodeEndpointText,
} from "./herdr-endpoint-codecs.ts";
// Frozen Herdr v0.9.0 tests/fixtures/endpoint-snapshot-v1.json, checked by upstream protocol/endpoint.rs.
import snapshotFixture from "./fixtures/endpoint-snapshot-v1.json" with { type: "json" };

const geometry = { surface: { columns: 80, rows: 24 }, cellPixels: { width: 8, height: 16 } };
const withSdk = <A, E>(program: Effect.Effect<A, E, HerdrSdk | Scope.Scope>) =>
  Effect.gen(function* () {
    const api = yield* startHerdrTestServer((request) =>
      Effect.succeed(makeHerdrSuccessResponse(request)),
    );
    return yield* program.pipe(
      Effect.provide(
        herdrSdkLayerFromOptions({ socketPath: HerdrAbsolutePath.make(api.socketPath) }),
      ),
    );
  });

test("endpoint request encoding matches the frozen upstream generation-1 SHA-256", () => {
  // v0.9.0 src/protocol/wire.rs::client_shell_endpoint_messages_roundtrip.
  const frame = encodeEndpointRequest(
    "boot-a",
    '{"id":"request-a","method":"session.snapshot","params":{}}',
  );
  expect(createHash("sha256").update(frame.subarray(4)).digest("hex")).toBe(
    "de5693585a01f6b0d5ee07c51b6ddf79ee9f67dbf183255822d31f35210f5ffb",
  );
  const response = fixtureResponse(
    "request-a",
    '{"id":"request-a","result":{"type":"ok"}}',
    true,
    "boot-a",
  );
  const decoded = Result.getOrThrow(decodeEndpointMessage(response.subarray(4)));
  expect(decoded).toMatchObject({
    kind: "response",
    bootId: "boot-a",
    requestId: "request-a",
    finalChunk: true,
  });
});

test("binary endpoint parsing rejects trailing, truncated, oversized integer and invalid UTF-8 fields", () => {
  for (const payload of [
    new Uint8Array([20]),
    new Uint8Array([20, 0, 0, 9]),
    new Uint8Array([20, 1, 255, 0]),
    new Uint8Array([253, 255, 255, 255, 255, 255, 255, 255, 255]),
  ]) {
    const parsed = decodeEndpointMessage(payload);
    expect(Result.isFailure(parsed)).toBe(true);
  }
});

test("callback-owned endpoint decodes frozen projections, activates surfaces, applies patches, and closes escaped handles", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer({ fragmented: true });
        const escaped = yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            return yield* sdk.clientShell.withConnection(
              { ...geometry, socketPath: endpoint.socketPath, timeoutMs: 2000 },
              (shell) =>
                Effect.gen(function* () {
                  const projection = yield* shell.snapshot();
                  expect(projection.bootId).toBe("boot-v1");
                  expect(projection.workspaces[0]?.agentStatus).toBe("unknown");
                  expect(projection.tabs[0]?.agentStatus).toBe("working");
                  expect(projection.commands[0]?.action).toBe("shell");
                  const acknowledgement = yield* shell.surface.set({ active: true });
                  expect(acknowledgement.projectionRevision).toBe(7);
                  const surface = yield* shell.surface.awaitReady();
                  expect(surface.frame.cells[0]?.symbol).toBe("x");
                  yield* endpoint.send(fixturePatch());
                  const patched = yield* shell.surface.states.pipe(
                    Stream.filter(
                      (state) => state.status === "active" && state.surface.surfaceRevision === 2,
                    ),
                    Stream.runHead,
                  );
                  expect(Option.isSome(patched)).toBe(true);
                  if (Option.isSome(patched) && patched.value.status === "active")
                    expect(patched.value.surface.frame.cells[0]?.symbol).toBe("y");
                  const command = projection.commands[0];
                  if (command === undefined)
                    return yield* Effect.die(new Error("Fixture command missing"));
                  yield* shell.commands.invokeInPane(command, sdk.ids.pane("w1:p1"));
                  const forged = { ...command };
                  expect(yield* shell.commands.invoke(forged).pipe(Effect.flip)).toBeInstanceOf(
                    HerdrEndpointStaleReference,
                  );
                  yield* shell.input.paste(sdk.ids.pane("w1:p1"), { text: "one\ntwo" });
                  const input = yield* Queue.take(endpoint.inputs);
                  expect([...input]).toEqual([
                    ...encodeEndpointText("pane", "w1:p1", "one\ntwo", "paste").subarray(4),
                  ]);
                  yield* shell.surface.set({ active: false });
                  expect(yield* shell.surface.state()).toEqual({ status: "inactive" });
                  return shell;
                }),
            );
          }),
        );
        yield* Queue.take(endpoint.closed);
        expect(yield* escaped.snapshot().pipe(Effect.flip)).toBeInstanceOf(HerdrEndpointClosed);
        expect(yield* escaped.connectionState()).toBe("closed");
      }),
    ),
  ));

test("endpoint callback failure and interruption both close the socket", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer();
        yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            const failed = yield* sdk.clientShell
              .withConnection({ ...geometry, socketPath: endpoint.socketPath }, () =>
                Effect.fail("callback-failure"),
              )
              .pipe(Effect.flip);
            expect(failed).toBe("callback-failure");
            yield* Queue.take(endpoint.closed);
            const entered = yield* Queue.make<void>();
            const fiber = yield* sdk.clientShell
              .withConnection({ ...geometry, socketPath: endpoint.socketPath }, () =>
                Effect.gen(function* () {
                  yield* Queue.offer(entered, undefined);
                  return yield* Effect.never;
                }),
              )
              .pipe(Effect.forkScoped);
            yield* Queue.take(entered);
            yield* Fiber.interrupt(fiber);
            yield* Queue.take(endpoint.closed);
          }),
        );
      }),
    ),
  ));

test("a read-only projection stream owns and closes its inactive endpoint", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer();
        const projections = yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            return yield* sdk.clientShell
              .projections({ ...geometry, socketPath: endpoint.socketPath })
              .pipe(Stream.take(1), Stream.runCollect);
          }),
        );
        expect(projections.length).toBe(1);
        yield* Queue.take(endpoint.closed);
      }),
    ),
  ));

test("endpoint response chunks correlate independently and server rejections do not disconnect", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer({
          response: (request) => {
            const json = JSON.stringify({
              id: request.id,
              error: { code: "stale_release_notes", message: "fixture stale notes" },
            });
            const middle = Math.floor(json.length / 2);
            return Effect.succeed([
              fixtureResponse(request.id, json.slice(0, middle), false),
              fixtureResponse(request.id, json.slice(middle)),
            ]);
          },
        });
        yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            yield* sdk.clientShell.withConnection(
              { ...geometry, socketPath: endpoint.socketPath },
              (shell) =>
                Effect.gen(function* () {
                  const errors = yield* Effect.all(
                    [
                      shell.releaseNotes.dismiss({ version: "a" }).pipe(Effect.flip),
                      shell.releaseNotes.dismiss({ version: "b" }).pipe(Effect.flip),
                    ],
                    { concurrency: 2 },
                  );
                  for (const error of errors)
                    expect(error).toMatchObject({
                      _tag: "HerdrServerError",
                      serverCode: "stale_release_notes",
                    });
                  expect(yield* shell.connectionState()).toBe("ready");
                }),
            );
          }),
        );
      }),
    ),
  ));

test("missing endpoint methods fail locally without closing the connection", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer({ advertisedMethods: [] });
        yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            yield* sdk.clientShell.withConnection(
              { ...geometry, socketPath: endpoint.socketPath },
              (shell) =>
                Effect.gen(function* () {
                  expect(
                    yield* shell.releaseNotes.dismiss({ version: "x" }).pipe(Effect.flip),
                  ).toBeInstanceOf(HerdrEndpointUnsupportedMethod);
                  expect(yield* shell.connectionState()).toBe("ready");
                }),
            );
          }),
        );
      }),
    ),
  ));

test("invalid patch bases fail the connection rather than presenting corrupted content", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer();
        yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            const error = yield* sdk.clientShell
              .withConnection({ ...geometry, socketPath: endpoint.socketPath }, (shell) =>
                Effect.gen(function* () {
                  yield* shell.surface.set({ active: true });
                  yield* shell.surface.awaitReady();
                  yield* endpoint.send(fixturePatch(99));
                  return yield* shell.projections.pipe(Stream.runDrain);
                }),
              )
              .pipe(Effect.flip);
            expect(error).toBeInstanceOf(HerdrEndpointInvalidMessage);
          }),
        );
        yield* Queue.take(endpoint.closed);
      }),
    ),
  ));

test("silent endpoint health failures terminate a live stream with a typed deadline", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer({ health: false });
        const failure = yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            return yield* sdk.clientShell
              .projections({
                ...geometry,
                socketPath: endpoint.socketPath,
                healthIntervalMs: 1,
                timeoutMs: 250,
              })
              .pipe(Stream.runDrain, Effect.flip);
          }),
        );
        expect(failure).toBeInstanceOf(HerdrEndpointRequestTimeout);
        yield* Queue.take(endpoint.closed);
      }),
    ),
  ));

test("malformed initial snapshot closes acquisition before returning a handle", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer({
          snapshot: { ...snapshotFixture, boot_id: "" },
        });
        const failure = yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            return yield* sdk.clientShell
              .withConnection({ ...geometry, socketPath: endpoint.socketPath }, () => Effect.void)
              .pipe(Effect.flip);
          }),
        );
        expect(failure).toBeInstanceOf(HerdrEndpointInvalidMessage);
        yield* Queue.take(endpoint.closed);
      }),
    ),
  ));

test("surface acknowledgements do not present frames below their revision floor", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer({
          response: (request) =>
            Effect.succeed([
              fixtureResponse(
                request.id,
                JSON.stringify({
                  id: request.id,
                  result: {
                    type: "client_shell_surface_set",
                    active: true,
                    projection_revision: 8,
                  },
                }),
              ),
              fixtureSurface(1, 7),
              fixtureControl(
                "shell.snapshot.v1",
                JSON.stringify({ ...snapshotFixture, revision: 8 }),
              ),
            ]),
        });
        yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            yield* sdk.clientShell.withConnection(
              { ...geometry, socketPath: endpoint.socketPath },
              (shell) =>
                Effect.gen(function* () {
                  yield* shell.surface.set({ active: true });
                  yield* shell.projections.pipe(
                    Stream.filter((projection) => projection.revision === 8),
                    Stream.runHead,
                  );
                  expect(yield* shell.surface.state()).toMatchObject({
                    status: "awaitingSurface",
                    projectionFloor: 8,
                  });
                  yield* endpoint.send(fixtureSurface(2, 8));
                  expect((yield* shell.surface.awaitReady()).projectionRevision).toBe(8);
                }),
            );
          }),
        );
      }),
    ),
  ));

test("rejected surface interest restores confirmed state without disconnecting", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer({ advertisedMethods: [] });
        yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            yield* sdk.clientShell.withConnection(
              { ...geometry, socketPath: endpoint.socketPath },
              (shell) =>
                Effect.gen(function* () {
                  expect(
                    yield* shell.surface.set({ active: true }).pipe(Effect.flip),
                  ).toBeInstanceOf(HerdrEndpointUnsupportedMethod);
                  expect(yield* shell.surface.state()).toEqual({ status: "inactive" });
                }),
            );
          }),
        );
      }),
    ),
  ));

test.for(["correlation", "emptyChunk", "timeout"] as const)(
  "endpoint %s failures close pending requests and the owning callback",
  (mode, context) =>
    runHerdrTest(
      context,
      Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* startEndpointTestServer({
            response: (request) =>
              Effect.succeed(
                mode === "timeout"
                  ? []
                  : [
                      mode === "emptyChunk"
                        ? fixtureResponse(request.id, "", false)
                        : fixtureResponse("wrong-request", "{}"),
                    ],
              ),
          });
          const failure = yield* withSdk(
            Effect.gen(function* () {
              const sdk = yield* HerdrSdk;
              return yield* sdk.clientShell
                .withConnection(
                  { ...geometry, socketPath: endpoint.socketPath, timeoutMs: 250 },
                  (shell) => shell.releaseNotes.dismiss({ version: "0.9.0" }),
                )
                .pipe(Effect.flip);
            }),
          );
          expect(failure).toBeInstanceOf(
            mode === "timeout" ? HerdrEndpointRequestTimeout : HerdrEndpointInvalidMessage,
          );
          yield* Queue.take(endpoint.closed);
        }),
      ),
    ),
);

test("health failure ends callback-owned sessions even when the callback is not reading", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer({ health: false });
        const failure = yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            return yield* sdk.clientShell
              .withConnection(
                {
                  ...geometry,
                  socketPath: endpoint.socketPath,
                  healthIntervalMs: 1,
                  timeoutMs: 250,
                },
                () => Effect.never,
              )
              .pipe(Effect.flip);
          }),
        );
        expect(failure).toBeInstanceOf(HerdrEndpointRequestTimeout);
        yield* Queue.take(endpoint.closed);
      }),
    ),
  ));

test("unknown optional named controls are ignored but malformed mandatory snapshot controls fail", (context) =>
  runHerdrTest(
    context,
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* startEndpointTestServer();
        yield* withSdk(
          Effect.gen(function* () {
            const sdk = yield* HerdrSdk;
            const failure = yield* sdk.clientShell
              .withConnection({ ...geometry, socketPath: endpoint.socketPath }, (shell) =>
                Effect.gen(function* () {
                  yield* endpoint.send(fixtureControl("future.optional", "not JSON"));
                  yield* endpoint.send(
                    fixtureFrame([
                      Buffer.from([20]),
                      fixtureText("shell.snapshot.v2"),
                      fixtureText("{}"),
                    ]),
                  );
                  return yield* shell.projections.pipe(Stream.runDrain);
                }),
              )
              .pipe(Effect.flip);
            expect(failure).toBeInstanceOf(HerdrEndpointInvalidMessage);
          }),
        );
      }),
    ),
  ));
