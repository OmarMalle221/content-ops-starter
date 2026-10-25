/** Fait télécharger un objet en fichier JSON lisible (droit d'accès et portabilité). */
export function downloadJson(data: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

export function todayStamp(): string {
    return new Date().toISOString().slice(0, 10);
}
