// Shared MQTT 5.0 constants, kept in one place to avoid drift and to spare
// readers from cross-referencing the spec for raw hex values.

// Session Expiry Interval sentinel: 0xFFFFFFFF means the session never expires.
export const SESSION_NEVER_EXPIRES = 0xFFFFFFFF

// [MQTT-3.8.3-1] Largest valid Subscription Identifier (a Variable Byte
// Integer); 1..this is the legal range. mqtt-packet decodes the VBI but does
// not range-check it, so the SUBSCRIBE handler validates against this.
export const SUBSCRIPTION_IDENTIFIER_MAX = 268435455

// [MQTT-3.1.2.11.3] Default Receive Maximum when a client omits the property.
export const RECEIVE_MAXIMUM_DEFAULT = 65535

// MQTT 5.0 [MQTT-2.4]: reason codes >= 0x80 indicate failure; < 0x80 are success
// (0x00) / normal outcomes. Used to classify SUBACK grants and inbound PUBREC.
export const REASON_CODE_ERROR_THRESHOLD = 0x80

// [MQTT-3.2.2-8] The failure reason codes a CONNACK may legally carry (§3.2.2.2
// Table 3-1). A hook rejection may set any 0x80+ code on its error; one outside
// this set (e.g. 0x8E Session taken over, 0x93 Receive Maximum exceeded) is
// clamped to 0x87 so aedes never emits an illegal CONNACK. Success 0x00 is a valid
// CONNACK code but excluded here — a rejection must be a failure code.
export const CONNACK_FAILURE_REASON_CODES = new Set([
  0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A,
  0x8C, 0x90, 0x95, 0x97, 0x99, 0x9A, 0x9B, 0x9C, 0x9D, 0x9F
])

// MQTT 5.0 reason codes (the subset aedes emits), ordered by value. Values and
// names per the spec reason-code tables (§2.4 / Table 3-1 CONNACK / Table 3-10
// DISCONNECT / Table 2-6 for the AUTH codes below).
export const ReasonCodes = {
  SUCCESS: 0x00,
  DISCONNECT_WITH_WILL: 0x04,
  // UNSUBACK: the client had no matching subscription. [MQTT-3.11.3]
  NO_SUBSCRIPTION_EXISTED: 0x11,
  // AUTH packet reason codes (Table 3-11 / §3.15.2.1): continue an extended auth
  // exchange, or request re-authentication. §4.12
  CONTINUE_AUTHENTICATION: 0x18,
  REAUTHENTICATE: 0x19,
  UNSPECIFIED_ERROR: 0x80,
  PROTOCOL_ERROR: 0x82,
  // A request was well-formed but the broker won't process it (e.g. a client
  // initiating re-authentication, which aedes does not yet support). §2.4
  IMPLEMENTATION_SPECIFIC_ERROR: 0x83,
  // CONNACK rejection reason codes (mapped from the legacy v3/v4 return codes).
  UNSUPPORTED_PROTOCOL_VERSION: 0x84,
  CLIENT_IDENTIFIER_NOT_VALID: 0x85,
  BAD_USERNAME_OR_PASSWORD: 0x86,
  NOT_AUTHORIZED: 0x87,
  SERVER_UNAVAILABLE: 0x88,
  SERVER_SHUTTING_DOWN: 0x8B,
  BAD_AUTHENTICATION_METHOD: 0x8C,
  SESSION_TAKEN_OVER: 0x8E,
  // PUBREL/PUBCOMP: the Packet Identifier in a QoS 2 ack was not known. [MQTT-3.7.2.1]
  PACKET_IDENTIFIER_NOT_FOUND: 0x92,
  RECEIVE_MAXIMUM_EXCEEDED: 0x93,
  TOPIC_ALIAS_INVALID: 0x94,
  PACKET_TOO_LARGE: 0x95,
  // An implementation or administrative limit was exceeded (e.g. the enhanced-auth
  // round cap) — distinct from 0x87 so it isn't read as a credential failure. §2.4
  QUOTA_EXCEEDED: 0x97,
  // Server redirect (CONNACK §3.2.2 / DISCONNECT §3.14.2): try a different server
  // now, or the client's session has been moved permanently. §4.11
  USE_ANOTHER_SERVER: 0x9C,
  SERVER_MOVED: 0x9D,
  SHARED_SUBSCRIPTIONS_NOT_SUPPORTED: 0x9E,
  CONNECTION_RATE_EXCEEDED: 0x9F
}
