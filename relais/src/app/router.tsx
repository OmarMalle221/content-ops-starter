import { createBrowserRouter } from 'react-router';
import { SignInPage } from '../features/auth/SignInPage';
import { MyConsentsPage } from '../features/consents/MyConsentsPage';
import { HelpPage } from '../features/help/HelpPage';
import { HomePage } from '../features/home/HomePage';
import { LandingPage } from '../features/landing/LandingPage';
import { MfaPage } from '../features/mfa/MfaPage';
import { FileLayout } from '../features/files/FileLayout';
import { InvitationPage } from '../features/invitations/InvitationPage';
import { WelcomePage } from '../features/onboarding/WelcomePage';
import { PrivacyPage } from '../features/privacy/PrivacyPage';
import { AppLayout, NotFoundPage } from './AppLayout';
import { RequireOnboarding, RequireSession, RequireStaffMfa } from './guards';
import { lazyPage } from './lazyPage';
// Pages chargées à la demande : le premier écran (accueil, connexion, aide) reste léger.
const AccountPage = lazyPage(() => import('../features/account/AccountPage'), 'AccountPage');
const AdminHomePage = lazyPage(() => import('../features/admin/AdminPages'), 'AdminHomePage');
const AdminProgramEditPage = lazyPage(() => import('../features/admin/AdminPages'), 'AdminProgramEditPage');
const AdminProgramsPage = lazyPage(() => import('../features/admin/AdminPages'), 'AdminProgramsPage');
const AdminResourcesPage = lazyPage(() => import('../features/admin/AdminPages'), 'AdminResourcesPage');
const AdminPilotPage = lazyPage(() => import('../features/admin/AdminPilotPage'), 'AdminPilotPage');
const CheckinPage = lazyPage(() => import('../features/support/CheckinPage'), 'CheckinPage');
const FeedbackPage = lazyPage(() => import('../features/support/FeedbackPage'), 'FeedbackPage');
const SupportPage = lazyPage(() => import('../features/support/SupportPage'), 'SupportPage');
const WorkerBoardPage = lazyPage(() => import('../features/support/WorkerPages'), 'WorkerBoardPage');
const WorkerRequestPage = lazyPage(() => import('../features/support/WorkerPages'), 'WorkerRequestPage');
const BenefitsPage = lazyPage(() => import('../features/benefits/BenefitsPage'), 'BenefitsPage');
const ProgramPage = lazyPage(() => import('../features/benefits/ProgramPage'), 'ProgramPage');
const AgendaPage = lazyPage(() => import('../features/coordination/AgendaPages'), 'AgendaPage');
const AppointmentEditPage = lazyPage(() => import('../features/coordination/AgendaPages'), 'AppointmentEditPage');
const AppointmentPage = lazyPage(() => import('../features/coordination/AgendaPages'), 'AppointmentPage');
const JournalPage = lazyPage(() => import('../features/coordination/JournalPage'), 'JournalPage');
const PrepSheetPage = lazyPage(() => import('../features/coordination/PrepSheetPage'), 'PrepSheetPage');
const TasksPage = lazyPage(() => import('../features/coordination/TasksPage'), 'TasksPage');
const DocumentPage = lazyPage(() => import('../features/documents/DocumentPage'), 'DocumentPage');
const FileDocumentsPage = lazyPage(() => import('../features/documents/FileDocumentsPage'), 'FileDocumentsPage');
const TimelinePage = lazyPage(() => import('../features/documents/TimelinePage'), 'TimelinePage');
const ConsentFormPage = lazyPage(() => import('../features/files/ConsentFormPage'), 'ConsentFormPage');
const FileConsentPage = lazyPage(() => import('../features/files/FileConsentPage'), 'FileConsentPage');
const FileContactsPage = lazyPage(() => import('../features/files/FileContactsPage'), 'FileContactsPage');
const FileLogPage = lazyPage(() => import('../features/files/FileLogPage'), 'FileLogPage');
const FileMembersPage = lazyPage(() => import('../features/files/FileMembersPage'), 'FileMembersPage');
const FileOverviewPage = lazyPage(() => import('../features/files/FileOverviewPage'), 'FileOverviewPage');
const FileProfilePage = lazyPage(() => import('../features/files/FileProfilePage'), 'FileProfilePage');
const FileSettingsPage = lazyPage(() => import('../features/files/FileSettingsPage'), 'FileSettingsPage');
const NewCareFilePage = lazyPage(() => import('../features/files/NewCareFilePage'), 'NewCareFilePage');

