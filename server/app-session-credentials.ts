export function appSessionCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_DESKTOP_PARENT === "1" && env.OMB_CREDENTIAL_MODE === "session";
}

export function appLoginKeychainForbidden(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_DESKTOP_PARENT === "1" && ["session", "private-file"].includes(env.OMB_CREDENTIAL_MODE ?? "");
}

export function sessionCredentialRefusal(operation: string): Error & { status: number } {
  return Object.assign(new Error(`${operation} is unavailable in session-only credential mode. Existing saved credentials are preserved.`), { status: 409 });
}
