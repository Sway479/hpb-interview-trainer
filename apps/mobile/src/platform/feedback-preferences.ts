import { z } from 'zod';
import { documents, type DocumentStorage } from './storage';

export type FeedbackGeneration = 'automatic' | 'manual';
export interface FeedbackPreferences {
  version: 1;
  practice: FeedbackGeneration;
  research: FeedbackGeneration;
}
export interface FeedbackPreferencesResult {
  preferences: FeedbackPreferences;
  warning?: string;
}
export const FEEDBACK_PREFERENCES_PATH = 'preferences/feedback-generation.json';
export const DEFAULT_FEEDBACK_PREFERENCES: Readonly<FeedbackPreferences> = Object.freeze({
  version: 1, practice: 'automatic', research: 'manual',
});
const schema = z.object({ version: z.literal(1), practice: z.enum(['automatic', 'manual']), research: z.enum(['automatic', 'manual']) }).strict();
const writing = new WeakMap<DocumentStorage, Promise<void>>();

export function validateFeedbackPreferences(value: unknown): FeedbackPreferences {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('反馈生成设置格式无效，请重新选择并保存。');
  return { ...parsed.data };
}
const safeManual = (warning: string): FeedbackPreferencesResult => ({
  preferences: { version: 1, practice: 'manual', research: 'manual' }, warning,
});

/** Read failure/corruption never opts a user into an automatic model request; retain the original document. */
export async function loadFeedbackPreferences(storage: DocumentStorage = documents): Promise<FeedbackPreferencesResult> {
  let raw: string | null;
  try { await writing.get(storage); raw = await storage.read(FEEDBACK_PREFERENCES_PATH); }
  catch { return safeManual('反馈生成设置读取失败，本次默认手动生成；请检查存储后重新保存设置。'); }
  if (raw === null) return { preferences: { ...DEFAULT_FEEDBACK_PREFERENCES } };
  try { return { preferences: validateFeedbackPreferences(JSON.parse(raw)) }; }
  catch { return safeManual('反馈生成设置无法识别，已采用手动生成；原文件保留，请重新保存设置。'); }
}

/** A resolved write is required before the UI may report success. This preference is not a research backup record. */
export async function saveFeedbackPreferences(value: FeedbackPreferences, storage: DocumentStorage = documents): Promise<FeedbackPreferences> {
  const preferences = validateFeedbackPreferences(value);
  const task = (writing.get(storage) ?? Promise.resolve()).then(async () => {
    try { await storage.write(FEEDBACK_PREFERENCES_PATH, JSON.stringify(preferences)); }
    catch { throw new Error('反馈生成设置尚未保存，请检查设备存储后重试。'); }
  });
  writing.set(storage, task.then(() => undefined, () => undefined));
  await task;
  return { ...preferences };
}
