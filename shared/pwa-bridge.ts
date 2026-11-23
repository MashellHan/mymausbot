/** Public PWA bridge configuration returned to desktop settings clients (secret is masked). */
export interface PwaBridgePublicConfig {
  enabled: boolean;
  relayUrl: string;
  hostId: string;
  hasBridgeSecret: boolean;
  pwaOrigin: string;
  defaultBotId: string | null;
}

/** Live connection state of the Mac-to-relay outbound WebSocket tunnel. */
export type PwaBridgeState = "off" | "connecting" | "connected" | "error";

/** Runtime status snapshot of the Mac PWA bridge client. */
export interface PwaBridgeStatus {
  state: PwaBridgeState;
  lastConnectedAt: number | null;
  lastError: string | null;
  activeStreams: number;
}

/** Response body for `GET /api/pwa-bridge` and `PUT /api/pwa-bridge`. */
export interface PwaBridgeSettingsResponse {
  config: PwaBridgePublicConfig;
  status: PwaBridgeStatus;
}

/** Response body for `POST /api/pwa-bridge/rotate-secret`, returning the new secret once. */
export interface PwaBridgeRotateSecretResponse extends PwaBridgeSettingsResponse {
  bridgeSecret: string;
  bridgeSecretSha256: string;
}

/** Response body for `POST /api/pwa-bridge/invite`. */
export interface PwaBridgeInviteResponse {
  id: string;
  inviteUrl: string;
  expiresAt: number;
  relayUrl: string;
  defaultBotId: string | null;
}

/** JSON payload encoded as base64url inside the `#pair=` URL fragment for mobile PWA pairing. */
export interface PwaPairingPayload {
  relayUrl: string;
  credential: string;
  defaultBotId?: string;
}
