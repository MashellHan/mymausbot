// The phone composer's round + (Composer.tsx): secondary phone overflow items (where the bot works, approval level, call mode).
import type { ComponentProps } from "react";

import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { usePlaceMenuItem } from "./PlaceChip";

type PhonePlusProps = Pick<ComponentProps<typeof ComposerPlusMenu>, "approval" | "callBotId">;

function PhonePlusWithPlace({ place, ...rest }: PhonePlusProps & { place: Parameters<typeof usePlaceMenuItem>[0] }) {
  const item = usePlaceMenuItem(place);
  return <ComposerPlusMenu {...rest} extraItems={[item]} circle />;
}

/** The phone composer's round +: where the bot works, approval level and call mode. Returns null when empty. */
export function PhonePlus({ place, ...rest }: PhonePlusProps & { place?: Parameters<typeof usePlaceMenuItem>[0] }) {
  return place ? <PhonePlusWithPlace place={place} {...rest} /> : <ComposerPlusMenu {...rest} circle />;
}
