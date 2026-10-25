// Faux backend en mémoire pour les tests de composants : remplace src/lib/api et src/lib/supabase
// (voir setup.ts). Chaque test part d'un état neuf (resetBackend).
import type { Session } from '@supabase/supabase-js';
import { vi } from 'vitest';
import type { Profile, Resource } from '../../src/lib/api';
import type { FileConsent, Membership } from '../../src/lib/careFiles';
import type { CareDocument, Extraction, MedicationMention, TimelineEvent } from '../../src/lib/documents';
import type { FileProgram, Program } from '../../src/lib/benefits';
import type { Appointment, AppointmentQuestion, JournalEntry, Task } from '../../src/lib/coordination';
import type { BenefitAnswers } from '../../src/shared/benefits/engine';
import programsJson from '../../src/content/programs.fr.json';
import type { ConsentRecord, UserConsentType } from '../../src/lib/consents';
import snapshot from '../../src/content/emergency-resources.json';

export const USER_ID = 'a0000000-0000-4000-8000-00000000000a';

export function fakeSession(aal: 'aal1' | 'aal2' = 'aal1', userId = USER_ID): Session {
    const payload = btoa(JSON.stringify({ sub: userId, aal, role: 'authenticated' })).replace(/=+$/, '');
    return {
        access_token: `eyJhbGciOiJub25lIn0.${payload}.sig`,
        refresh_token: 'refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: userId, email: 'aidante@example.test', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' }
    } as Session;
}

export const FILE_ID = 'f1000000-0000-4000-8000-000000000001';

interface FileState {
    members: Membership[];
    consents: FileConsent[];
    documents: CareDocument[];
    extraction: Extraction | null;
    timeline: TimelineEvent[];
    medications: MedicationMention[];
    answers: { answers: BenefitAnswers; created_at: string } | null;
    programs: FileProgram[];
    tasks: Task[];
    appointments: Appointment[];
    questions: AppointmentQuestion[];
    journal: JournalEntry[];
}

const emptyFile = (): FileState => ({
    members: [],
    consents: [],
    documents: [],
    extraction: null,
    timeline: [],
    medications: [],
    answers: null,
    programs: [],
    tasks: [],
    appointments: [],
    questions: [],
    journal: []
});

interface BackendState {
    session: Session | null;
    profile: Profile;
    consents: ConsentRecord[];
    resources: Resource[];
    failResources: boolean;
    file: FileState;
    programs: Program[];
}

export const backend: BackendState = {
    session: null,
    profile: { id: USER_ID, display_name: null, app_role: 'member' },
    consents: [],
    resources: [],
    failResources: false,
    file: emptyFile(),
    programs: []
};

export function resetBackend(): void {
    backend.session = null;
    backend.profile = { id: USER_ID, display_name: null, app_role: 'member' };
    backend.consents = [];
    backend.resources = snapshot as Resource[];
    backend.failResources = false;
    backend.file = emptyFile();
    for (const fn of Object.values(api)) fn.mockClear();
    for (const fn of Object.values(careFilesApi)) fn.mockClear();
    for (const fn of Object.values(documentsApi)) fn.mockClear();
    for (const fn of Object.values(benefitsApi)) fn.mockClear();
    for (const fn of Object.values(coordinationApi)) fn.mockClear();
    backend.programs = catalog();
}

