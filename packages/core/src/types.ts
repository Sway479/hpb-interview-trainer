export type SessionStatus = 'interview' | 'summary' | 'feedback_pending' | 'feedback_ready' | 'reviewed';
export interface CasePreview {
  id: string; version: string; title: string; subtitle: string;
  patient: { alias: string; sex: string; age: number };
  chiefComplaint: string; focus: string; level: string; durationMinutes: number;
  simulated: true;
}
export interface CaseDefinition extends CasePreview {
  opening: string;
  facts: { topic: string; patientWords: string; discloseWhen: string }[];
  unknown: string[];
  rubric: { id: string; label: string; expectation: string }[];
}
export interface Turn {
  id: string; role: 'learner' | 'patient'; text: string; at: string;
  source: 'typed' | 'asr' | 'model'; final: boolean; interrupted?: boolean;
  verification?: 'matches_flash' | 'paraphrase_unverified';
}
export interface LearnerSummary {
  history: string; reasoning: string; plan: string; uncertainty: string;
}
export type AssessmentGroup = 'case_history' | 'communication_process';
export type AssessmentScore = 0 | 1 | 2 | null;
export type NotScoredReason = 'insufficient_evidence' | 'not_applicable' | 'unobservable';
export interface AssessmentSource {
  id: string; title: string; url: string | null;
  kind: 'guidance' | 'primary_research' | 'local_adaptation'; note: string;
}
export interface AssessmentMetadata {
  id: string; version: string; name: string; adapted: true;
  sources: AssessmentSource[]; limitations: string[];
}
export interface AssessmentGroupSummary {
  group: AssessmentGroup; label: string; score: number; maxScore: number;
  scoredItems: number; totalItems: number; coverage: number;
}
export type AssessmentScoreSummary = Record<AssessmentGroup, AssessmentGroupSummary>;
export interface FeedbackItem {
  criterionId: string; label: string;
  status: 'observed' | 'to_improve' | 'insufficient_evidence';
  comment: string; evidence: { turnId: string; quote: string }[];
  // Optional only for reading feedback generated before assessment v0.1.
  score?: AssessmentScore; maxScore?: 2; group?: AssessmentGroup; sourceIds?: string[];
  notScoredReason?: NotScoredReason;
  zeroEvidence?: { turnId: string; quote: string; problem: string };
}
export interface Feedback {
  overview: string; items: FeedbackItem[]; nextPractice: string[];
  model: string; createdAt: string; reviewStatus: 'pending';
  assessment?: AssessmentMetadata; scoreSummary?: AssessmentScoreSummary;
}
export interface Session {
  id: string; caseId: string; caseVersion: string; caseTitle: string;
  createdAt: string; endedAt?: string; status: SessionStatus;
  turns: Turn[]; summary?: LearnerSummary; feedback?: Feedback;
  feedbackError?: string;
  recordings?: { learner: boolean; patient: boolean; learnerRate?: number; patientRate?: number };
  modelCalls?: { at: string; kind: 'patient_reply' | 'assessment'; model: string; elapsedMs: number; question?: string; answer?: string;
    profileId?: string; company?: string; endpoint?: string; requestId?: string; usage?: Record<string, unknown> }[];
  review?: { reviewer: string; notes: string; at: string; corrections?: TeacherCorrection[] };
  reviewHistory?: NonNullable<Session['review']>[];
  research?: ResearchSnapshot;
  runtime?: RuntimeSnapshot;
  auditEvents?: { id: string; at: string; type: string; reason?: string }[];
  feedbackAttempts?: { id: string; at: string; model: string; raw: string; accepted: boolean; error?: string }[];
}
export interface Study { id: string; code: string; title: string; ethicsId?: string; createdAt: string; updatedAt: string }
export interface Participant {
  id: string; studyId: string; code: string; trainingYear?: string; rotationMonths?: number; group?: string;
  consent: 'not_recorded' | 'recorded' | 'not_applicable'; note?: string; createdAt: string; updatedAt: string;
}
export interface ResearchSelection {
  studyId?: string; participantId?: string; phase: 'baseline' | 'training' | 'post' | 'retention'; mode: 'practice' | 'research';
}
export interface ResearchSnapshot extends ResearchSelection {
  studyCode?: string; studyTitle?: string; participantCode?: string; trainingYear?: string; rotationMonths?: number;
  group?: string; consent?: Participant['consent']; attemptIndex: number; capturedAt: string;
}
export interface RuntimeSnapshot {
  appVersion: string; engineVersion: string; patientPromptVersion: string; feedbackPromptVersion: string;
  assessmentId: string; assessmentVersion: string;
  feedbackGeneration?: 'automatic' | 'manual';
  text: { profileId: string; company: 'qwen' | 'openai' | 'deepseek' | 'custom'; endpoint: string; model: string };
  voice?: { profileId: string; company: 'qwen' | 'openai' | 'deepseek' | 'custom'; protocol: string; endpoint: string; model: string; voice: string };
}
export interface TeacherCorrection { criterionId: string; score: 0 | 1 | 2 | null; reason: string }
export type ServerEvent =
  | { type: 'ready'; model: string; sessionId: string; inputSampleRate: 16000 | 24000; outputSampleRate: 24000 }
  | { type: 'turn'; turn: Turn }
  | { type: 'audio'; audio: string; itemId: string }
  | { type: 'speech_started' }
  | { type: 'speech_stopped' }
  | { type: 'response_started' }
  | { type: 'response_done'; status: string }
  | { type: 'reasoning_started'; model: string }
  | { type: 'reasoning_done' }
  | { type: 'quality_warning'; message: string }
  | { type: 'interrupted' }
  | { type: 'session_ended'; session: Session }
  | { type: 'error'; message: string; code?: string };
export type ClientEvent =
  | { type: 'connect'; sessionId: string; token?: string }
  | { type: 'audio'; audio: string }
  | { type: 'text'; text: string }
  | { type: 'interrupt' }
  | { type: 'finish' };