// Adresses en français (visibles par les personnes) ; code en anglais.
export const routes = [
    {
        element: <AppLayout />,
        children: [
            { path: '/', element: <LandingPage /> },
            { path: '/connexion', element: <SignInPage /> },
            { path: '/confidentialite', element: <PrivacyPage /> },
            { path: '/aide', element: <HelpPage /> },
            // Publique : gère elle-même la connexion et l'accueil des nouveaux, en gardant le jeton.
            { path: '/invitation', element: <InvitationPage /> },
            {
                element: <RequireSession />,
                children: [
                    { path: '/verification', element: <MfaPage /> },
                    {
                        element: <RequireStaffMfa />,
                        children: [
                            { path: '/bienvenue', element: <WelcomePage /> },
                            {
                                element: <RequireOnboarding />,
                                children: [
                                    { path: '/accueil', element: <HomePage /> },
                                    { path: '/mes-consentements', element: <MyConsentsPage /> },
                                    { path: '/compte', element: <AccountPage /> },
                                    { path: '/admin', element: <AdminHomePage /> },
                                    { path: '/admin/programmes', element: <AdminProgramsPage /> },
                                    { path: '/admin/programmes/:programId', element: <AdminProgramEditPage /> },
                                    { path: '/admin/ressources', element: <AdminResourcesPage /> },
                                    { path: '/admin/pilote', element: <AdminPilotPage /> },
                                    { path: '/bilan', element: <CheckinPage /> },
                                    { path: '/parler-a-une-intervenante', element: <SupportPage /> },
                                    { path: '/evaluation', element: <FeedbackPage /> },
                                    { path: '/intervenante', element: <WorkerBoardPage /> },
                                    { path: '/intervenante/demandes/:requestId', element: <WorkerRequestPage /> },
                                    { path: '/dossiers/nouveau', element: <NewCareFilePage /> },
                                    { path: '/dossiers/:fileId/formulaire-consentement', element: <ConsentFormPage /> },
                                    {
                                        path: '/dossiers/:fileId',
                                        element: <FileLayout />,
                                        children: [
                                            { index: true, element: <FileOverviewPage /> },
                                            { path: 'agenda', element: <AgendaPage /> },
                                            { path: 'agenda/nouveau', element: <AppointmentEditPage /> },
                                            { path: 'agenda/:appointmentId', element: <AppointmentPage /> },
                                            { path: 'agenda/:appointmentId/modifier', element: <AppointmentEditPage /> },
                                            { path: 'agenda/:appointmentId/preparer', element: <PrepSheetPage /> },
                                            { path: 'taches', element: <TasksPage /> },
                                            { path: 'carnet', element: <JournalPage /> },
                                            { path: 'profil', element: <FileProfilePage /> },
                                            { path: 'contacts', element: <FileContactsPage /> },
                                            { path: 'documents', element: <FileDocumentsPage /> },
                                            { path: 'documents/:documentId', element: <DocumentPage /> },
                                            { path: 'chronologie', element: <TimelinePage /> },
                                            { path: 'droits', element: <BenefitsPage /> },
                                            { path: 'droits/:programSlug', element: <ProgramPage /> },
                                            { path: 'consentement', element: <FileConsentPage /> },
                                            { path: 'membres', element: <FileMembersPage /> },
                                            { path: 'journal', element: <FileLogPage /> },
                                            { path: 'parametres', element: <FileSettingsPage /> }
                                        ]
                                    }
                                ]
                            }
                        ]
                    }
                ]
            },
            { path: '*', element: <NotFoundPage /> }
        ]
    }
];

export function createRouter() {
    return createBrowserRouter(routes);
}
