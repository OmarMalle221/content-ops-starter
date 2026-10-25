/** Fait télécharger un texte (export JSON, fichier calendrier .ics…), sans passer par un serveur. */
export function downloadText(content: string, filename: string, type: string): void {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/** Fait télécharger un objet en fichier JSON lisible (droit d'accès et portabilité). */
export function downloadJson(data: unknown, filename: string): void {
    downloadText(JSON.stringify(data, null, 2), filename, 'application/json');
}

export function todayStamp(): string {
    return new Date().toISOString().slice(0, 10);
}
