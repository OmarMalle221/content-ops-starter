import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '../../app/session';
import { Button, Card, Checkbox, Notice, PageTitle, TextField } from '../../components/ui';
import { fr } from '../../i18n/fr';
import { files as tf } from '../../i18n/files.fr';
import { deleteCareFile, exportCareFile, renameCareFile } from '../../lib/careFiles';
import { downloadJson, todayStamp } from '../../lib/download';
import { logEvent } from '../../lib/log';
import { OwnerOnly, useFileContext } from './FileLayout';
import { fileKeys } from './useFile';

/** Paramètres réservés à la personne aidante principale : nom, export, suppression. */
export function FileSettingsPage() {
    return (
        <OwnerOnly>
            <FileSettingsPageContent />
        </OwnerOnly>
    );
}

function FileSettingsPageContent() {
    const { file } = useFileContext();
    const { session } = useSession();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [title, setTitle] = useState(file.title);
    const [renameStatus, setRenameStatus] = useState<'idle' | 'saved' | 'invalid' | 'error'>('idle');
    const [exportStatus, setExportStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
    const [understood, setUnderstood] = useState(false);
    const [deleteStatus, setDeleteStatus] = useState<'idle' | 'busy' | 'error'>('idle');

    async function rename(event: FormEvent) {
        event.preventDefault();
        const trimmed = title.trim();
        if (trimmed.length === 0 || trimmed.length > 80) return setRenameStatus('invalid');
        try {
            await renameCareFile(file.id, trimmed);
            await queryClient.invalidateQueries({ queryKey: fileKeys.file(file.id) });
            await queryClient.invalidateQueries({ queryKey: fileKeys.myFiles(session?.user.id) });
            setRenameStatus('saved');
        } catch {
            setRenameStatus('error');
        }
    }

    async function download() {
        setExportStatus('busy');
        try {
            downloadJson(await exportCareFile(file.id), `relais-dossier-${todayStamp()}.json`);
            logEvent('export_downloaded', { code: 'care_file' });
            setExportStatus('done');
        } catch {
            setExportStatus('error');
        }
    }

    async function remove() {
        setDeleteStatus('busy');
        try {
            await deleteCareFile(file.id);
            queryClient.removeQueries({ queryKey: fileKeys.file(file.id) });
            await queryClient.invalidateQueries({ queryKey: fileKeys.myFiles(session?.user.id) });
            navigate('/accueil', { replace: true, state: { notice: tf.deleted(file.title) } });
        } catch {
            setDeleteStatus('error');
        }
    }

    return (
        <div className="flex flex-col gap-5">
            <PageTitle>{tf.settingsTitle}</PageTitle>

            <Card>
                <form onSubmit={rename} noValidate className="flex flex-col gap-3">
                    <TextField
                        label={tf.renameTitle}
                        maxLength={80}
                        value={title}
                        error={renameStatus === 'invalid' ? tf.titleError : null}
                        onChange={(e) => setTitle(e.target.value)}
                    />
                    {renameStatus === 'saved' && <Notice tone="success">{tf.renamed}</Notice>}
                    {renameStatus === 'error' && <Notice tone="error">{fr.app.genericError}</Notice>}
                    <Button type="submit" variant="secondary">
                        {tf.rename}
                    </Button>
                </form>
            </Card>

            <Card>
                <h2 className="text-xl font-bold">{tf.exportTitle}</h2>
                <p className="mt-2">{tf.exportText}</p>
                <div className="mt-3 flex flex-col gap-3">
                    {exportStatus === 'done' && <Notice tone="success">{tf.exportDone}</Notice>}
                    {exportStatus === 'error' && <Notice tone="error">{fr.app.genericError}</Notice>}
                    <Button variant="secondary" disabled={exportStatus === 'busy'} onClick={() => void download()}>
                        {tf.exportButton}
                    </Button>
                </div>
            </Card>

            <Card className="border-urgent">
                <h2 className="text-xl font-bold text-urgent-strong">{tf.deleteTitle}</h2>
                <p className="mt-2">{tf.deleteText}</p>
                <div className="mt-3 flex flex-col gap-3">
                    <Checkbox label={tf.deleteConfirm} checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                    {deleteStatus === 'error' && <Notice tone="error">{fr.app.genericError}</Notice>}
                    <Button variant="danger" disabled={!understood || deleteStatus === 'busy'} onClick={() => void remove()}>
                        {tf.deleteButton}
                    </Button>
                </div>
            </Card>
        </div>
    );
}
