import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useSession } from '../../app/session';
import { Button, Notice, PageTitle, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { errorFields, logEvent } from '../../lib/log';
import { supabase } from '../../lib/supabase';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE = /^\d{6}$/;
const RESEND_DELAY_S = 60;

export function SignInPage() {
    const { session } = useSession();
    const navigate = useNavigate();
    const location = useLocation();
    const from = (location.state as { from?: string } | null)?.from ?? '/accueil';

    const [step, setStep] = useState<'email' | 'code'>('email');
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [resendIn, setResendIn] = useState(0);

    useEffect(() => {
        if (resendIn <= 0) return;
        const timer = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
        return () => window.clearTimeout(timer);
    }, [resendIn]);

    if (session && !busy) return <Navigate to={from} replace />;

    async function sendCode(event?: FormEvent) {
        event?.preventDefault();
        const address = email.trim().toLowerCase();
        if (!EMAIL.test(address)) {
            setError(fr.signIn.invalidEmail);
            return;
        }
        setBusy(true);
        setError(null);
        const { error: otpError } = await supabase().auth.signInWithOtp({ email: address, options: { shouldCreateUser: true } });
        setBusy(false);
        if (otpError) {
            logEvent('auth_failed', { ...errorFields(otpError), code: 'otp_send' });
            setError(fr.signIn.sendFailed);
            return;
        }
        logEvent('auth_code_requested');
        setEmail(address);
        setStep('code');
        setResendIn(RESEND_DELAY_S);
    }

    async function verifyCode(event: FormEvent) {
        event.preventDefault();
        const token = code.replace(/\s/g, '');
        if (!CODE.test(token)) {
            setError(fr.signIn.codeFormat);
            return;
        }
        setBusy(true);
        setError(null);
        const { error: verifyError } = await supabase().auth.verifyOtp({ email, token, type: 'email' });
        setBusy(false);
        if (verifyError) {
            logEvent('auth_failed', { ...errorFields(verifyError), code: 'otp_verify' });
            setError(fr.signIn.invalidCode);
            return;
        }
        logEvent('auth_code_verified');
        navigate(from, { replace: true });
    }

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{fr.signIn.title}</PageTitle>
            {step === 'email' ? (
                <form onSubmit={sendCode} noValidate className="flex flex-col gap-4">
                    <TextField
                        label={fr.signIn.emailLabel}
                        hint={fr.signIn.emailHint}
                        error={error}
                        type="email"
                        name="email"
                        autoComplete="email"
                        inputMode="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                    />
                    <p className="text-muted">
                        {fr.signIn.accountNotice}{' '}
                        <Link to="/confidentialite" className="text-brand underline">
                            {fr.signIn.privacyLink}
                        </Link>
                        .
                    </p>
                    <Button type="submit" disabled={busy}>
                        {busy ? fr.signIn.sending : fr.signIn.sendCode}
                    </Button>
                </form>
            ) : (
                <form onSubmit={verifyCode} noValidate className="flex flex-col gap-4">
                    <Notice tone="info">{fr.signIn.codeSentTo(email)}</Notice>
                    <TextField
                        label={fr.signIn.codeLabel}
                        error={error}
                        name="code"
                        autoComplete="one-time-code"
                        inputMode="numeric"
                        maxLength={6}
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        required
                    />
                    <Button type="submit" disabled={busy}>
                        {busy ? fr.signIn.verifying : fr.signIn.verify}
                    </Button>
                    <div className="flex flex-col gap-2">
                        {resendIn > 0 ? (
                            <p className="text-muted">{fr.signIn.resendIn(resendIn)}</p>
                        ) : (
                            <Button variant="quiet" onClick={() => void sendCode()} disabled={busy}>
                                {fr.signIn.resend}
                            </Button>
                        )}
                        <Button
                            variant="quiet"
                            onClick={() => {
                                setStep('email');
                                setCode('');
                                setError(null);
                            }}
                        >
                            {fr.signIn.changeEmail}
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}
