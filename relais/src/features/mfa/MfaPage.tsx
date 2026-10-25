import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { sessionAal, useSession } from '../../app/session';
import { Button, Loading, Notice, PageTitle, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { errorFields, logEvent } from '../../lib/log';
import { supabase } from '../../lib/supabase';

interface MfaSetup {
    factorId: string;
    /** Présents seulement à l'inscription d'un nouveau facteur. */
    qrCode?: string;
    secret?: string;
}

/** Facteur TOTP vérifié existant, sinon inscription d'un nouveau facteur. */
async function prepareMfa(): Promise<MfaSetup> {
    const client = supabase();
    const factors = await client.auth.mfa.listFactors();
    if (factors.error) throw factors.error;
    const verified = factors.data.totp[0];
    if (verified) return { factorId: verified.id };
    // Une inscription commencée puis abandonnée ne doit pas s'accumuler : on la retire avant d'en refaire une.
    for (const factor of factors.data.all) {
        if (factor.status !== 'verified') await client.auth.mfa.unenroll({ factorId: factor.id });
    }
    const enrolled = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Relais ${Date.now()}` });
    if (enrolled.error) throw enrolled.error;
    return { factorId: enrolled.data.id, qrCode: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret };
}

export function MfaPage() {
    const { session } = useSession();
    const navigate = useNavigate();
    const location = useLocation();
    const from = (location.state as { from?: string } | null)?.from ?? '/accueil';
    const setup = useQuery({ queryKey: ['mfa-setup', session?.user.id], queryFn: prepareMfa, staleTime: Infinity, retry: false });
    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    if (sessionAal(session) === 'aal2') return <Navigate to={from} replace />;

    async function verify(event: FormEvent) {
        event.preventDefault();
        if (!setup.data || !/^\d{6}$/.test(code.trim())) {
            setError(fr.mfa.invalidCode);
            return;
        }
        setBusy(true);
        setError(null);
        const { error: verifyError } = await supabase().auth.mfa.challengeAndVerify({ factorId: setup.data.factorId, code: code.trim() });
        setBusy(false);
        if (verifyError) {
            logEvent('auth_failed', { ...errorFields(verifyError), code: 'mfa_verify' });
            setError(fr.mfa.invalidCode);
            return;
        }
        logEvent('mfa_verified');
        navigate(from, { replace: true });
    }

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{fr.mfa.title}</PageTitle>
            <p>{fr.mfa.intro}</p>
            {setup.isPending && <Loading />}
            {setup.isError && <Notice tone="error">{fr.app.genericError}</Notice>}
            {setup.data && (
                <form onSubmit={verify} noValidate className="flex flex-col gap-4">
                    {setup.data.qrCode && (
                        <>
                            <ol className="list-decimal pl-6">
                                {fr.mfa.enrollSteps.map((step) => (
                                    <li key={step}>{step}</li>
                                ))}
                            </ol>
                            <img src={setup.data.qrCode} alt={fr.mfa.qrAlt} width={200} height={200} className="rounded-lg bg-white p-2" />
                            <p>
                                {fr.mfa.secret} <code className="break-all font-bold">{setup.data.secret}</code>
                            </p>
                        </>
                    )}
                    <TextField
                        label={fr.mfa.codeLabel}
                        error={error}
                        name="totp"
                        autoComplete="one-time-code"
                        inputMode="numeric"
                        maxLength={6}
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                    />
                    <Button type="submit" disabled={busy}>
                        {busy ? fr.mfa.verifying : fr.mfa.verify}
                    </Button>
                </form>
            )}
        </div>
    );
}
