import { useEffect, useRef, useState } from "react";
import { Check, FolderMinus } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useHeldMenuMotion } from "./MenuMotion";
import { MENU_HEADING, MENU_ITEM, MENU_ITEM_SEPARATOR, MENU_SHEET } from "./menu-recipe";
import { departmentNames } from "./bot-sections";

export function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  current: string | undefined;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const motion = useHeldMenuMotion(anchor);
  const shown = motion.value;
  const heldCurrent = useRef(current);
  if (anchor) heldCurrent.current = current;
  const trimmed = name.trim();

  useEffect(() => { if (anchor) setName(""); }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);

  const sections = departmentNames(state);
  const filteredSections = sections.filter((section) => section.toLowerCase().includes(trimmed.toLowerCase()));
  const exactSection = sections.find((section) => section.toLowerCase() === trimmed.toLowerCase());

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  if (!motion.shown || !shown) return null;
  const sectionCurrent = heldCurrent.current;
  const top = Math.max(8, Math.min(shown.y, window.innerHeight - 350));
  const left = Math.min(shown.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className={cn("fixed z-40 w-[236px] max-h-[calc(100dvh-16px)] overflow-y-auto", MENU_SHEET, motion.className)} {...motion.exitProps}
    >
      <div className={MENU_HEADING}>
        {t("sidebar.section.moveToContext")}
      </div>
      <form
        className="flex items-center gap-1.5 p-0.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(exactSection ?? trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("sidebar.section.searchOrCreate")}
          aria-label={t("sidebar.section.searchOrCreateAria")}
          className="w-full rounded-md bg-ink/[0.05] px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className="ui-button ui-button-md shrink-0"
        >
          {trimmed && !exactSection ? t("sidebar.section.createAndMove") : t("sidebar.section.move")}
        </button>
      </form>
      {sections.length > 0 && (
        <div role="group" aria-label={t("sidebar.section.moveToContext")} className="flex max-h-52 flex-col gap-1 overflow-y-auto overscroll-contain">
          {filteredSections.map((section) => (
            <button
              key={section}
              type="button"
              onClick={() => assign(section)}
              className={cn(
                MENU_ITEM, "justify-between",
                section === sectionCurrent ? "bg-menu-active text-ink" : "text-ink hover:bg-menu-hover",
              )}
            >
              <span className="truncate">{section}</span>
              {section === sectionCurrent && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
          {filteredSections.length === 0 && <p className="px-2 py-2 text-[12px] text-ink-secondary">{t("sidebar.section.noMatch")}</p>}
        </div>
      )}
      {sectionCurrent && (
        <>
          <div role="separator" className={MENU_ITEM_SEPARATOR} />
          <button
            onClick={() => assign("")}
            className={cn(MENU_ITEM, "text-danger hover:bg-menu-hover")}
          >
            <FolderMinus size={16} />
            {t("sidebar.section.removeFromDepartment")}
          </button>
        </>
      )}
    </div>
  );
}
