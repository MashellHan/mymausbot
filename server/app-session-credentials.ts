export function appSessionCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_DESKTOP_PARENT === "1" && env.OMB_CREDENTIAL_MODE === "session";
}

export function appLoginKeychainForbidden(env: NodeJS.ProcessEnv = process.env): boolean {
  const restricted = (candidate: NodeJS.ProcessEnv) => candidate.OMB_DESKTOP_PARENT === "1" &&
    ["session", "private-file"].includes(candidate.OMB_CREDENTIAL_MODE ?? "");
  return restricted(process.env) || restricted(env);
}

export function sessionCredentialRefusal(operation: string): Error & { status: number } {
  return Object.assign(new Error(`${operation} is unavailable in session-only credential mode. Existing saved credentials are preserved.`), { status: 409 });
}
