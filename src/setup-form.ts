import { isReadinessAnswer } from './readiness.js';
import type { ReadinessField } from './readiness.js';

export interface SetupQuestion { id: string; question: string; format?: ReadinessField['format'] }
export interface SetupForm { questions: SetupQuestion[] }

export function setupQuestions(fields: ReadinessField[] = []): SetupQuestion[] {
  const questions = fields.filter(field => field.stage === 'intake' && field.id !== 'setup-confirmation')
    .map(field => ({
      id: field.id,
      question: field.question ?? field.instruction,
      ...(field.format ? { format: field.format } : {}),
    }));
  return [...new Map(questions.map(question => [question.id, question])).values()];
}

export function isSetupAnswer(question: SetupQuestion, value: unknown): value is string {
  if (!isReadinessAnswer(value)) return false;
  const answer = value.trim();
  if (answer.length > 2000) return false;
  if (!question.format) return true;
  if (/[\r\n\0]/.test(answer)) return false;
  const folder = /^(?:\/(?!\/)[^/]|[a-z]:[\\/][^\\/]|\\\\[^\\]+\\[^\\]+)/i.test(answer);
  const githubRepository = /^https:\/\/github\.com\/[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+\/?$/i.test(answer);
  return folder || (question.format === 'project-source' && githubRepository);
}

export function validateSetup(form: SetupForm, input: unknown) {
  if (!input || typeof input !== 'object') return { error: 'Enter your setup answers.' } as const;
  const { answers } = input as { answers?: unknown };
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return { error: 'Enter your setup answers.' } as const;
  }

  const supplied = answers as Record<string, unknown>;
  const missing = form.questions.filter(question =>
    !Object.hasOwn(supplied, question.id) || !isSetupAnswer(question, supplied[question.id]));
  if (missing.length) return { error: 'Complete every required answer before finishing setup.', missing: missing.map(({ id }) => id) } as const;
  const values = Object.fromEntries(form.questions.map(({ id }) => [id, (supplied[id] as string).trim()]));
  return { value: { answers: values } } as const;
}