let nextId = 1;
const id = () => `c0000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

export function consent(type: UserConsentType, version = '2026-10-26', revokedAt: string | null = null): ConsentRecord {
    return { id: id(), consent_type: type, text_version: version, granted_at: '2026-10-26T14:00:00Z', revoked_at: revokedAt };
}

export const api = {
    getProfile: vi.fn(async () => ({ ...backend.profile })),
    updateDisplayName: vi.fn(async (_userId: string, name: string) => {
        backend.profile = { ...backend.profile, display_name: name };
    }),
    listMyConsents: vi.fn(async () => [...backend.consents]),
    grantConsent: vi.fn(async (type: UserConsentType, version: string) => {
        backend.consents = backend.consents.map((c) =>
            c.consent_type === type && c.revoked_at === null ? { ...c, revoked_at: '2026-10-26T15:00:00Z' } : c
        );
        backend.consents.unshift(consent(type, version));
    }),
    revokeConsent: vi.fn(async (consentId: string) => {
        backend.consents = backend.consents.map((c) => (c.id === consentId ? { ...c, revoked_at: '2026-10-26T15:00:00Z' } : c));
    }),
    listHelpResources: vi.fn(async () => {
        if (backend.failResources) throw new Error('réseau indisponible');
        return [...backend.resources];
    }),
    exportMyData: vi.fn(async () => ({ format: 'relais-export/1' })),
    deleteMyAccount: vi.fn(async () => undefined),
    signOutLocally: vi.fn(async () => undefined)
};

export const auth = {
    getSession: vi.fn(async () => ({ data: { session: backend.session }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => undefined } } })),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    verifyOtp: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    mfa: {
        listFactors: vi.fn(async () => ({
            data: { totp: [], all: [{ id: 'stale-factor', factor_type: 'totp', status: 'unverified' }] },
            error: null
        })),
        unenroll: vi.fn(async () => ({ data: {}, error: null })),
        enroll: vi.fn(async () => ({
            data: { id: 'factor-1', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'ABCDEF' } },
            error: null
        })),
        challengeAndVerify: vi.fn(async () => ({ data: {}, error: null }))
    }
};

/** Dossier unique en mémoire, appartenant à l'utilisateur de test, pour les pages de l'étape 2. */
export function ownFile(): void {
    backend.file.members = [
        { care_file_id: FILE_ID, user_id: USER_ID, role: 'primary_caregiver', access_level: 'owner', joined_at: '2026-10-27T10:00:00Z' }
    ];
}

export function fileConsent(overrides: Partial<FileConsent> = {}): FileConsent {
    return {
        id: id(),
        consent_type: 'care_recipient_data',
        text_version: '2026-10-27',
        granted_by: 'care_recipient_signed_form',
        legal_basis: 'person_consents',
        representative_name: null,
        granted_at: '2026-10-27T10:00:00Z',
        revoked_at: null,
        revoked_by: null,
        ...overrides
    };
}

export const careFilesApi = {
    listMyMemberships: vi.fn(async () => backend.file.members.filter((m) => m.user_id === USER_ID)),
    listCareFiles: vi.fn(async (ids: string[]) =>
        ids.includes(FILE_ID) ? [{ id: FILE_ID, title: 'Maman', owner_id: USER_ID, created_at: '2026-10-27T10:00:00Z' }] : []
    ),
    getCareFile: vi.fn(async (fileId: string) =>
        fileId === FILE_ID && backend.file.members.length > 0
            ? { id: FILE_ID, title: 'Maman', owner_id: USER_ID, created_at: '2026-10-27T10:00:00Z' }
            : null
    ),
    listMembers: vi.fn(async () => backend.file.members.map((m) => ({ ...m, display_name: m.user_id === USER_ID ? 'Louise' : null }))),
    listFileConsents: vi.fn(async () => [...backend.file.consents]),
    recordFileConsent: vi.fn(async () => undefined),
    revokeFileConsent: vi.fn(async () => undefined),
    getCareRecipient: vi.fn(async () => null),
    getCareNeeds: vi.fn(async () => null),
    listContacts: vi.fn(async () => []),
    listInvitations: vi.fn(async () => []),
    listAccessLog: vi.fn(async () => []),
    logFileOpened: vi.fn(async () => undefined)
};

export const DOCUMENT_ID = 'd1000000-0000-4000-8000-000000000001';

export function careDocument(overrides: Partial<CareDocument> = {}): CareDocument {
    return {
        id: DOCUMENT_ID,
        care_file_id: FILE_ID,
        mime_type: 'application/pdf',
        size_bytes: 120000,
        page_count: 3,
        status: 'uploaded',
        extraction_error: null,
        title: null,
        doc_type: null,
        doc_date: null,
        author: null,
        needs_review: false,
        uploaded_by: USER_ID,
        uploaded_at: '2026-10-28T14:00:00Z',
        ...overrides
    };
}

export const documentsApi = {
    listDocuments: vi.fn(async () => [...backend.file.documents]),
    getDocument: vi.fn(async (id: string) => backend.file.documents.find((d) => d.id === id) ?? null),
    getCurrentExtraction: vi.fn(async () => backend.file.extraction),
    listMedications: vi.fn(async () => [...backend.file.medications]),
    listTimeline: vi.fn(async () => [...backend.file.timeline]),
    uploadDocument: vi.fn(async () => DOCUMENT_ID),
    extractDocument: vi.fn(async () => ({ status: 'draft_ready' as const })),
    documentUrl: vi.fn(async () => 'https://storage.example/signed'),
    deleteDocument: vi.fn(async () => undefined),
    confirmDocument: vi.fn(async () => undefined),
    discardExtraction: vi.fn(async () => undefined),
    logExtractionViewed: vi.fn(async () => undefined),
    createTimelineEvent: vi.fn(async () => undefined),
    deleteTimelineEvent: vi.fn(async () => undefined),
    deleteMedication: vi.fn(async () => undefined)
};

/** Catalogue de départ (programs.fr.json), avec des identifiants stables. */
export function catalog(): Program[] {
    return programsJson.map((p, i) => ({
        ...p,
        id: `b1000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        criteria: p.criteria as Program['criteria'],
        verification_status: 'to_verify' as const,
        verified_on: null,
        verified_by: null,
        version: 1,
        is_active: true
    }));
}

