// Who answers a bot's question. At Full access a question asked with an ask tool in work handed on that the
// person started is not put to them: the bot takes its default, or hands a real choice to its requester.
// Otherwise a question waits for the person, and an answer counts wherever it is given, also when their Chief or another
// bot passes it on to the bot that asks, naming the question it answers. What the bot that handed work on sends to the
// thread that work runs in goes into that work: it answers the question the work waits on, or reaches its running turn.
// A Chief may also answer, for the person, a question a teammate it manages puts to them in a thread the Chief did not open.
import { levelWithin, type ApprovalMode } from "../../shared/approval-mode.ts";
import { createProgressiveIntakeMeta } from "../../shared/progressive-intake.ts";
import type { HandoffView } from "../coordinator.ts";
import { peerDeliveryReceipt, type PeerDeliveryReceipt } from "../peer-delivery.ts";
import { escapeNotes } from "../peer-provenance.ts";
import { buildDelegatedForwardPrompt } from "../progressive-intake.ts";
import { AUTHORITY } from "../provenance-label.ts";
import { composeAddition } from "../runtime/envelope.ts";
import { personOnly, withDefault } from "../runtime/questions.ts";
import type { Answerer } from "../runtime/types.ts";
import { conversationLanguage, serverLine } from "../server-lines.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { answerableInWords } from "./ask-cards.ts";
import { sentRow } from "./handoff-sent.ts";

export interface QuestionRoutingDeps {
  store: Pick<Store, "bot" | "tasks" | "messagesFor" | "patchMessage" | "appendMessage" | "taskByThread">;
  active(): HandoffView[];
  node(id: string): HandoffView | undefined;
  parkedFor(botId: string): HandoffView[];
  answerNode(id: string, text: string, by: Answerer): boolean;
  /** The bot's turn in `threadId` waits on this card's live request. */
  live(threadId: string, requestId: string): boolean;
  /** Some question in `threadId` is live: `live` is false for every request of a thread that has none. */
  hasLive(threadId: string): boolean;
  /** The bot's work in `threadId` was started by an outside event or runs with no person behind it. */
  unattended(botId: string, threadId: string): boolean;
  /** Answers the live question request a turn waits on; true when the turn took the answer. */
  answerLive(threadId: string, requestId: string, text: string): Promise<boolean>;
  /** The open sign-in cards this work waits on were answered elsewhere: they settle, and the place goes back to its bot. */
  settleSignIns(node: HandoffView): void;
  /** The work runs in one person's private chat and its requester's chat is not that one: its questions stay theirs. */
  keptPrivate(node: HandoffView, requester: HandoffView): boolean;
  /** Hands `text` to the turn running in `threadId`, read at its next step as a person's line sent mid-turn is; false when
   * its engine cannot take it now. */
  steer(threadId: string, text: string): Promise<boolean>;
  /** Work the sender's conversation carries may reach this thread: confined work reaches only what is confined already. */
  mayReach(fromThreadId: string, toThreadId: string): boolean;
  /** Words from a turn that could not use the lent computer are about to reach work in this thread: it stops keeping it. */
  handedInUnproven(threadId: string): void;
  /** The selected assignment's recorded level, or the direct conversation's level when no assignment was selected. */
  recipientLevel(botId: string, threadId: string, nodeId?: string): ApprovalMode | null;
}

const ENDED: ReadonlySet<HandoffView["status"]> = new Set(["completed", "failed", "cancelled"]);

/** A question a bot waits on: parked work (its own question, or only sign-ins), or a turn waiting on its question card. */
interface Waiting {
  threadId: string;
  question: string;
  node?: HandoffView;
  card?: Message;
}

