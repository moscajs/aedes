// Shared MQTT 5.0 constants, kept in one place to avoid drift and to spare
// readers from cross-referencing the spec for raw hex values.

// Session Expiry Interval sentinel: 0xFFFFFFFF means the session never expires.
export const SESSION_NEVER_EXPIRES = 0xFFFFFFFF

// [MQTT-3.8.3-1] Largest valid Subscription Identifier (a Variable Byte
// Integer); 1..this is the legal range. mqtt-packet decodes the VBI but does
// not range-check it, so the SUBSCRIBE handler validates against this.
export const SUBSCRIPTION_IDENTIFIER_MAX = 268435455

// MQTT 5.0 reason codes (the subset aedes emits), ordered by value. [MQTT-2.4]
export const ReasonCodes = {
  SUCCESS: 0x00,
  DISCONNECT_WITH_WILL: 0x04,
  // UNSUBACK: the client had no matching subscription. [MQTT-3.11.3]
  NO_SUBSCRIPTION_EXISTED: 0x11,
  UNSPECIFIED_ERROR: 0x80,
  PROTOCOL_ERROR: 0x82,
  // CONNACK rejection reason codes (mapped from the legacy v3/v4 return codes).
  UNSUPPORTED_PROTOCOL_VERSION: 0x84,
  CLIENT_IDENTIFIER_NOT_VALID: 0x85,
  BAD_USERNAME_OR_PASSWORD: 0x86,
  NOT_AUTHORIZED: 0x87,
  SERVER_UNAVAILABLE: 0x88,
  SERVER_SHUTTING_DOWN: 0x8B,
  BAD_AUTHENTICATION_METHOD: 0x8C,
  SESSION_TAKEN_OVER: 0x8E,
  RECEIVE_MAXIMUM_EXCEEDED: 0x93,
  TOPIC_ALIAS_INVALID: 0x94,
  PACKET_TOO_LARGE: 0x95,
  SHARED_SUBSCRIPTIONS_NOT_SUPPORTED: 0x9E,
  CONNECTION_RATE_EXCEEDED: 0x9F
}
