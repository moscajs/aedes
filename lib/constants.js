// Shared MQTT 5.0 constants, kept in one place to avoid drift and to spare
// readers from cross-referencing the spec for raw hex values.

// Session Expiry Interval sentinel: 0xFFFFFFFF means the session never expires.
export const SESSION_NEVER_EXPIRES = 0xFFFFFFFF

// MQTT 5.0 reason codes (the subset aedes emits). [MQTT-2.4]
export const ReasonCodes = {
  SUCCESS: 0x00,
  DISCONNECT_WITH_WILL: 0x04,
  UNSPECIFIED_ERROR: 0x80,
  PROTOCOL_ERROR: 0x82,
  NOT_AUTHORIZED: 0x87,
  SERVER_SHUTTING_DOWN: 0x8B,
  SESSION_TAKEN_OVER: 0x8E,
  RECEIVE_MAXIMUM_EXCEEDED: 0x93,
  TOPIC_ALIAS_INVALID: 0x94,
  PACKET_TOO_LARGE: 0x95,
  CONNECTION_RATE_EXCEEDED: 0x9F
}
