import type { ReactNode } from "react";
import type { CloudBackend } from "../../shared/wire";
import type { PlaceView } from "../../shared/place-view";
import { placeLabelKey } from "@/lib/place";
import { t } from "@/lib/i18n";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { WorksOnGrid, type WorksOnMode, type WorksOnOption } from "./WorksOnGrid";

export function renderAdvancedWorks({ cloudHome, options, selectPlace, livePin, view, placeActionButton, cloudSelected, cloudBackend, onBackend }: {
  cloudHome?: boolean;
  options: WorksOnOption[];
  selectPlace: (mode: WorksOnMode) => void;
  livePin?: Exclude<WorksOnMode, null>;
  view: PlaceView;
  placeActionButton: (view: PlaceView, className?: string) => ReactNode;
  cloudSelected: boolean;
  cloudBackend: CloudBackend;
  onBackend: (backend: CloudBackend) => void;
}) {
  return <div className="mt-3 rounded-xl bg-card p-4">
    <div className="text-[15px] font-medium text-ink">{t("computer.worksOn")}</div>
    <p className="mt-1 text-[12px] leading-5 text-ink-secondary">{t(cloudHome ? "computer.worksOnHintCloudHome" : "computer.worksOnHint")}</p>
    <WorksOnGrid options={options} onSelect={selectPlace} />
    {livePin && <p className="mt-2 text-[12px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
      {t("place.pinnedNote", { place: t(placeLabelKey(livePin)) })}
    </p>}
    <div className="mt-3 border-t border-hairline/40 pt-3 text-[12px] leading-5 text-ink-secondary" aria-live="polite" data-testid="place-line">
      {view.line}
      {placeActionButton(view, "mt-1 block font-medium text-accent hover:underline")}
    </div>
    {cloudSelected && <CloudBackendPicker compact value={cloudBackend} onChange={onBackend} />}
  </div>;
}
