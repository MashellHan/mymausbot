import { mkdirSync } from "node:fs";
import path from "node:path";

export function configureProductIdentity(app) {
  const name = app.getName();
  const userData = app.getPath("userData");
  const sessionData = app.getPath("sessionData");
  const defaultProfile = path.join(app.getPath("appData"), name);
  const legacyProfile = path.join(app.getPath("appData"), "OpenMausBot");
  const renamedDefault = app.isPackaged && name === "mymausbot"
    && !app.commandLine.hasSwitch("user-data-dir") && userData === defaultProfile;
  const profile = renamedDefault ? legacyProfile : userData;
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  if (sessionData === userData) app.setPath("sessionData", profile);
  app.setName("mymausbot");
}
