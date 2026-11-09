import { ArrowLeft, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { LocalAgentConfigurationDocument, LocalAgentConfigurationResponse, LocalAgentSkillDocumentResponse,
  LocalAgentTeamRulesResponse } from "../../shared/local-dashboard";
import { t } from "@/lib/i18n";
import { api, ApiError } from "@/state/store";

export type AgentConfigurationTarget =
  | { kind: "member"; teamId: string; agentId: string; occupantId: string | null; name: string }
  | { kind: "team"; teamId: string; name: string };

const empty = (status: LocalAgentConfigurationDocument["status"]): LocalAgentConfigurationDocument => ({ status, markdown: null });
const failure = (error: unknown) => empty(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "unavailable" : "error");
const read = <T,>(path: string, signal: AbortSignal, timeoutMs = 10_000) => api<T>(path, { background: true, signal, timeoutMs });
const plainUrl = (url: string) => url;
const markdownComponents: Components = {
  a({ children, href }) { return <span>{children}{href && children !== href && <span className="text-ink-tertiary"> ({href})</span>}</span>; },
  img({ alt, src }) { return <span>{alt}{src && <span className="text-ink-tertiary"> ({src})</span>}</span>; },
};
const statusKey = {
  missing: "computer.agentTeam.config.missing",
  error: "computer.agentTeam.config.error",
  unverified: "computer.agentTeam.config.unverified",
  unavailable: "computer.agentTeam.config.unavailable",
} as const;

function DocumentView({ document, onRetry, member = false }: { document: LocalAgentConfigurationDocument | null; onRetry?: () => void; member?: boolean }) {
  if (!document) return <p role="status" className="text-[13px] text-ink-secondary">{t("computer.agentTeam.config.loading")}</p>;
  if (document.status === "ready" && document.markdown !== null) return <div dir="auto" data-testid="agent-config-markdown"
    className="min-w-0 text-[13px] leading-5 text-ink [overflow-wrap:anywhere] [&_h1]:mb-2 [&_h1]:text-[18px] [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_p+p]:mt-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:ps-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:ps-5 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-inset [&_pre]:p-3 [&_code]:text-[12px] [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
    <Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={plainUrl} components={markdownComponents}>{document.markdown}</Markdown>
  </div>;
  const status = document.status === "ready" ? "error" : document.status;
  return <div role="status" className="rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">
    <p>{t(status === "unverified" && member ? "computer.agentTeam.config.memberUnverified" : statusKey[status])}</p>
    {status === "error" && onRetry && <button type="button" onClick={onRetry}
      className="mt-2 rounded-md px-2 py-1 font-medium text-accent-text hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
      {t("computer.agentTeam.config.retry")}
    </button>}
  </div>;
}

export function AgentConfigurationViewer({ target, onClose, onRulesRead, fallbackFocus }: {
  target: AgentConfigurationTarget; onClose: () => void; onRulesRead?: (result: LocalAgentTeamRulesResponse) => void;
  fallbackFocus: RefObject<HTMLDivElement | null>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const agentTabRef = useRef<HTMLButtonElement>(null);
  const skillsTabRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const rulesReadRef = useRef(onRulesRead);
  rulesReadRef.current = onRulesRead;
  const close = useCallback(() => closeRef.current(), []);
  const id = useId();
  const [tab, setTab] = useState<"agent" | "skills">("agent");
  const [configuration, setConfiguration] = useState<LocalAgentConfigurationResponse | null>(null);
  const [configurationProblem, setConfigurationProblem] = useState<LocalAgentConfigurationDocument | null>(null);
  const [configurationAttempt, setConfigurationAttempt] = useState(0);
  const [skillId, setSkillId] = useState<string | null>(null);
  const [skillState, setSkillState] = useState<{ id: string; document: LocalAgentConfigurationDocument } | null>(null);
  const [skillAttempt, setSkillAttempt] = useState(0);
  const [rulesDocument, setRulesDocument] = useState<LocalAgentConfigurationDocument | null>(null);
  const [rulesAttempt, setRulesAttempt] = useState(0);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const tabbables = [...(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]") ?? [])]
        .filter((element) => element.tabIndex >= 0 && !element.hidden && !element.closest("[hidden], [inert]"));
      if (!tabbables.length) { event.preventDefault(); dialog?.focus(); return; }
      const focused = document.activeElement;
      if (!dialog?.contains(focused) || focused === dialog ||
          (event.shiftKey && focused === tabbables[0]) || (!event.shiftKey && focused === tabbables.at(-1))) {
        event.preventDefault();
        (event.shiftKey ? tabbables.at(-1) : tabbables[0])?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus(); else fallbackFocus.current?.focus();
    };
  }, [close, fallbackFocus]);

  useEffect(() => {
    if (target.kind !== "member") return;
    const controller = new AbortController();
    let active = true;
    setConfiguration(null);
    setConfigurationProblem(null);
    setSkillId(null);
    if (!target.occupantId) { setConfigurationProblem(empty("unverified")); return () => controller.abort(); }
    void read<LocalAgentConfigurationResponse>(`/api/local-dashboard/agents/${encodeURIComponent(target.agentId)}/configuration`, controller.signal, 12_000)
      .then((result) => {
        if (!active) return;
        if (result.agentId !== target.agentId || result.teamId !== target.teamId || result.occupantId !== target.occupantId) setConfigurationProblem(empty("unavailable"));
        else setConfiguration(result);
      }).catch((error) => { if (active && !controller.signal.aborted) setConfigurationProblem(failure(error)); });
    return () => { active = false; controller.abort(); };
  }, [target, configurationAttempt]);

  const selectedSkill = target.kind === "member" ? configuration?.skills.find((skill) => skill.id === skillId) : undefined;
  useEffect(() => {
    if (target.kind !== "member" || tab !== "skills" || !selectedSkill || !configuration?.occupantId) return;
    const controller = new AbortController();
    let active = true;
    setSkillState(null);
    void read<LocalAgentSkillDocumentResponse>(`/api/local-dashboard/agents/${encodeURIComponent(target.agentId)}/skills/${encodeURIComponent(selectedSkill.id)}`, controller.signal)
      .then((result) => {
        if (!active) return;
        const same = result.agentId === target.agentId && result.teamId === target.teamId
          && result.occupantId === configuration.occupantId && result.occupantId === target.occupantId && result.skillId === selectedSkill.id;
        setSkillState({ id: selectedSkill.id, document: same ? result : empty("unavailable") });
      }).catch((error) => {
        if (active && !controller.signal.aborted) setSkillState({ id: selectedSkill.id, document: failure(error) });
      });
    return () => { active = false; controller.abort(); };
  }, [target, tab, selectedSkill, configuration?.occupantId, skillAttempt]);

  useEffect(() => {
    if (target.kind !== "team") return;
    const controller = new AbortController();
    let active = true;
    setRulesDocument(null);
    void read<LocalAgentTeamRulesResponse>(`/api/local-dashboard/teams/${encodeURIComponent(target.teamId)}/rules`, controller.signal)
      .then((result) => {
        if (!active) return;
        if (result.teamId !== target.teamId) { setRulesDocument(empty("unavailable")); return; }
        setRulesDocument(result);
        rulesReadRef.current?.(result);
      }).catch((error) => { if (active && !controller.signal.aborted) setRulesDocument(failure(error)); });
    return () => { active = false; controller.abort(); };
  }, [target, rulesAttempt]);

  const selectTab = (next: "agent" | "skills") => { setTab(next); setSkillId(null); setSkillState(null); };
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "agent" : event.key === "End" ? "skills" : tab === "agent" ? "skills" : "agent";
    selectTab(next);
    (next === "agent" ? agentTabRef : skillsTabRef).current?.focus();
  };
  const member = target.kind === "member";
  const shownDocument = member ? configuration?.agent ?? configurationProblem : rulesDocument;
  const retry = member ? () => setConfigurationAttempt((attempt) => attempt + 1) : () => setRulesAttempt((attempt) => attempt + 1);

  return createPortal(<div className="fixed inset-0 z-50 flex justify-end bg-black/55" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <aside ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} data-testid="agent-config-viewer"
      className="animate-panel-in motion-reduce:animate-none flex h-dvh w-[min(34rem,100vw)] max-w-full min-w-0 flex-col overflow-hidden border-l border-hairline/50 bg-panel pb-[env(safe-area-inset-bottom)] shadow-2xl shadow-black/30 outline-none">
      <header className="flex min-w-0 items-center gap-3 border-b border-hairline/40 px-4 py-4">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="truncate text-[17px] font-semibold text-ink">{t(member ? "computer.agentTeam.config.title" : "computer.agentTeam.config.teamRules")}</h2>
          <p dir="auto" className="truncate text-[12px] text-ink-secondary" title={target.name}>{target.name}</p>
        </div>
        <button type="button" onClick={close} aria-label={t("common.close")}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      {member && <div role="tablist" aria-label={t("computer.agentTeam.config.title")} onKeyDown={onTabKeyDown}
        className="flex gap-1 border-b border-hairline/40 px-4 pt-2">
        {(["agent", "skills"] as const).map((next) => <button key={next} ref={next === "agent" ? agentTabRef : skillsTabRef}
          type="button" role="tab" id={`${id}-${next}`} aria-controls={`${id}-panel`} aria-selected={tab === next} tabIndex={tab === next ? 0 : -1}
          onClick={() => selectTab(next)} className="rounded-t-lg px-3 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-selected:bg-inset aria-selected:text-ink">
          {t(next === "agent" ? "computer.agentTeam.config.agent" : "computer.agentTeam.config.skills")}
        </button>)}
      </div>}
      <div id={`${id}-panel`} role={member ? "tabpanel" : "region"} aria-labelledby={member ? `${id}-${tab}` : `${id}-title`} tabIndex={0}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]">
        {member && tab === "skills" ? !configuration ? <DocumentView document={configurationProblem} member onRetry={() => setConfigurationAttempt((attempt) => attempt + 1)} />
          : selectedSkill ? <>
            <button type="button" onClick={() => { setSkillId(null); setSkillState(null); }}
              className="mb-3 inline-flex items-center gap-1 rounded-md py-1 text-[12px] font-medium text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
              <ArrowLeft size={14} aria-hidden="true" />{t("computer.agentTeam.config.backToSkills")}
            </button>
            <h3 className="mb-1 text-[15px] font-semibold text-ink [overflow-wrap:anywhere]">{selectedSkill.name}</h3>
            <p className="mb-3 text-[11px] text-ink-secondary">{t("computer.agentTeam.config.loadedUnknown")}</p>
            <DocumentView document={skillState?.id === selectedSkill.id ? skillState.document : null}
              onRetry={() => setSkillAttempt((attempt) => attempt + 1)} />
          </> : <>
            {configuration.skillReferences === "unverified" && <p role="status" className="mb-3 text-[12px] text-ink-secondary">{t("computer.agentTeam.config.associationsUnverified")}</p>}
            {configuration.skillDiscovery !== "ready" && <p role="status" className="mb-3 text-[12px] text-ink-secondary">{t(configuration.skillDiscovery === "partial" ? "computer.agentTeam.config.discoveryPartial"
              : configuration.skillDiscovery === "timeout" ? "computer.agentTeam.config.discoveryTimeout"
                : configuration.skillDiscovery === "unavailable" ? "computer.agentTeam.config.discoveryUnavailable" : "computer.agentTeam.config.discoveryError")}</p>}
            {configuration.skills.length ? <ul className="space-y-2">
              {configuration.skills.map((skill) => <li key={skill.id}><button type="button" onClick={() => setSkillId(skill.id)}
                className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-left hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
                <span className="min-w-0 [overflow-wrap:anywhere]"><span className="block text-[13px] font-medium text-ink">{skill.name}</span>
                  <span className="block text-[11px] text-ink-secondary">{t(skill.association === "agent" ? "computer.agentTeam.config.agentAssociation"
                    : skill.association === "team" ? "computer.agentTeam.config.teamAssociation" : "computer.agentTeam.config.codexAssociation")}
                    {skill.codexAvailable && skill.association !== "codex" ? ` · ${t("computer.agentTeam.config.codexAvailable")}` : ""}</span></span>
                <span className="shrink-0 text-right text-[11px] text-ink-secondary">{t("computer.agentTeam.config.loadedUnknown")}</span>
              </button></li>)}
            </ul> : configuration.skillReferences === "verified" && configuration.skillDiscovery === "ready"
              ? <p role="status" className="text-[13px] text-ink-secondary">{t("computer.agentTeam.config.noSkills")}</p> : null}
          </>
          : <>{shownDocument?.status === "ready" && <p className="mb-3 text-[11px] text-ink-secondary">{t(member
            ? "computer.agentTeam.config.agentSource" : "computer.agentTeam.config.teamSource")}</p>}
            <DocumentView document={shownDocument ?? null} member={member} onRetry={retry} /></>}
      </div>
    </aside>
  </div>, document.body);
}