export function createQuestionRouting(deps: QuestionRoutingDeps) {
  const { store } = deps;
  const permissionRefusal = (target: BotRecord, threadId: string, sourceLevel: ApprovalMode, nodeId?: string) => {
    const level = deps.recipientLevel(target.id, threadId, nodeId);
    return level !== null && levelWithin(level, sourceLevel) ? null
      : peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed", threadId,
        detail: "that conversation has more permission than this turn, or is no longer available; nothing was sent" });
  };

  /** At Full access a question asked with an ask tool in work handed on, which the person started, is answered at once
   * with this instead of a card; undefined shows the card. What only the person can give still reaches them, and so
   * does every question in work an outside event started or in work that runs in their private chat. */
  function notAsked(input: { botId: string; threadId: string; level: ApprovalMode; question: string }): string | undefined {
    if (input.level !== "full" || personOnly(input.question)) return undefined;
    const node = deps.active().find((n) => n.threadId === input.threadId && n.botId === input.botId && n.status === "running" && n.parentId !== undefined);
    const requester = node?.parentId ? deps.node(node.parentId) : undefined;
    if (!node || !requester || node.origin?.kind === "outside" || deps.keptPrivate(node, requester)) return undefined;
    return `Not asked: at this level nobody is interrupted. Take the sensible default yourself, carry on, and say in one plain line what you chose. If you truly cannot choose, end your turn with NEEDS INPUT:, the question and Default: your pick, and @${store.bot(requester.botId)?.name ?? "your requester"} decides.`;
  }

  const signInsOnly = (node: HandoffView): boolean => {
    const rows = store.messagesFor(node.threadId);
    return Boolean(node.cards?.length) && node.cards!.every((id) => rows.some((row) => row.id === id && row.signIn));
  };

  function waitingOn(target: BotRecord): Waiting[] {
    const parked = deps.parkedFor(target.id).filter((node) => node.parentId && !node.groupId && (!node.cards?.length || signInsOnly(node)))
      .map((node) => ({ threadId: node.threadId, question: withDefault(node.question ?? "").question, node }));
    const live = store.tasks(target.id).flatMap((task) => {
      if (!deps.hasLive(task.threadId)) return [];
      const card = store.messagesFor(task.threadId).findLast((row) => !row.inbox && answerableInWords(row.card) && deps.live(task.threadId, row.card!.requestId!));
      if (!card) return [];
      const node = deps.active().find((n) => n.threadId === task.threadId && n.botId === target.id && n.status === "running");
      return [{ threadId: task.threadId, question: card.card!.subtitle || card.card!.title, card, ...(node ? { node } : {}) }];
    });
    return [...parked, ...live];
  }

  /** `sender` handed this work on: its requester is a turn of that bot outside a room, still waiting for it. */
  const handedOnBy = (node: HandoffView, senderId: string): boolean => {
    const requester = node.parentId ? deps.node(node.parentId) : undefined;
    return requester?.botId === senderId && !requester.groupId && !ENDED.has(requester.status);
  };

  type RelayTarget = { sender: BotRecord; senderThreadId: string; senderNode?: HandoffView; target: BotRecord; answers?: string;
    threadId?: string; selected?: boolean; sentThisTurn?: ReadonlySet<string>; sourceLevel: ApprovalMode; checkThread?: (threadId: string) => string | undefined };
  function selectRelay(input: RelayTarget) {
    const { sender, target } = input;
    const waiting = waitingOn(target).filter((one) => deps.mayReach(input.senderThreadId, one.threadId));
    const ownWork = (node: HandoffView | undefined): node is HandoffView => node !== undefined && node.threadId === input.threadId
      && !input.sentThisTurn?.has(node.id) && handedOnBy(node, sender.id) && deps.mayReach(input.senderThreadId, node.threadId);
    const pick = input.answers !== undefined ? waiting.find((one) => one.node?.id === input.answers)
      : waiting.find((one) => one.node !== undefined && input.senderNode?.carrying?.includes(one.node.id) === true && (!input.selected || one.threadId === input.threadId))
        ?? waiting.find((one) => ownWork(one.node) && (one.card !== undefined || !one.node.cards?.length));
    return { pick, running: pick ? undefined : deps.active().find((node) => node.botId === target.id && node.status === "running" && ownWork(node)) };
  }

  function relayRefusal(input: RelayTarget, threadId: string, nodeId?: string): PeerDeliveryReceipt | undefined {
    const detail = input.checkThread?.(threadId);
    if (detail) return peerDeliveryReceipt({ botId: input.target.id, botName: input.target.name, outcome: "failed", threadId, detail });
    return permissionRefusal(input.target, threadId, input.sourceLevel, nodeId) ?? undefined;
  }

  function relayProblem(input: RelayTarget): string | undefined {
    const { pick, running } = selectRelay(input);
    if (pick && personOnly(pick.question) && !pick.node?.cards?.length) return "Only the person can answer that question; nothing was sent.";
    if (pick && !pick.node) return undefined;
    const threadId = pick?.threadId ?? running?.threadId;
    return threadId === undefined ? undefined : relayRefusal(input, threadId, pick?.node?.id ?? running?.id)?.detail;
  }

  /** A bot's message goes into work the target already has instead of becoming new work. It answers a teammate's question
   * when it says so (`answers`: the assignment id the question's note names), when the sender's own turn was resumed with
   * that question, or when it goes to the thread (`threadId`) where work the sender handed on in an earlier turn waits on
   * a question (not on a sign-in only the person can do). Otherwise, to the thread where such work is running, it is
   * handed to that running turn. Work handed out in this very turn (`sentThisTurn`) stays apart: a second assignment is its
   * own. When the sender chose `threadId` itself (`selected`: a report-back thread it steers), a question it carries from another
   * thread does not take the message. Undefined when it goes into no work; a failed receipt when `answers` names work that no longer asks. */
  async function relay(input: RelayTarget & { message: string; lends?: boolean }): Promise<PeerDeliveryReceipt | undefined> {
    const { sender, target, message } = input;
    const { pick, running } = selectRelay(input);
    const refused = () => input.answers === undefined ? undefined : peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed",
      detail: `nothing of ${target.name}'s waits on an answer as ${input.answers}: it was answered or its work ended. Send it without answers if it still needs doing` });
    // A question in words only the person can answer; a wait on a card (a sign-in) is still settled from elsewhere.
    if (pick && personOnly(pick.question) && !pick.node?.cards?.length) {
      return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed",
        detail: `only the person can answer "${pick.question}": it waits on them where it was asked, and a teammate's answer doesn't settle it. Tell them where it is if they ask` });
    }
    if (!pick) return refused() ?? await handOn(input, running);
    if (!pick.node) return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed", threadId: pick.threadId,
      detail: "that receiving turn is no longer available; nothing was sent" });
    const denied = relayRefusal(input, pick.threadId, pick.node.id);
    if (denied) return denied;
    const by: Answerer = { kind: "bot", botId: sender.id };
    // Security invariant: first, so what this sender says can never reach a turn still holding the lent computer.
    if (!input.lends) deps.handedInUnproven(pick.threadId);
    if (pick.card) {
      if (!(await deps.answerLive(pick.threadId, pick.card.card!.requestId!, `@${sender.name} answered: ${message}`))) return refused();
      const card = store.messagesFor(pick.threadId).find((row) => row.id === pick.card!.id)?.card;
      if (card) store.patchMessage(pick.threadId, pick.card.id, { card: { ...card, answered: "answer", answeredText: message, answeredBy: { kind: "bot", name: sender.name } } });
    } else {
      const node = pick.node!;
      if (!deps.answerNode(node.id, message, by)) return refused();
      if (node.cards?.length) deps.settleSignIns(node);
      const asked = store.messagesFor(node.threadId).find((row) => row.card?.requestId?.startsWith(`needs-input-${node.id}-`) && !row.inbox
        && (!row.card.answered || (row.card.answeredBy?.kind === "bot" && row.card.answeredText === undefined)));
      if (asked?.card) store.patchMessage(node.threadId, asked.id, { card: { ...asked.card, answered: "answer", answeredText: message, answeredBy: { kind: "bot", name: sender.name } } });
    }
    store.appendMessage(input.senderThreadId, { role: "bot", kind: "activity", from: { botId: sender.id, name: sender.name, color: sender.color },
      tool: { name: `Answered ${target.name}'s question`, ok: true, output: pick.question.slice(0, 400) },
      threadRef: { botId: target.id, threadId: pick.threadId, title: store.taskByThread(target.id, pick.threadId)?.title ?? target.name } });
    return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "injected", threadId: pick.threadId, ...(pick.node ? { requestId: pick.node.id } : {}),
      detail: `answered its question "${pick.question}"; it carries on with your answer, and its result returns to whoever handed it that work` });
  }

  /** The sender's message, to the turn running the work it handed on: the turn reads it at its next step, and that work's one
   * result still returns once. Undefined when no such turn runs or its engine cannot take it now. */
  async function handOn(input: RelayTarget & { message: string; lends?: boolean }, running: HandoffView | undefined): Promise<PeerDeliveryReceipt | undefined> {
    const { sender, target, message } = input;
    if (!running) return undefined;
    const denied = relayRefusal(input, running.threadId, running.id);
    if (denied) return denied;
    if (!input.lends) deps.handedInUnproven(running.threadId);
    if (!(await deps.steer(running.threadId, composeAddition(running.id, sender.name, message, running.origin?.kind === "outside" ? AUTHORITY.info : AUTHORITY.behalf)))) return undefined;
    store.appendMessage(running.threadId, { role: "user", kind: "text", text: escapeNotes(message), peerAsk: { botId: sender.id, name: sender.name }, aside: true, steered: true });
    const title = store.taskByThread(target.id, running.threadId)?.title;
    store.appendMessage(input.senderThreadId, sentRow({ sender, recipient: target, threadId: running.threadId, via: "direct", language: conversationLanguage(input.senderThreadId),
      ...(title ? { title } : {}) }));
    return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "injected", threadId: running.threadId, requestId: running.id,
      detail: "handed to the turn it is running on the work you gave it, which reads it at its next step; that work's one result still returns to you" });
  }

  /** The question card `botId`'s turn in `threadId` waits on that a Chief may answer for the person: answerable in words, not
   * one only the person can answer, and not in work an outside event started, whose questions stay theirs. */
  function forPerson(botId: string, threadId: string): { row: Message; question: string } | undefined {
    if (deps.unattended(botId, threadId)) return undefined;
    const row = store.messagesFor(threadId).findLast((one) => !one.inbox && answerableInWords(one.card) && deps.live(threadId, one.card!.requestId!));
    const question = row?.card ? row.card.subtitle || row.card.title : "";
    return row && !personOnly(question) ? { row, question } : undefined;
  }

  /** What the Chief's turns list: the questions `teammates` (those it manages) wait on the person for, in threads the Chief
   * did not open on them and it may read (`readable`); at most ten. */
  function waitingForPerson(chief: BotRecord, teammates: readonly BotRecord[], readable: (threadId: string, botId: string) => boolean = () => true): Array<{ bot: string; threadId: string; thread: string; question: string; since: number }> {
    return teammates.flatMap((teammate) => store.tasks(teammate.id)
      .filter((task) => task.activity === "waiting-on-you" && task.archivedAt === undefined && task.openedBy?.botId !== chief.id && readable(task.threadId, teammate.id))
      .flatMap((task) => {
        const asked = forPerson(teammate.id, task.threadId);
        return asked ? [{ bot: teammate.name, threadId: task.threadId, thread: task.title, question: asked.question, since: asked.row.at }] : [];
      })).slice(0, 10);
  }

  /** A Chief answers, for the person, the question card `target` waits on in `threadId`: a thread the Chief did not open on
   * it, such as the person's own chat with it. The caller checks that the Chief manages `target` and may read that thread.
   * Undefined when the thread waits on no question the Chief may answer, so the usual thread rules apply: a sign-in, an
   * approval or a question only the person can answer stays theirs. The card shows the Chief's answer, and the person's own
   * answer still replaces it. */
  type PersonAnswerTarget = { sender: BotRecord; target: BotRecord; threadId: string; sourceLevel: ApprovalMode };
  function personAnswer(input: PersonAnswerTarget) {
    const { sender, target, threadId, sourceLevel } = input;
    const task = store.taskByThread(target.id, threadId);
    if (!task || task.archivedAt !== undefined || task.openedBy?.botId === sender.id) return undefined;
    const asked = forPerson(target.id, threadId);
    if (!asked) return undefined;
    const running = deps.active().find((node) => node.botId === target.id && node.threadId === threadId && node.status === "running");
    return { ...asked, task, denied: permissionRefusal(target, threadId, sourceLevel, running?.id) };
  }
  async function answerForPerson(input: PersonAnswerTarget & { senderThreadId: string; message: string; lends?: boolean }): Promise<PeerDeliveryReceipt | undefined> {
    const { sender, target, threadId, message } = input;
    const plan = personAnswer(input);
    if (!plan) return undefined;
    const { row, question, task, denied } = plan, card = row.card!;
    if (denied) return denied;
    if (!input.lends) deps.handedInUnproven(threadId);
    if (!(await deps.answerLive(threadId, card.requestId!, `@${sender.name} answered for the person: ${message}`))) {
      return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "failed", threadId,
        detail: `${target.name}'s question "${question}" was answered or closed meanwhile; nothing was sent` });
    }
    const settled = store.messagesFor(threadId).find((one) => one.id === row.id)?.card;
    if (settled) store.patchMessage(threadId, row.id, { card: { ...settled, answered: "answer", answeredText: message, answeredBy: { kind: "bot", name: sender.name } } });
    store.appendMessage(input.senderThreadId, { role: "bot", kind: "activity", from: { botId: sender.id, name: sender.name, color: sender.color },
      tool: { name: serverLine(conversationLanguage(input.senderThreadId), "server.teammates.answeredForPerson", { name: target.name }), ok: true, output: question.slice(0, 400) },
      threadRef: { botId: target.id, threadId, title: task.title } });
    return peerDeliveryReceipt({ botId: target.id, botName: target.name, outcome: "injected", threadId,
      detail: `answered its question "${question}" for the person; it carries on with your answer, and the person can still give their own in that thread` });
  }

  /** Propagates a busy parent-thread supplement or soft redirection into active delegated sub-workers instead of cancelling and recreating them. */
  async function forwardDelegated(input: {
    parentThreadId: string;
    parentBotId: string;
    sourceLevel: ApprovalMode;
    targets: readonly HandoffView[];
    text: string;
    redirect?: boolean;
    updatedAt?: number;
  }): Promise<{ delivered: boolean; outcomes: Array<{ nodeId: string; botId: string; threadId: string; kind: "answered" | "steered" }> }> {
    const updatedAt = input.updatedAt ?? Date.now();
    const outcomes: Array<{ nodeId: string; botId: string; threadId: string; kind: "answered" | "steered" }> = [];
    const seenThreads = new Set<string>();
    for (const child of input.targets) {
      if (!child.parentId || child.groupId !== undefined || seenThreads.has(child.threadId)) continue;
      if (!deps.mayReach(input.parentThreadId, child.threadId)) continue;
      const requester = deps.node(child.parentId);
      if (requester && deps.keptPrivate(child, requester)) continue;
      const target = store.bot(child.botId);
      if (!target) continue;
      const parentName = store.bot(input.parentBotId)?.name ?? input.parentBotId;
      const level = deps.recipientLevel(target.id, child.threadId, child.id);
      if (level === null || !levelWithin(level, input.sourceLevel)) continue;
      const task = store.taskByThread(target.id, child.threadId);
      if (!task || task.archivedAt !== undefined) continue;
      if (child.status === "waiting") {
        if (child.cards?.length && !signInsOnly(child)) continue;
        const question = withDefault(child.question ?? "").question;
        if (personOnly(question)) continue;
        // Security invariant: strip unverified computer-lending state before forwarding parent-thread input into child work.
        deps.handedInUnproven(child.threadId);
        if (!deps.answerNode(child.id, input.text, { kind: "bot", botId: input.parentBotId })) continue;
        if (child.cards?.length) deps.settleSignIns(child);
        const asked = store.messagesFor(child.threadId).find((row) => row.card?.requestId?.startsWith(`needs-input-${child.id}-`) && !row.inbox
          && (!row.card.answered || (row.card.answeredBy?.kind === "bot" && row.card.answeredText === undefined)));
        if (asked?.card) {
          store.patchMessage(child.threadId, asked.id, {
            card: { ...asked.card, answered: "answer", answeredText: input.text, answeredBy: { kind: "bot", name: parentName } },
          });
        }
        seenThreads.add(child.threadId);
        outcomes.push({ nodeId: child.id, botId: target.id, threadId: child.threadId, kind: "answered" });
        store.appendMessage(input.parentThreadId, {
          role: "bot",
          kind: "activity",
          tool: { name: `Forwarded to ${target.name}`, ok: true, output: input.text.slice(0, 240) },
          threadRef: { botId: target.id, threadId: child.threadId, title: task.title },
        });
        continue;
      }
      if (child.status === "running") {
        // Live question cards on a child thread must still only be answered when safe; forward non-card running work via live steer.
        const liveQuestion = deps.hasLive(child.threadId)
          ? store.messagesFor(child.threadId).findLast((row) => !row.inbox && answerableInWords(row.card) && deps.live(child.threadId, row.card!.requestId!))
          : undefined;
        if (liveQuestion?.card?.requestId) {
          const question = liveQuestion.card.subtitle || liveQuestion.card.title;
          if (!personOnly(question)) {
            deps.handedInUnproven(child.threadId);
            if (await deps.answerLive(child.threadId, liveQuestion.card.requestId, input.text)) {
              if (!store.taskByThread(target.id, child.threadId)) continue;
              const settled = store.messagesFor(child.threadId).find((one) => one.id === liveQuestion.id)?.card;
              if (settled) {
                store.patchMessage(child.threadId, liveQuestion.id, {
                  card: { ...settled, answered: "answer", answeredText: input.text, answeredBy: { kind: "bot", name: parentName } },
                });
              }
              seenThreads.add(child.threadId);
              outcomes.push({ nodeId: child.id, botId: target.id, threadId: child.threadId, kind: "answered" });
              store.appendMessage(input.parentThreadId, {
                role: "bot",
                kind: "activity",
                tool: { name: `Forwarded to ${target.name}`, ok: true, output: input.text.slice(0, 240) },
                threadRef: { botId: target.id, threadId: child.threadId, title: task.title },
              });
              continue;
            }
          }
        }
        // Security invariant: strip unverified computer-lending state before steering child work.
        deps.handedInUnproven(child.threadId);
        const prompt = buildDelegatedForwardPrompt({ userText: input.text, redirect: input.redirect, assignmentId: child.id });
        if (!(await deps.steer(child.threadId, prompt))) continue;
        if (!store.taskByThread(target.id, child.threadId)) continue;
        store.appendMessage(child.threadId, {
          role: "user",
          kind: "text",
          text: escapeNotes(input.text),
          aside: true,
          steered: true,
          intake: createProgressiveIntakeMeta({
            mode: "delegation-forward",
            state: "processing",
            targetTurnId: child.id,
            updatedAt,
          }),
        });
        seenThreads.add(child.threadId);
        outcomes.push({ nodeId: child.id, botId: target.id, threadId: child.threadId, kind: "steered" });
        store.appendMessage(input.parentThreadId, {
          role: "bot",
          kind: "activity",
          tool: { name: `Forwarded to ${target.name}`, ok: true, output: input.text.slice(0, 240) },
          threadRef: { botId: target.id, threadId: child.threadId, title: task.title },
        });
      }
    }
    return { delivered: outcomes.length > 0, outcomes };
  }

  return { notAsked, relay, relayProblem, personAnswer, answerForPerson, waitingForPerson, forwardDelegated };
}
