/** Lien « Créer une tâche » depuis un « à faire » de document ou une démarche : titre proposé et source. */
export function createTaskLink(fileId: string, title: string, origin: { document?: string; demarche?: string }): string {
    const params = new URLSearchParams({ titre: title.slice(0, 160), ...origin });
    return `/dossiers/${fileId}/taches?${params.toString()}`;
}
