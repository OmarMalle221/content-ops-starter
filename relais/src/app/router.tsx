import { createBrowserRouter } from 'react-router';
import { AccountPage } from '../features/account/AccountPage';
import { SignInPage } from '../features/auth/SignInPage';
import { MyConsentsPage } from '../features/consents/MyConsentsPage';
import { HelpPage } from '../features/help/HelpPage';
import { HomePage } from '../features/home/HomePage';
import { LandingPage } from '../features/landing/LandingPage';
import { MfaPage } from '../features/mfa/MfaPage';
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
                                    { path: '/compte', element: <AccountPage /> }
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
