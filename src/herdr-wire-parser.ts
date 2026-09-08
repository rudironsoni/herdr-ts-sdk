/**
 * Decodes generated Herdr wire envelopes into normalized protocol values.
 *
 * Response and event parsers keep generated snake-case contracts at the transport boundary and report malformed JSON as typed SDK failures.
 *
 * @since 0.8.2
 */
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import herdrApiSchema from "../schema/herdr-api.schema.json" with { type: "json" };
import type { ErrorResponse } from "./generated/wire-error-response.ts";
import type { EventEnvelope } from "./generated/wire-event.ts";
import type { SubscriptionEventEnvelope } from "./generated/wire-subscription-event.ts";
import type { SuccessResponse, ResponseResult } from "./generated/wire-success-response.ts";
import {
  wireResultTypesByMethod,
  type WireMethod,
  type WireMethodMap,
} from "./generated/wire-method-map.ts";

/** Narrows a schema-validated result using the exhaustively generated method contract. @category decoding @since 0.9.0 */
export function isExpectedWireResult<Method extends WireMethod>(
  method: Method,
  result: ResponseResult,
): result is WireMethodMap[Method]["result"] {
  const acceptedTypes: readonly string[] = wireResultTypesByMethod[method];
  return acceptedTypes.includes(result.type);
}

const SCHEMA_ID = "https://herdr.dev/herdr-api.schema.json";
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
ajv.addSchema({ ...herdrApiSchema, $id: SCHEMA_ID });
const parseSuccessResponse = ajv.compile<SuccessResponse>({
  $ref: `${SCHEMA_ID}#/schemas/success_response`,
});
const parseErrorResponse = ajv.compile<ErrorResponse>({
  $ref: `${SCHEMA_ID}#/schemas/error_response`,
});
const parseLifecycleEvent = ajv.compile<EventEnvelope>({
  $ref: `${SCHEMA_ID}#/schemas/event`,
});
const parseSubscriptionEvent = ajv.compile<SubscriptionEventEnvelope>({
  $ref: `${SCHEMA_ID}#/schemas/subscription_event`,
});

/**
 * Parses an untrusted wire response into the generated success or error contract.
 *
 * @category decoding
 * @since 0.8.2
 */
export function parseHerdrWireResponse(
  value: unknown,
  requestId: string,
): SuccessResponse | ErrorResponse {
  if (parseSuccessResponse(value) || parseErrorResponse(value)) return value;
  throw invalidWireValue("response", requestId, [
    ...(parseSuccessResponse.errors ?? []),
    ...(parseErrorResponse.errors ?? []),
  ]);
}

/**
 * Parses an untrusted event line into one generated Herdr envelope family.
 *
 * @category decoding
 * @since 0.8.2
 */
export function parseHerdrWireEvent(
  value: unknown,
  requestId: string,
): EventEnvelope | SubscriptionEventEnvelope {
  if (parseLifecycleEvent(value) || parseSubscriptionEvent(value)) return value;
  throw invalidWireValue("event", requestId, [
    ...(parseLifecycleEvent.errors ?? []),
    ...(parseSubscriptionEvent.errors ?? []),
  ]);
}

function invalidWireValue(
  kind: "response" | "event",
  requestId: string,
  errors: readonly ErrorObject[],
): Error {
  const detail = ajv.errorsText(errors.slice(0, 5), { separator: "; " });
  return new Error(`Herdr wire ${kind} failed schema parsing for request ${requestId}: ${detail}`);
}
