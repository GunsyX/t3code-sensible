/** Older threads recorded Claude's resume dialog; clients still read those answers. */
export const CLAUDE_RESUME_COMPACTION_NEVER_ANSWER = "Don't ask again";
const CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER = "Compact and continue";

const CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN =
  /^This session is (\d+h \d+m|\d+m) old and uses \d{1,3}(?:,\d{3})* tokens\. Compact it before continuing\?$/u;

export function isClaudeResumeCompactionQuestion(question: string): boolean {
  return CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN.test(question);
}

/**
 * The session age from an answered resume question whose answer was to compact, or null. Answers
 * are keyed by question id, and the id may itself be the question text.
 */
export function claudeResumeCompactionAge(questionAnswer: {
  readonly questionTextById?: Readonly<Record<string, string>> | undefined;
  readonly answers: Readonly<Record<string, unknown>>;
}): string | null {
  for (const [id, answer] of Object.entries(questionAnswer.answers)) {
    const age = CLAUDE_RESUME_COMPACTION_QUESTION_PATTERN.exec(
      questionAnswer.questionTextById?.[id] ?? id,
    )?.[1];
    const chosen = Array.isArray(answer) ? answer : [answer];
    if (age !== undefined && chosen.includes(CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER)) return age;
  }
  return null;
}

/**
 * Context size below which T3 does not suggest or run a Claude compaction:
 * the stale-thread Compact chip and idle compaction. Matches Claude Code's
 * idleCompaction default of 200K.
 */
export const COMPACTION_SUGGESTION_MIN_TOKENS = 200_000;
