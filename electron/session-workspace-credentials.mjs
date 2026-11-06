import { createSecureCredentialState } from "./secure-credential-state.mjs";

export function createSessionWorkspaceCredentials() {
  const states = new Map();
  const state = (dataDir) => {
    let current = states.get(dataDir);
    if (!current) {
      current = createSecureCredentialState({}, async () => {});
      states.set(dataDir, current);
    }
    return current;
  };
  return {
    state,
    forServer: (dataDir, appCredentials) => ({ ...appCredentials, ...state(dataDir).read() }),
  };
}
