import { CREDENTIAL_PATCH, credentialSaveError } from "./credential-patch.mjs";

export function createWorkspaceCredentialSaver({ packaged, sessionOnly, encryptionAvailable, dataDir, switching, ready,
  port, headers, fetch: send, sessionState, secureUpdate, t }) {
  let writes = 0;
  return {
    busy: () => writes > 0,
    async save(name, value) {
      const patchFor = CREDENTIAL_PATCH[name];
      if (!patchFor || typeof value !== "string") throw new Error("Unsupported credential");
      if (packaged() && !sessionOnly && !(await encryptionAvailable())) throw new Error("The operating-system credential store is unavailable");
      const secret = value.trim();
      const targetDataDir = sessionOnly ? dataDir() : null;
      if (sessionOnly && (!targetDataDir || switching())) throw new Error("The local environment is changing. Try again when it is ready.");
      const applyToHarness = async () => {
        if (packaged() && (!ready() || (sessionOnly && dataDir() !== targetDataDir))) throw new Error("The embedded bot server is unavailable");
        const suffix = packaged() ? "?secretStorage=external" : "";
        const response = await send(`http://127.0.0.1:${port()}/api/config${suffix}`, {
          method: "PUT", headers: headers(), body: JSON.stringify(patchFor(secret)),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw credentialSaveError(response.status, body, t);
        return body;
      };
      if (!packaged()) return applyToHarness();
      const derive = (credentials) => {
        if (secret) credentials[name] = secret;
        else delete credentials[name];
        return credentials;
      };
      if (sessionOnly) {
        writes++;
        try { return await sessionState(targetDataDir).update(derive, applyToHarness); }
        finally { writes--; }
      }
      return secureUpdate(derive, applyToHarness);
    },
  };
}
