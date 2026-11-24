import { useRef } from "react";
import { Image as ImageIcon, Paperclip } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot, Task } from "@/state/store";
import { ApprovalModeSelector } from "./ApprovalModeSelector";
import { ApprovalChip, GoalToggle, TeachTaskButton } from "./ComposerPlusMenu";
import { PlaceChip } from "./PlaceChip";
import { SIMPLE_CONTROL } from "./composer-simple";
import type { ApprovalChoice } from "./thread-approval";
import type { Place } from "@/lib/place";

export function AttachFilesButton({
  onClick,
  compact = false,
  disabled = false,
  pending = false,
  label = compact ? t("composer.attachFiles") : t("composer.attach"),
}: {
  onClick: () => void;
  compact?: boolean;
  disabled?: boolean;
  pending?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      data-composer-attach
      onClick={onClick}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      aria-label={label}
      title={label}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40",
        compact ? SIMPLE_CONTROL : "size-8 text-ink-secondary hover:bg-control hover:text-ink",
      )}
    >
      <Paperclip size={compact ? 15 : 16} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
    </button>
  );
}

export function AttachPhotoButton({
  onClick,
  compact = false,
  disabled = false,
  pending = false,
}: {
  onClick: () => void;
  compact?: boolean;
  disabled?: boolean;
  pending?: boolean;
}) {
  const label = t("composer.attachPhoto");
  return (
    <button
      type="button"
      data-composer-photo
      onClick={onClick}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      aria-label={label}
      title={label}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40",
        compact ? SIMPLE_CONTROL : "size-8 text-ink-secondary hover:bg-control hover:text-ink",
      )}
    >
      <ImageIcon size={compact ? 15 : 16} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
    </button>
  );
}

export function ComposerToolbar({
  compact,
  singleRow,
  advanced,
  disabled,
  attachmentPending,
  supportsImages,
  onPickFiles,
  onTeach,
  goal,
  approvalChoice,
  showApprovalChip,
  place,
}: {
  compact: boolean;
  singleRow: boolean;
  advanced: boolean;
  disabled: boolean;
  attachmentPending: boolean;
  supportsImages: boolean;
  onPickFiles: (files: FileList | null) => void;
  onTeach?: () => void;
  goal?: { on: boolean; onToggle: () => void; solo?: boolean };
  approvalChoice?: ApprovalChoice;
  showApprovalChip: boolean;
  place?: {
    bot: Bot;
    task?: Task;
    live: boolean;
    disabled: boolean;
    onPin: (surface: Place | null) => void;
  };
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  return (
    <div data-composer-toolbar className={cn("flex items-center gap-1", compact || singleRow ? "shrink-0" : "flex-wrap")}>
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onPickFiles(e.target.files);
          // Reset so picking the same file again still fires onChange.
          e.target.value = "";
        }}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        data-image-input
        className="hidden"
        onChange={(e) => {
          onPickFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <AttachFilesButton
        onClick={() => fileInput.current?.click()}
        compact={compact || singleRow}
        disabled={disabled}
        pending={attachmentPending}
      />
      {supportsImages && (
        <AttachPhotoButton
          onClick={() => imageInput.current?.click()}
          compact={compact || singleRow}
          disabled={disabled}
          pending={attachmentPending}
        />
      )}
      {onTeach && <TeachTaskButton onClick={onTeach} compact={compact || singleRow} disabled={disabled} />}
      {goal && <GoalToggle {...goal} compact={compact || singleRow} disabled={disabled} />}
      {!singleRow && advanced && approvalChoice && <ApprovalModeSelector {...approvalChoice} />}
      {!singleRow && !advanced && showApprovalChip && approvalChoice && <ApprovalChip choice={approvalChoice} />}
      {!singleRow && advanced && place && <PlaceChip {...place} />}
    </div>
  );
}
