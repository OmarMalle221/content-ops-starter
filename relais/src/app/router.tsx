import { createBrowserRouter } from 'react-router';
import { AccountPage } from '../features/account/AccountPage';
import { SignInPage } from '../features/auth/SignInPage';
import { MyConsentsPage } from '../features/consents/MyConsentsPage';
import { HelpPage } from '../features/help/HelpPage';
import { HomePage } from '../features/home/HomePage';
import { LandingPage } from '../features/landing/LandingPage';
import { MfaPage } from '../features/mfa/MfaPage';
import { AdminHomePage, AdminProgramEditPage, AdminProgramsPage, AdminResourcesPage } from '../features/admin/AdminPages';
import { BenefitsPage } from '../features/benefits/BenefitsPage';
import { ProgramPage } from '../features/benefits/ProgramPage';
import { DocumentPage } from '../features/documents/DocumentPage';
import { FileDocumentsPage } from '../features/documents/FileDocumentsPage';
import { TimelinePage } from '../features/documents/TimelinePage';
import { ConsentFormPage } from '../features/files/ConsentFormPage';
import { FileConsentPage } from '../features/files/FileConsentPage';
import { FileContactsPage } from '../features/files/FileContactsPage';
import { FileLayout } from '../features/files/FileLayout';
import { FileLogPage } from '../features/files/FileLogPage';
import { FileMembersPage } from '../features/files/FileMembersPage';
import { FileOverviewPage } from '../features/files/FileOverviewPage';
import { FileProfilePage } from '../features/files/FileProfilePage';
import { FileSettingsPage } from '../features/files/FileSettingsPage';
import { NewCareFilePage } from '../features/files/NewCareFilePage';
import { InvitationPage } from '../features/invitations/InvitationPage';
import { WelcomePage } from '../features/onboarding/WelcomePage';
import { PrivacyPage } from '../features/privacy/PrivacyPage';
import { AppLayout, NotFoundPage } from './AppLayout';
import { RequireOnboarding, RequireSession, RequireStaffMfa } from './guards';

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
                                    { path: '/dossiers/nouveau', element: <NewCareFilePage /> },
                                    { path: '/dossiers/:fileId/formulaire-consentement', element: <ConsentFormPage /> },
                                    {
                                        path: '/dossiers/:fileId',
                                        element: <FileLayout />,
                                        children: [
                                            { index: true, element: <FileOverviewPage /> },
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