export const benefitsApi = {
    listPrograms: vi.fn(async () => [...backend.programs]),
    getLatestAnswers: vi.fn(async () => backend.file.answers),
    listFilePrograms: vi.fn(async () => [...backend.file.programs]),
    saveAssessment: vi.fn(async () => undefined),
    updateFileProgram: vi.fn(async () => undefined),
    setChecklistItemDone: vi.fn(async () => undefined),
    addChecklistItem: vi.fn(async () => undefined),
    deleteChecklistItem: vi.fn(async () => undefined),
    explainProgram: vi.fn(async () => null as unknown),
    draftLetter: vi.fn(async () => null as string | null),
    createProgram: vi.fn(async () => undefined),
    updateProgram: vi.fn(async () => undefined),
    listResourcesForAdmin: vi.fn(async () => []),
    updateResource: vi.fn(async () => undefined)
};

// ------------------------------------------------------------------------------------- coordination
export function task(overrides: Partial<Task> = {}): Task {
    return {
        id: id(),
        care_file_id: FILE_ID,
        title: 'Appeler la pharmacie',
        details: null,
        assignee_id: null,
        due_on: null,
        status: 'todo',
        completed_at: null,
        completed_by: null,
        source_document_id: null,
        care_file_program_id: null,
        created_by: USER_ID,
        created_at: '2026-10-29T14:00:00Z',
        ...overrides
    };
}

export const APPOINTMENT_ID = 'a1000000-0000-4000-8000-000000000001';

export function appointment(overrides: Partial<Appointment> = {}): Appointment {
    return {
        id: APPOINTMENT_ID,
        care_file_id: FILE_ID,
        title: 'Clinique de gériatrie',
        starts_at: '2026-11-02T15:00:00.000Z',
        ends_at: null,
        location: 'Hôpital fictif',
        contact_id: null,
        companion_id: null,
        notes: 'Apporter la carte',
        source_document_id: null,
        created_by: USER_ID,
        created_at: '2026-10-29T14:00:00Z',
        ...overrides
    };
}

export const coordinationApi = {
    listTasks: vi.fn(async () => [...backend.file.tasks]),
    createTask: vi.fn(async () => undefined),
    updateTask: vi.fn(async () => undefined),
    setTaskDone: vi.fn(async () => undefined),
    deleteTask: vi.fn(async () => undefined),
    listAppointments: vi.fn(async () => [...backend.file.appointments]),
    createAppointment: vi.fn(async () => APPOINTMENT_ID),
    updateAppointment: vi.fn(async () => undefined),
    deleteAppointment: vi.fn(async () => undefined),
    listQuestions: vi.fn(async () => [...backend.file.questions]),
    addQuestion: vi.fn(async () => undefined),
    deleteQuestion: vi.fn(async () => undefined),
    logPrepSheetPrinted: vi.fn(async () => undefined),
    listJournal: vi.fn(async () => [...backend.file.journal]),
    addJournalEntry: vi.fn(async () => undefined),
    updateJournalEntry: vi.fn(async () => undefined),
    deleteJournalEntry: vi.fn(async () => undefined)
};
