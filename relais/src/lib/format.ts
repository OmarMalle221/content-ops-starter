const dateFormatter = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Toronto' });

/** « 26 octobre 2026 ». Accepte une date ISO (« 2026-10-26 ») ou un horodatage. */
export function formatDate(value: string): string {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
    return dateFormatter.format(date);
}

/** Numéro lisible : « 1 866 277-3553 », « 514 555-0123 » ; les numéros courts (911, 811) restent tels quels. */
export function formatPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
        return `1 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)}-${digits.slice(6)}`;
    return phone;
}

/** Valeur d'un lien tel: ou sms: (chiffres et +). */
export function dialable(phone: string): string {
    return phone.replace(/[^\d+]/g, '');
}
