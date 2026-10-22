import type { LearnerSummary, Session } from '../../../../packages/core/src/types';
export type { Study, Participant, ResearchSelection, ResearchSnapshot, RuntimeSnapshot, TeacherCorrection } from '../../../../packages/core/src/types';
import type { Study, Participant, ResearchSelection } from '../../../../packages/core/src/types';

export type ProviderCompany = 'qwen' | 'openai' | 'deepseek' | 'custom';
export interface ProviderProfile {
  id: string; name: string; company: ProviderCompany;
  chatUrl: string; chatModel: string;
  realtimeProtocol: 'qwen' | 'openai' | 'none';
  realtimeUrl: string; realtimeModel: string; voice: string;
  hasKey?: boolean;
}
export interface ConnectionSettings {
  mode: 'standalone'; profiles: ProviderProfile[];
  textProfileId: string; voiceProfileId: string;
}
export interface CredentialStatus { hasKey: boolean }
export type CredentialStatuses = Record<string, CredentialStatus>;
export interface ProbeResult { ok: boolean; capability: 'text' | 'voice'; message: string; model?: string }
export interface ExportResult { fileName: string; uri?: string; bytes: number; shared?: boolean; content?: string }
export interface ResearchExportOptions { studyId?: string; includeAudio: boolean }
export interface BackupData {
  schemaVersion: '0.2'; exportedAt: string; simulatedCases: true;
  studies: Study[]; participants: Participant[]; sessions: Session[];
  drafts?: Record<string, LearnerSummary>;
}
export const DEFAULT_RESEARCH_SELECTION: ResearchSelection = { mode: 'practice', phase: 'training' };
export const APP_VERSION = '0.2.0';
export const ENGINE_VERSION = 'standalone-0.2.0';
export const PATIENT_PROMPT_VERSION = 'patient-0.2.0';
export const FEEDBACK_PROMPT_VERSION = 'feedback-0.2.0';
